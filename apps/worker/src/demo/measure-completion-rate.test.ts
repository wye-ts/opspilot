import { describe, expect, it } from "vitest";
import opspilotAgentRuntime from "@opspilot/agent-runtime";

import { MAX_RUN_COUNT, isProviderOutage, parseRunCount } from "./measure-completion-rate";

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
  it("treats a real provider error as a recordable outage", () => {
    // A real category from LlmProviderErrorCategory — PROVIDER_UNAVAILABLE is
    // the ORCHESTRATOR's failure code, a different layer.
    const error = new LlmProviderError("SERVER_ERROR", "upstream is down");
    expect(isProviderOutage(error)).toBe(true);
  });

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
