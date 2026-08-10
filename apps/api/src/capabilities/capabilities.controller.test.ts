import type { LiveRunBudgetReservationInput } from "@opspilot/database";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { createLiveRunAdmissionController } from "../execution/live-run-admission";
import { LIVE_RUN_ACCESS_TOKEN_HEADER } from "../execution/live-run-access";
import { parseRunExecutionConfig, type RunExecutionConfig } from "../execution/run-execution-config";
import { createTurnstileVerifier } from "../execution/turnstile-verifier";
import { createVisitorIdentity } from "../execution/visitor-identity";
import { CapabilitiesController } from "./capabilities.controller";

const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";
const SECRET = "sk-ant-test-do-not-use-0123456789";
const VISITOR_SECRET = "visitor-secret-do-not-use-9f14e45fceea";
const TURNSTILE_SECRET = "turnstile-secret-do-not-use-1f14e45fceea";
const TURNSTILE_SITE_KEY = "turnstile-site-key-do-not-use";

function servableConfig(overrides: Record<string, string> = {}): RunExecutionConfig {
  return parseRunExecutionConfig({
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    LIVE_AGENT_RUNS_ENABLED: "true",
    LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
    // Required once LIVE is servable — see run-execution-config.ts.
    ANTHROPIC_MAX_RETRIES: "0",
    ...overrides,
  });
}

function publicTrialConfig(overrides: Record<string, string> = {}): RunExecutionConfig {
  return parseRunExecutionConfig({
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    LIVE_AGENT_RUNS_ENABLED: "true",
    ANTHROPIC_MAX_RETRIES: "0",
    LIVE_PUBLIC_TRIAL_ENABLED: "true",
    TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    TURNSTILE_SITE_KEY,
    LIVE_PUBLIC_TRIAL_VISITOR_SECRET: VISITOR_SECRET,
    ...overrides,
  });
}

function fakeRequest(cookie?: string): Request {
  return {
    ip: "203.0.113.7",
    header: () => undefined,
    headers: cookie !== undefined ? { cookie } : {},
  } as unknown as Request;
}

/** A real signed visitor cookie value for VISITOR_SECRET, via the same module the production code uses. */
function signedVisitorCookieHeader(visitorId: string): string {
  let cookieHeader = "";
  const capturingRes = {
    cookie: (name: string, value: string) => {
      cookieHeader = `${name}=${value}`;
    },
  } as unknown as Response;
  createVisitorIdentity(VISITOR_SECRET).setVisitorCookie(capturingRes, visitorId);
  return cookieHeader;
}

function fakeResponse(): Response {
  const headers: Record<string, string> = {};
  return {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    cookie: () => undefined,
    // Exposed for assertions.
    __headers: headers,
  } as unknown as Response;
}

function buildController(
  config: RunExecutionConfig,
  isBudgetOpen: (budget: LiveRunBudgetReservationInput) => Promise<boolean> = async () => true,
  isVisitorTrialAvailable: (visitorId: string, budgetDate: string) => Promise<boolean> = async () => true,
) {
  return new CapabilitiesController(
    config,
    createLiveRunAdmissionController({
      config,
      isBudgetOpen,
      isVisitorTrialAvailable,
      ...(config.livePublicTrial.enabled
        ? {
            turnstileVerifier: createTurnstileVerifier(config.livePublicTrial.turnstileSecretKey),
            visitorIdentity: createVisitorIdentity(config.livePublicTrial.visitorSecret),
          }
        : {}),
    }),
  );
}

