import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { ApiError } from "../errors/api-error";
import { LIVE_RUN_ADMISSION, RUN_EXECUTION_CONFIG } from "../execution/execution.tokens";
import { LIVE_RUN_ACCESS_TOKEN_HEADER } from "../execution/live-run-access";
import type { LiveRunAdmissionController } from "../execution/live-run-admission";
import type { RunExecutionConfig } from "../execution/run-execution-config";

export type LiveAgentRunsCapability = "AVAILABLE" | "UNAVAILABLE";
/**
 * `PUBLIC_TRIAL` (issue #39) is a per-REQUEST access mode when the deployment
 * is configured for both private-token and public-trial access. A caller
 * presenting a valid token always sees `TOKEN_REQUIRED`; a caller presenting
 * no token sees `PUBLIC_TRIAL` when the flag is on and the public advisory
 * gates are open; a caller presenting an invalid token sees `TOKEN_REQUIRED`
 * (never downgraded to PUBLIC). The deployment-level configuration determines
 * which paths EXIST, but it is the caller's own request that determines which
 * one THIS response describes.
 */
export type LiveAccessRequirement = "TOKEN_REQUIRED" | "PUBLIC_TRIAL" | "NOT_APPLICABLE";

/**
 * A discriminated union, not a flat shape with optional fields: PUBLIC_TRIAL
 * is the only variant that carries `visitorRunsRemaining` /
 * `turnstileSiteKey`, and the type system — not a runtime convention — is
 * what keeps a caller from reading either off a TOKEN_REQUIRED or
 * NOT_APPLICABLE response.
 */
export type CapabilitiesResponse =
  | { readonly liveAgentRuns: "UNAVAILABLE"; readonly liveAccess: "NOT_APPLICABLE" }
  | { readonly liveAgentRuns: "AVAILABLE"; readonly liveAccess: "TOKEN_REQUIRED" }
  | {
      readonly liveAgentRuns: "AVAILABLE";
      readonly liveAccess: "PUBLIC_TRIAL";
      /**
       * THIS caller's own remaining trial allowance today — 0 or 1, never a
       * global count. The #19 opacity contract is preserved for everything
       * else: no public/global remaining, no overall remaining, no IP state,
       * no cost headroom, no kill-switch reason, no internal budget reason.
       */
      readonly visitorRunsRemaining: 0 | 1;
      /** The Cloudflare Turnstile site key, served here rather than a duplicated frontend build-time env var. */
      readonly turnstileSiteKey: string;
    };

/**
 * What the browser needs to render the LIVE option honestly, and nothing else.
 *
 * Separate from `/v1/health/ready` on purpose. Readiness answers "is this process
 * and its database working" — a probe Render polls continuously and restarts the
 * container over. Product configuration and budget state are a different
 * question, and putting them on the health check would mean an exhausted daily
 * budget could read as an unhealthy deployment.
 *
 * OPACITY IS THE CONTRACT, EXCEPT FOR THE CALLER'S OWN VISITOR COUNT. Capability
 * absent, kill switch off, no admission path configured, and budget exhausted all
 * render as exactly `UNAVAILABLE`. An anonymous visitor learns that LIVE cannot be
 * started right now and nothing else: not which safeguard is engaged, not the
 * public/global remaining count, not how much of the cost ceiling is used, and
 * not whether a credential exists. Distinguishing them would tell someone probing
 * the deployment precisely which lever to lean on. `visitorRunsRemaining` is the
 * one deliberate exception — the #39 design review's confirmed carve-out — and it
 * describes only the calling visitor, never anyone else's.
 *
 * Computed entirely from local configuration plus one indexed read of the day's
 * budget row (and, in PUBLIC_TRIAL mode, one advisory read of the visitor's own
 * row). No Anthropic status probe, and no paid request — checking whether live
 * runs are available must never itself cost money.
 */
@Controller("capabilities")
export class CapabilitiesController {
  constructor(
    @Inject(RUN_EXECUTION_CONFIG) private readonly config: RunExecutionConfig,
    @Inject(LIVE_RUN_ADMISSION) private readonly admission: LiveRunAdmissionController,
  ) {}

  @Get()
  async getCapabilities(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: CapabilitiesResponse }> {
    /**
     * Whether THIS request carries a valid private token — same per-request
     * precedence the admission controller already uses. A valid token means the
     * private path; its absence MAY mean the public path (when the dual-mode
     * flag is on); an invalid token is never downgraded to public.
     */
    const isPrivateCaller =
      this.config.liveRunAccess.kind === "token-required" &&
      this.config.liveRunAccess.verify(request.header(LIVE_RUN_ACCESS_TOKEN_HEADER));

    const available = await this.admission.isAvailable(
      // Only check the PUBLIC sub-ceilings when evaluating for the PUBLIC path.
      // Private callers are unaffected by public-quota exhaustion.
      !isPrivateCaller && this.config.livePublicTrial.enabled,
    );

    if (!available) {
      // NOT_APPLICABLE: there is no access requirement to describe for
      // something that cannot be started, and reporting TOKEN_REQUIRED or
      // PUBLIC_TRIAL anyway would leak which admission path IS configured on
      // a deployment whose kill switch is off.
      return { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } };
    }

    if (isPrivateCaller) {
      return { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } };
    }

    // A caller who explicitly presented a token (even an invalid one) on a
    // dual-mode deployment — never downgrade to PUBLIC_TRIAL.
    if (
      this.config.liveRunAccess.kind === "token-required" &&
      request.header(LIVE_RUN_ACCESS_TOKEN_HEADER) !== undefined
    ) {
      return { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } };
    }

    // Token-only deployment (no PUBLIC trial flag) — every caller sees
    // TOKEN_REQUIRED, exactly as before #39. A dual-mode deployment (token
    // + public flag) skips this branch: anonymous callers fall through to
    // PUBLIC_TRIAL below, and token-presenting callers were already handled
    // above (isPrivateCaller or the invalid-token guard).
    if (this.config.liveRunAccess.kind === "token-required" && !this.config.livePublicTrial.enabled) {
      return { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } };
    }

    // available && liveRunAccess.kind !== "token-required" ⇒ PUBLIC_TRIAL,
    // by isAvailable's own invariant (see live-run-admission.ts). Guarded
    // defensively rather than trusted blindly.
    if (!this.config.livePublicTrial.enabled) {
      throw new ApiError("INTERNAL_ERROR");
    }

    const visitorRunsRemaining = await this.admission.getVisitorRunsRemaining(request);
    // Visitor-specific from here down — never shared or cached across
    // visitors, and never cached by an intermediary either.
    res.setHeader("Cache-Control", "private, no-store");

    return {
      data: {
        liveAgentRuns: "AVAILABLE",
        liveAccess: "PUBLIC_TRIAL",
        visitorRunsRemaining,
        turnstileSiteKey: this.config.livePublicTrial.turnstileSiteKey,
      },
    };
  }
}
