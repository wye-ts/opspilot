import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import opspilotAgentRuntime from "@opspilot/agent-runtime";

import {
  NON_REPORT_BEARING_CODES,
  LIVE_RUN_RATE_LIMIT,
  MIN_RUN_INTERVAL_MS,
  LIVE_RUN_MAX_RETRIES,
  LIVE_RUN_OUTPUT_BUDGET_DEFAULTS,
  LIVE_RUN_PROVIDER_DEADLINE_DEFAULT_MS,
  resolveOutputBudget,
  resolveProviderDeadlineMs,
  MAX_RUN_COUNT,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MeasurementConfigurationError,
  isProviderOutage,
  parseBoundedEnvInteger,
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

describe("deployed LIVE parity", () => {
  // agent-runtime defaults to 4096/4096 — MORE generous than deployment on
  // both turns — so omitting outputBudget lets the model produce a report the
  // deployed path would have truncated.
  it("uses the deployed output ceilings, not agent-runtime's defaults", () => {
    const budget = resolveOutputBudget({});
    expect(budget.investigationMaxOutputTokens).toBe(1024);
    expect(budget.finalizationMaxOutputTokens).toBe(3072);
    expect(budget).toEqual({ ...LIVE_RUN_OUTPUT_BUDGET_DEFAULTS });
  });

  // Deployment honours these overrides; hardcoding the defaults meant a report
  // needing 2500 tokens completed here and truncated in production.
  it("honours the same overrides apps/api reads", () => {
    expect(
      resolveOutputBudget({ LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS: "2048" })
        .finalizationMaxOutputTokens,
    ).toBe(2048);
    expect(
      resolveOutputBudget({ LIVE_RUN_MAX_OUTPUT_TOKENS: "512" }).investigationMaxOutputTokens,
    ).toBe(512);
    expect(resolveProviderDeadlineMs({ AGENT_RUN_PROVIDER_DEADLINE_MS: "5000" })).toBe(5000);
  });

  // Production's default finalization ceiling is max(3072, investigation), so
  // raising investigation alone raises finalization with it. A flat 3072 made
  // the measurement STRICTER than deployment — the one apparatus defect in
  // this file that erred in the unfavourable direction.
  it("tracks production's max(3072, investigation) default", () => {
    expect(
      resolveOutputBudget({ LIVE_RUN_MAX_OUTPUT_TOKENS: "4096" }).finalizationMaxOutputTokens,
    ).toBe(4096);
    expect(
      resolveOutputBudget({ LIVE_RUN_MAX_OUTPUT_TOKENS: "512" }).finalizationMaxOutputTokens,
    ).toBe(3072);
  });

  it("refuses a finalization ceiling below investigation, as production does", () => {
    expect(() =>
      resolveOutputBudget({
        LIVE_RUN_MAX_OUTPUT_TOKENS: "4096",
        LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS: "1024",
      }),
    ).toThrow(/must be greater than or equal to/);
  });

  it("uses production's 5000ms deadline floor, not a looser one", () => {
    expect(() => resolveProviderDeadlineMs({ AGENT_RUN_PROVIDER_DEADLINE_MS: "1000" })).toThrow(
      /AGENT_RUN_PROVIDER_DEADLINE_MS/,
    );
    expect(resolveProviderDeadlineMs({ AGENT_RUN_PROVIDER_DEADLINE_MS: "5000" })).toBe(5000);
  });

  it("rejects an override outside the production range", () => {
    expect(() => resolveProviderDeadlineMs({ AGENT_RUN_PROVIDER_DEADLINE_MS: "0" })).toThrow(
      /AGENT_RUN_PROVIDER_DEADLINE_MS/,
    );
  });

  // A per-CALL timeout does not reproduce this: three 41s turns each clear a
  // 45s call timeout while busting a shared 120s run budget.
  it("carries the deployed per-run provider deadline", () => {
    expect(resolveProviderDeadlineMs({})).toBe(120_000);
    expect(LIVE_RUN_PROVIDER_DEADLINE_DEFAULT_MS).toBe(120_000);
  });
});

describe("parseBoundedEnvInteger", () => {
  it("falls back when unset or blank", () => {
    expect(parseBoundedEnvInteger(undefined, 45_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "T")).toBe(45_000);
    expect(parseBoundedEnvInteger("  ", 45_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "T")).toBe(45_000);
  });

  it("accepts a value inside the production bounds", () => {
    expect(parseBoundedEnvInteger("30000", 45_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "T")).toBe(30_000);
  });

  // ANTHROPIC_TIMEOUT_MS=0 disables the SDK timeout entirely; production
  // enforces a 1000ms floor. A non-numeric seed becomes NaN, which the PRNG
  // coerces to 0 and the artefact serialises as null — a silently
  // non-reproducible round.
  it.each(["0", "-1", "abc", "1.5", "600001", "NaN"])(
    "rejects %o rather than running with it",
    (raw) => {
      expect(() =>
        parseBoundedEnvInteger(raw, 45_000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "ANTHROPIC_TIMEOUT_MS"),
      ).toThrow(/ANTHROPIC_TIMEOUT_MS/);
    },
  );

  it("names the offending variable so the failure is actionable", () => {
    expect(() => parseBoundedEnvInteger("abc", 1, 0, 10, "TICKET_SEED")).toThrow(/TICKET_SEED/);
  });
});

describe("configuration errors are actionable without leaking secrets", () => {
  // The handler refuses to print caught error values because a provider error
  // can carry request bodies, headers or an API key. These messages are
  // authored here from a variable NAME and numeric bounds, never from the
  // environment value or the network, so they are safe to surface.
  it("uses a dedicated class the handler can safely print", () => {
    const error = (() => {
      try {
        parseBoundedEnvInteger("abc", 1, 0, 10, "TICKET_SEED");
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MeasurementConfigurationError);
  });

  it("never interpolates the offending VALUE into the message", () => {
    expect(() => parseBoundedEnvInteger("sk-ant-secret", 1, 0, 10, "TICKET_SEED")).toThrow(
      /^TICKET_SEED must be an integer in 0\.\.10$/,
    );
  });

  it("applies to RUN_COUNT too", () => {
    expect(() => parseRunCount("0")).toThrow(MeasurementConfigurationError);
  });
});

describe("exclusion codes are not named as provider faults", () => {
  // Issue #123: PROVIDER_UNAVAILABLE collapses AUTHENTICATION, BILLING and
  // REQUEST_INVALID together with real outages, and a timeout may be our own
  // deadline. This investigation already reported a spend-limit rejection as
  // an upstream outage once. The set is sound for "did not reach a report"
  // and unsound as a claim about fault.
  it("covers the three codes that mean no report was produced", () => {
    expect([...NON_REPORT_BEARING_CODES].sort()).toEqual([
      "PROVIDER_CANCELLED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
    ]);
  });
});

describe("request pacing matches the deployed rate", () => {
  // A 15-run round fired in 85 seconds — about ten times the deployed rate —
  // and 11 runs never reached the model. A visitor cannot produce that burst,
  // so the round measured a request pattern deployment does not permit.
  it("mirrors LIVE_RUN_DEFAULTS' rate limit", () => {
    expect(LIVE_RUN_RATE_LIMIT).toEqual({ max: 2, windowMs: 60_000 });
  });

  it("derives a 30s minimum interval from it", () => {
    expect(MIN_RUN_INTERVAL_MS).toBe(30_000);
  });

  it("keeps the interval consistent with the rate", () => {
    expect(MIN_RUN_INTERVAL_MS).toBe(LIVE_RUN_RATE_LIMIT.windowMs / LIVE_RUN_RATE_LIMIT.max);
  });
});

describe("provider errors are diagnosable from the artefact", () => {
  // A round where 11 of 15 runs failed recorded only PROVIDER_UNAVAILABLE,
  // which collapses six categories (issue #123). Three separate probes were
  // needed to investigate, all written after the fact, none of which
  // reproduced the failure. The adapter had the answer in its log channel the
  // whole time; the measurement configured no logger.
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "measure-completion-rate.ts"),
    "utf8",
  );

  it("attaches a logger to the provider", () => {
    expect(SOURCE).toMatch(/logger:\s*\(event\)\s*=>/);
  });

  it("captures the four fields that classify an UNKNOWN failure", () => {
    for (const field of [
      "errorSource",
      "terminalErrorCategory",
      "errorClass",
      "errorStatus",
    ]) {
      expect(SOURCE).toContain(field);
    }
  });

  it("persists the records rather than only printing them", () => {
    expect(SOURCE).toMatch(/providerErrors,/);
  });

  // The adapter deliberately never logs error.message, because an APIError's
  // text can embed the raw provider response body. Persisting it here would
  // defeat that choice.
  it("never records the exception message", () => {
    const loggerBlock = SOURCE.slice(
      SOURCE.indexOf("logger: (event)"),
      SOURCE.indexOf("providerErrors.push(record)"),
    );
    expect(loggerBlock).not.toMatch(/event\.message|errorMessage/);
  });
});

describe("the measurement survives a destroyed HTTP/2 session", () => {
  // Issue #125: one TLS fault destroys the SDK's HTTP/2 session, after which
  // every request on that client fails in ~1ms forever. Two rounds each lost
  // 11 of 15 runs to it. Reusing the client would make a round's result depend
  // on whether a transient fault landed inside it.
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "measure-completion-rate.ts"),
    "utf8",
  );

  it("builds the client through a factory rather than once", () => {
    expect(SOURCE).toMatch(/const buildClient = \(\): Anthropic =>/);
    expect(SOURCE).toMatch(/let anthropicClient = buildClient\(\)/);
  });

  it("detects the connection-class failure by errorClass", () => {
    expect(SOURCE).toContain('record.errorClass === "APIConnectionError"');
  });

  it("rebuilds the provider too, since it holds the client by reference", () => {
    const rebuildBlock = SOURCE.slice(SOURCE.indexOf("if (sawConnectionFault)"));
    expect(rebuildBlock.slice(0, 400)).toMatch(/anthropicClient = buildClient\(\)/);
    expect(rebuildBlock.slice(0, 400)).toMatch(/provider = buildProvider\(\)/);
  });

  // A round that needed a rebuild hit the defect mid-flight; the artefact must
  // say so rather than reading as a clean round.
  it("records the rebuild count in the artefact", () => {
    expect(SOURCE).toMatch(/artefact\.clientRebuilds = clientRebuilds/);
  });
});
