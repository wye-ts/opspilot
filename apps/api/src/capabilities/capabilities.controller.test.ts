import { describe, expect, it } from "vitest";

import { createLiveRunAdmissionController } from "../execution/live-run-admission";
import { parseRunExecutionConfig, type RunExecutionConfig } from "../execution/run-execution-config";
import { CapabilitiesController } from "./capabilities.controller";

const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";
const SECRET = "sk-ant-test-do-not-use-0123456789";

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

function buildController(config: RunExecutionConfig, isBudgetOpen: () => Promise<boolean> = async () => true) {
  return new CapabilitiesController(
    config,
    createLiveRunAdmissionController({ config, isBudgetOpen }),
  );
}

describe("CapabilitiesController", () => {
  it("reports AVAILABLE and TOKEN_REQUIRED when live runs can actually be served", async () => {
    const result = await buildController(servableConfig()).getCapabilities();

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
      const result = await buildController(config, async () => budgetOpen).getCapabilities();

      expect(result).toEqual({
        data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" },
      });
    });

    it("produces byte-identical bodies for every unavailable reason", async () => {
      const bodies = await Promise.all([
        buildController(parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" })).getCapabilities(),
        buildController(
          parseRunExecutionConfig({ ANTHROPIC_API_KEY: SECRET, ANTHROPIC_MODEL: "claude-sonnet-5" }),
        ).getCapabilities(),
        buildController(servableConfig(), async () => false).getCapabilities(),
      ]);

      const serialized = bodies.map((body) => JSON.stringify(body));
      expect(new Set(serialized).size).toBe(1);
    });

    it("does not report TOKEN_REQUIRED while unavailable, which would leak that a token is configured", async () => {
      const result = await buildController(servableConfig(), async () => false).getCapabilities();

      expect(result.data.liveAccess).toBe("NOT_APPLICABLE");
    });
  });

  describe("what the body never contains", () => {
    it("exposes exactly two fields and no budget figures, counts, or config details", async () => {
      const result = await buildController(servableConfig()).getCapabilities();

      expect(Object.keys(result.data).sort()).toEqual(["liveAccess", "liveAgentRuns"]);
    });

    it("never contains a credential, a token, a count, or a cost", async () => {
      const serialized = JSON.stringify(await buildController(servableConfig()).getCapabilities());

      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(DEMO_TOKEN);
      expect(serialized).not.toMatch(/runsReserved|runsCompleted|dailyLimit|nanoUsd|ceiling/i);
      // No digits at all: any number here would be a count or a limit.
      expect(serialized).not.toMatch(/\d/);
    });

    it("never advertises a PUBLIC access mode", async () => {
      // There is no tokenless public LIVE in this release, and the endpoint must
      // not imply one exists.
      for (const budgetOpen of [true, false]) {
        const serialized = JSON.stringify(
          await buildController(servableConfig(), async () => budgetOpen).getCapabilities(),
        );
        expect(serialized).not.toContain("PUBLIC");
      }
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

    await controller.getCapabilities();

    expect(budgetChecks).toBe(1);
  });

  it("re-evaluates on each call rather than caching a stale answer", async () => {
    let open = true;
    const controller = buildController(servableConfig(), async () => open);

    expect((await controller.getCapabilities()).data.liveAgentRuns).toBe("AVAILABLE");
    open = false;
    expect((await controller.getCapabilities()).data.liveAgentRuns).toBe("UNAVAILABLE");
  });
});