describe("CapabilitiesController", () => {
  it("reports AVAILABLE and TOKEN_REQUIRED when live runs can actually be served", async () => {
    const result = await buildController(servableConfig()).getCapabilities(fakeRequest(), fakeResponse());

    expect(result).toEqual({ data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
  });

  /**
   * The opacity contract. Every unavailable reason renders identically, so an
   * anonymous visitor learns that LIVE cannot be started and nothing else — not
   * which safeguard is engaged, and not how much headroom remains.
   */
  describe("opacity", () => {
    it.each([
      ["capability absent", parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" }), true],
      ["kill switch off", parseRunExecutionConfig({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_MODEL: "claude-sonnet-5" }), true],
      ["budget exhausted", servableConfig(), false],
    ])("reports UNAVAILABLE / NOT_APPLICABLE when %s", async (_label, config, budgetOpen) => {
      const result = await buildController(config, async () => budgetOpen).getCapabilities(
        fakeRequest(),
        fakeResponse(),
      );

      expect(result).toEqual({
        data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" },
      });
    });

    it("produces byte-identical bodies for every unavailable reason", async () => {
      const bodies = await Promise.all([
        buildController(parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" })).getCapabilities(
          fakeRequest(),
          fakeResponse(),
        ),
        buildController(
          parseRunExecutionConfig({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_MODEL: "claude-sonnet-5" }),
        ).getCapabilities(fakeRequest(), fakeResponse()),
        buildController(servableConfig(), async () => false).getCapabilities(fakeRequest(), fakeResponse()),
      ]);

      const serialized = bodies.map((body) => JSON.stringify(body));
      expect(new Set(serialized).size).toBe(1);
    });

    it("does not report TOKEN_REQUIRED while unavailable, which would leak that a token is configured", async () => {
      const result = await buildController(servableConfig(), async () => false).getCapabilities(
        fakeRequest(),
        fakeResponse(),
      );

      expect(result.data.liveAccess).toBe("NOT_APPLICABLE");
    });
  });

  describe("what the TOKEN_REQUIRED body never contains", () => {
    it("exposes exactly two fields and no budget figures, counts, or config details", async () => {
      const result = await buildController(servableConfig()).getCapabilities(fakeRequest(), fakeResponse());

      expect(Object.keys(result.data).sort()).toEqual(["liveAccess", "liveAgentRuns"]);
    });

    it("never contains a credential, a token, a count, or a cost", async () => {
      const serialized = JSON.stringify(
        await buildController(servableConfig()).getCapabilities(fakeRequest(), fakeResponse()),
      );

      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(DEMO_TOKEN);
      expect(serialized).not.toMatch(/runsReserved|runsCompleted|dailyLimit|nanoUsd|ceiling/i);
      // No digits at all: any number here would be a count or a limit.
      expect(serialized).not.toMatch(/\d/);
    });

    it("never advertises PUBLIC_TRIAL on a token-only deployment", async () => {
      for (const budgetOpen of [true, false]) {
        const serialized = JSON.stringify(
          await buildController(servableConfig(), async () => budgetOpen).getCapabilities(
            fakeRequest(),
            fakeResponse(),
          ),
        );
        expect(serialized).not.toContain("PUBLIC_TRIAL");
      }
    });
  });

  describe("PUBLIC_TRIAL mode (issue #39)", () => {
    it("reports AVAILABLE, PUBLIC_TRIAL, visitorRunsRemaining, and the Turnstile site key", async () => {
      const result = await buildController(publicTrialConfig()).getCapabilities(fakeRequest(), fakeResponse());

      expect(result).toEqual({
        data: {
          liveAgentRuns: "AVAILABLE",
          liveAccess: "PUBLIC_TRIAL",
          visitorRunsRemaining: 1,
          turnstileSiteKey: TURNSTILE_SITE_KEY,
        },
      });
    });

    it("reports visitorRunsRemaining 0 once this visitor's row exists", async () => {
      const cookie = signedVisitorCookieHeader("11111111-1111-4111-8111-111111111111");
      const result = await buildController(publicTrialConfig(), async () => true, async () => false).getCapabilities(
        fakeRequest(cookie),
        fakeResponse(),
      );

      expect(result.data).toMatchObject({ visitorRunsRemaining: 0 });
    });

    it("reports visitorRunsRemaining 1 for a returning visitor who hasn't used today's trial", async () => {
      const cookie = signedVisitorCookieHeader("22222222-2222-4222-8222-222222222222");
      const result = await buildController(publicTrialConfig(), async () => true, async () => true).getCapabilities(
        fakeRequest(cookie),
        fakeResponse(),
      );

      expect(result.data).toMatchObject({ visitorRunsRemaining: 1 });
    });

    it("treats a tampered cookie as absent — a new visitor, not an error", async () => {
      const cookie = signedVisitorCookieHeader("33333333-3333-4333-8333-333333333333").replace(
        /\.[0-9a-f]+$/,
        ".0000000000000000000000000000000000000000000000000000000000000000",
      );
      let reads = 0;
      const result = await buildController(publicTrialConfig(), async () => true, async () => {
        reads += 1;
        return false;
      }).getCapabilities(fakeRequest(cookie), fakeResponse());

      expect(result.data).toMatchObject({ visitorRunsRemaining: 1 });
      expect(reads).toBe(0);
    });

    it("treats a caller with no cookie as a new visitor without any database read", async () => {
      let reads = 0;
      const controller = buildController(publicTrialConfig(), async () => true, async () => {
        reads += 1;
        return true;
      });

      const result = await controller.getCapabilities(fakeRequest(), fakeResponse());

      expect(result.data).toMatchObject({ visitorRunsRemaining: 1 });
      expect(reads).toBe(0);
    });

    it("sets Cache-Control: private, no-store on the visitor-specific response", async () => {
      const res = fakeResponse();
      await buildController(publicTrialConfig()).getCapabilities(fakeRequest(), res);

      expect((res as unknown as { __headers: Record<string, string> }).__headers["Cache-Control"]).toBe(
        "private, no-store",
      );
    });

    it("never leaks the Turnstile secret key or the visitor secret", async () => {
      const serialized = JSON.stringify(
        await buildController(publicTrialConfig()).getCapabilities(fakeRequest(), fakeResponse()),
      );

      expect(serialized).not.toContain(TURNSTILE_SECRET);
      expect(serialized).not.toContain(VISITOR_SECRET);
    });
  });

  it("makes no provider probe and no paid request", async () => {
    // Computed purely from local configuration plus one budget read. The proof
    // is structural: the controller's only collaborators are the config and the
    // admission controller, whose sole async dependency is isBudgetOpen.
    let budgetChecks = 0;
    const controller = buildController(servableConfig(), async () => {
      budgetChecks += 1;
      return true;
    });

    await controller.getCapabilities(fakeRequest(), fakeResponse());

    expect(budgetChecks).toBe(1);
  });

  describe("dual-mode deployment (token + PUBLIC trial both configured)", () => {
    const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";

    function dualModeConfig(): RunExecutionConfig {
      return parseRunExecutionConfig({
        ANTHROPIC_API_KEY: SECRET,
        ANTHROPIC_MODEL: "claude-sonnet-5",
        LIVE_AGENT_RUNS_ENABLED: "true",
        ANTHROPIC_MAX_RETRIES: "0",
        LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
        LIVE_PUBLIC_TRIAL_ENABLED: "true",
        TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
        TURNSTILE_SITE_KEY,
        LIVE_PUBLIC_TRIAL_VISITOR_SECRET: VISITOR_SECRET,
      });
    }

    function dualRequest(token?: string): Request {
      return {
        ip: "203.0.113.7",
        header: (name: string) =>
          name.toLowerCase() === LIVE_RUN_ACCESS_TOKEN_HEADER ? token : undefined,
        headers: {},
      } as unknown as Request;
    }

    it("A. anonymous caller on a dual-mode deployment sees PUBLIC_TRIAL with usable fields", async () => {
      const controller = buildController(dualModeConfig(), async () => true, async () => true);
      const result = await controller.getCapabilities(fakeRequest(), fakeResponse());

      expect(result.data).toEqual({
        liveAgentRuns: "AVAILABLE",
        liveAccess: "PUBLIC_TRIAL",
        visitorRunsRemaining: 1,
        turnstileSiteKey: TURNSTILE_SITE_KEY,
      });
    });

    it("B. valid private-token caller on the same deployment sees TOKEN_REQUIRED", async () => {
      const controller = buildController(dualModeConfig(), async () => true, async () => true);
      const result = await controller.getCapabilities(dualRequest(DEMO_TOKEN), fakeResponse());

      expect(result.data).toEqual({
        liveAgentRuns: "AVAILABLE",
        liveAccess: "TOKEN_REQUIRED",
      });
    });

    it("C. PUBLIC sub-budget exhausted does not make the private path unavailable", async () => {
      // isBudgetOpen returns false only when public sub-budget is checked,
      // true otherwise — simulating an exhausted public gate while the overall
      // budget is still open.
      let capturedPublicTrial: boolean | undefined;
      const isBudgetOpen = async (budget: LiveRunBudgetReservationInput) => {
        // Only fail when the public sub-ceilings are being checked.
        return budget.publicDailyLimit === undefined;
      };

      // Anonymous → evaluates PUBLIC path, which is exhausted.
      const anonController = buildController(dualModeConfig(), isBudgetOpen, async () => true);
      const anonResult = await anonController.getCapabilities(fakeRequest(), fakeResponse());
      expect(anonResult.data).toEqual({
        liveAgentRuns: "UNAVAILABLE",
        liveAccess: "NOT_APPLICABLE",
      });

      // Valid private token → evaluates PRIVATE path, which is still open.
      const privateController = buildController(dualModeConfig(), isBudgetOpen, async () => true);
      const privateResult = await privateController.getCapabilities(dualRequest(DEMO_TOKEN), fakeResponse());
      expect(privateResult.data).toEqual({
        liveAgentRuns: "AVAILABLE",
        liveAccess: "TOKEN_REQUIRED",
      });
    });

    it("D. invalid presented private token is never downgraded to PUBLIC", async () => {
      const controller = buildController(dualModeConfig(), async () => true, async () => true);
      const result = await controller.getCapabilities(dualRequest("wrong-token"), fakeResponse());

      // The caller presented a token — they stay on the private path.
      expect(result.data).toEqual({
        liveAgentRuns: "AVAILABLE",
        liveAccess: "TOKEN_REQUIRED",
      });
    });
  });

  it("re-evaluates on each call rather than caching a stale answer", async () => {
    let open = true;
    const controller = buildController(servableConfig(), async () => open);

    expect((await controller.getCapabilities(fakeRequest(), fakeResponse())).data.liveAgentRuns).toBe("AVAILABLE");
    open = false;
    expect((await controller.getCapabilities(fakeRequest(), fakeResponse())).data.liveAgentRuns).toBe("UNAVAILABLE");
  });
});
