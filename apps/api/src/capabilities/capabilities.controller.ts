import { Controller, Get, Inject } from "@nestjs/common";

import { LIVE_RUN_ADMISSION, RUN_EXECUTION_CONFIG } from "../execution/execution.tokens";
import type { LiveRunAdmissionController } from "../execution/live-run-admission";
import type { RunExecutionConfig } from "../execution/run-execution-config";

export type LiveAgentRunsCapability = "AVAILABLE" | "UNAVAILABLE";
/**
 * `PUBLIC` is deliberately absent from this union.
 *
 * It is not merely unset — there is no tokenless public LIVE mode in this
 * release, and startup fails rather than producing one (see parseLiveRunAccess).
 * Leaving the value out of the type means the endpoint cannot advertise a mode
 * the server cannot serve.
 */
export type LiveAccessRequirement = "TOKEN_REQUIRED" | "NOT_APPLICABLE";

export interface CapabilitiesResponse {
  readonly liveAgentRuns: LiveAgentRunsCapability;
  readonly liveAccess: LiveAccessRequirement;
}

/**
 * What the browser needs to render the LIVE option honestly, and nothing else.
 *
 * Separate from `/v1/health/ready` on purpose. Readiness answers "is this process
 * and its database working" — a probe Render polls continuously and restarts the
 * container over. Product configuration and budget state are a different
 * question, and putting them on the health check would mean an exhausted daily
 * budget could read as an unhealthy deployment.
 *
 * OPACITY IS THE CONTRACT. Capability absent, kill switch off, no token
 * configured, and budget exhausted all render as exactly `UNAVAILABLE`. An
 * anonymous visitor learns that LIVE cannot be started right now and nothing
 * else: not which safeguard is engaged, not how many runs remain, not how much of
 * the cost ceiling is used, and not whether a credential exists. Distinguishing
 * them would tell someone probing the deployment precisely which lever to lean
 * on.
 *
 * Computed entirely from local configuration plus one indexed read of the day's
 * budget row. No Anthropic status probe, and no paid request — checking whether
 * live runs are available must never itself cost money.
 */
@Controller("capabilities")
export class CapabilitiesController {
  constructor(
    @Inject(RUN_EXECUTION_CONFIG) private readonly config: RunExecutionConfig,
    @Inject(LIVE_RUN_ADMISSION) private readonly admission: LiveRunAdmissionController,
  ) {}

  @Get()
  async getCapabilities(): Promise<{ data: CapabilitiesResponse }> {
    const available = await this.admission.isAvailable();

    return {
      data: {
        liveAgentRuns: available ? "AVAILABLE" : "UNAVAILABLE",
        // NOT_APPLICABLE whenever LIVE is unavailable: there is no access
        // requirement to describe for something that cannot be started, and
        // reporting TOKEN_REQUIRED anyway would leak that a token IS configured
        // on a deployment whose kill switch is off.
        liveAccess:
          available && this.config.liveRunAccess.kind === "token-required"
            ? "TOKEN_REQUIRED"
            : "NOT_APPLICABLE",
      },
    };
  }
}
