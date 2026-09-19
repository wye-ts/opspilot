import { describe, expect, it, vi } from "vitest";
import opspilotAgentRuntime from "@opspilot/agent-runtime";

import {
  LIVE_RUN_MAX_RETRIES,
  MAX_RUN_COUNT,
  isProviderOutage,
  parseRunCount,
} from "./measure-completion-rate";

const { LlmProviderError } = opspilotAgentRuntime;

/**
 * Guards on the completion-rate measurement's own integrity. Both defects
 * these cover were found in review, and both share a shape: they would have
 * corrupted the measured number rather than failing, which is the worst
 * outcome for an artifact whose entire job is to report a trustworthy rate.
 */
describe("parseRunCount", () => {
  it("defaults to 5 when unset or blank", () => {
    expect(parseRunCount(undefined)).toBe(5);
    expect(parseRunCount("   ")).toBe(5);
  });

  it("accepts an integer inside the ceiling", () => {
    expect(parseRunCount("1")).toBe(1);
    expect(parseRunCount(String(MAX_RUN_COUNT))).toBe(MAX_RUN_COUNT);
  });

  // The dangerous cases: each would have made the loop run zero times and
  // print "0/0 COMPLETED" — a clean success that measured nothing at all.
  it.each(["0", "-1", "abc", "2.5", "", "NaN"])(
    "rejects %o rather than silently measuring nothing",
    (raw) => {
      if (raw === "") {
        expect(parseRunCount(raw)).toBe(5);
        return;
      }
      expect(() => parseRunCount(raw)).toThrow(/RUN_COUNT/);
    },
  );

  it("rejects a value above the billing ceiling", () => {
    expect(() => parseRunCount(String(MAX_RUN_COUNT + 1))).toThrow(/RUN_COUNT/);
  });
});

describe("isProviderOutage", () => {
  // Genuinely transient upstream problems a deployed run could also hit.
  it.each(["RATE_LIMIT", "CONNECTION", "TIMEOUT", "SERVER_ERROR"] as const)(
    "records %s as a real outage",
    (category) => {
      // NB: PROVIDER_UNAVAILABLE is the ORCHESTRATOR's failure code, a
      // different layer from LlmProviderErrorCategory.
      expect(isProviderOutage(new LlmProviderError(category, "upstream problem"))).toBe(true);
    },
  );

  // Our own configuration or code — counting these would let a broken setup
  // masquerade as a measured completion-rate sample.
  it.each(["AUTHENTICATION", "BILLING", "REQUEST_INVALID", "CANCELLED", "UNKNOWN"] as const)(
    "voids the measurement on %s rather than recording it",
    (category) => {
      expect(isProviderOutage(new LlmProviderError(category, "our problem"))).toBe(false);
    },
  );

  // A plain Error is a defect in this repo. Counting it as a provider-side
  // failure would let a crash pass as an ordinary outage, so a
  // four-completion/one-crash run could still read as meeting the
  // at-most-one-failure threshold.
  it.each([new Error("undefined is not a function"), new TypeError("boom"), "string throw", null])(
    "refuses to classify %o as an outage",
    (thrown) => {
      expect(isProviderOutage(thrown)).toBe(false);
    },
  );
});

describe("LIVE_RUN_MAX_RETRIES", () => {
  // Two successive versions of this script were MORE PERMISSIVE than the path
  // they claimed to measure (maxRetries 2, then the non-LIVE default of 1).
  // apps/api/src/execution/run-execution-config.ts refuses to boot unless
  // ANTHROPIC_MAX_RETRIES === 0 while LIVE runs are enabled, so a deployed LIVE
  // run always gets exactly one provider attempt.
  it("pins zero retries, matching what the deployed LIVE path enforces at boot", () => {
    expect(LIVE_RUN_MAX_RETRIES).toBe(0);
  });

  it("is not driven by the ambient environment", async () => {
    // A measurement that silently loosens itself via an env var would
    // reintroduce exactly the defect this constant exists to prevent.
    // vi.resetModules() forces a genuine re-evaluation of the module body,
    // which is what would pick up process.env if the constant were derived
    // from it. (A `?query` import suffix works in vitest but does not
    // typecheck, so this uses the supported mechanism.)
    const previous = process.env.ANTHROPIC_MAX_RETRIES;
    process.env.ANTHROPIC_MAX_RETRIES = "5";
    try {
      vi.resetModules();
      const reimported = await import("./measure-completion-rate");
      expect(reimported.LIVE_RUN_MAX_RETRIES).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
      else process.env.ANTHROPIC_MAX_RETRIES = previous;
      vi.resetModules();
    }
  });
});
