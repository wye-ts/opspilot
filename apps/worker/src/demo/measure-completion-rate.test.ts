import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import opspilotAgentRuntime from "@opspilot/agent-runtime";

import {
  NON_REPORT_BEARING_CODES,
  LIVE_RUN_RATE_LIMIT_DEFAULTS,
  resolveRateLimit,
  minRunIntervalMs,
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
  IN_FLIGHT_DESCRIPTION,
  partitionResolved,
  claimRunSlot,
  provisionalOutcome,
  type RunOutcome,
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
    expect(resolveRateLimit({})).toEqual({ max: 2, windowMs: 60_000 });
    expect(LIVE_RUN_RATE_LIMIT_DEFAULTS).toEqual({ max: 2, windowMs: 60_000 });
  });

  it("derives a 30s minimum interval from it", () => {
    expect(minRunIntervalMs(resolveRateLimit({}))).toBe(30_000);
  });

  // Deployment honours these overrides; hardcoding 2/60s meant a configured
  // 1/min still got a request every 30 seconds.
  it("honours the overrides apps/api reads", () => {
    const rate = resolveRateLimit({
      LIVE_RUN_RATE_LIMIT_MAX: "1",
      LIVE_RUN_RATE_LIMIT_WINDOW_MS: "60000",
    });
    expect(rate).toEqual({ max: 1, windowMs: 60_000 });
    expect(minRunIntervalMs(rate)).toBe(60_000);
  });

  it("rejects a rate outside the production range", () => {
    expect(() => resolveRateLimit({ LIVE_RUN_RATE_LIMIT_MAX: "0" })).toThrow(
      /LIVE_RUN_RATE_LIMIT_MAX/,
    );
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

describe("our own configuration failing voids the round", () => {
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "measure-completion-rate.ts"),
    "utf8",
  );

  // The orchestrator reports BILLING, AUTHENTICATION and REQUEST_INVALID as
  // PROVIDER_UNAVAILABLE (issue #123). Before the logger was attached that was
  // all the script could see, and it excluded them like any outage — which is
  // how a spend-limit rejection was once read as an upstream failure. With
  // terminalErrorCategory available, excluding them would be a choice, not a
  // limitation: the round would report a rate computed over whichever runs
  // happened to precede the billing failure.
  it("classifies our-fault categories separately from outages", () => {
    expect(SOURCE).toMatch(
      /OUR_FAULT_CATEGORIES = new Set\(\["BILLING", "AUTHENTICATION", "REQUEST_INVALID"\]\)/,
    );
  });

  // UNKNOWN means unclassified: the cause is not established, so excluding it
  // would let an unexplained failure shrink the denominator. The one exception
  // is APIConnectionError, whose cause IS understood (#125) and which is
  // handled by rebuilding — voiding on it would void every round, since it was
  // 35 of 49 invocations.
  it("voids on an unclassified UNKNOWN but not on the known connection fault", () => {
    expect(SOURCE).toMatch(/record\.terminalErrorCategory === "UNKNOWN" &&/);
    expect(SOURCE).toMatch(/record\.errorClass !== "APIConnectionError"/);
  });

  // A deadline expiry surfaces as CANCELLED too (the SDK raises
  // APIUserAbortError either way), so voiding on the category alone would
  // discard legitimate timeout rounds. The deadline signal is the only
  // cancellation source here, which makes it the discriminator.
  it("voids on a cancellation nobody requested, not on a deadline expiry", () => {
    expect(SOURCE).toMatch(/record\.terminalErrorCategory === "CANCELLED" &&/);
    expect(SOURCE).toMatch(/!currentDeadlineSignal\?\.aborted/);
  });

  it("reads the category from the logger, not the collapsed code", () => {
    expect(SOURCE).toContain("OUR_FAULT_CATEGORIES.has(record.terminalErrorCategory)");
  });

  // Only BILLING/AUTHENTICATION/REQUEST_INVALID are provably ours. An
  // unexplained cancellation or an unclassified failure voids the round too,
  // but calling those "our configuration failing" asserts a cause nobody
  // established.
  it("does not attribute every voiding cause to our configuration", () => {
    expect(SOURCE).not.toMatch(/which is our configuration\s*` \+/);
    expect(SOURCE).toMatch(/or something happened that nobody here can explain/);
  });

  it("voids the round rather than excluding the run", () => {
    expect(SOURCE).toMatch(/Round VOID: \$\{sawVoidingFault\}/);
    expect(SOURCE).toMatch(/throw new MeasurementConfigurationError\(\s*`Round VOID/);
  });

  // A fault on the final run would never be seen by a pre-run check alone.
  it("checks after the loop as well as before each run", () => {
    const occurrences = SOURCE.match(/Round VOID: \$\{sawVoidingFault\}/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  // The field exists to surface the defect; a crashed round previously
  // persisted 0 while having rebuilt several times.
  it("updates the rebuild count on the artefact immediately", () => {
    const rebuildBlock = SOURCE.slice(SOURCE.indexOf("clientRebuilds += 1;"));
    expect(rebuildBlock.slice(0, 400)).toMatch(/artefact\.clientRebuilds = clientRebuilds/);
  });
});

describe("a connection failure is unobserved, not proven absent", () => {
  const SOURCE = readFileSync(
    resolve(import.meta.dirname, "measure-completion-rate.ts"),
    "utf8",
  );

  // run-provider-usage-collector.ts documents that CONNECTION may mean the
  // request WAS processed and the response is what got lost. Claiming such a
  // run never reached the model overstates what the error proves — and the
  // same run may have been billed.
  it("does not claim the request never reached Anthropic", () => {
    expect(SOURCE).not.toMatch(/request never reached Anthropic/);
    expect(SOURCE).not.toMatch(/never leave the machine/);
  });

  it("states that the outcome is unobserved rather than absent", () => {
    expect(SOURCE).toMatch(/UNOBSERVED outcome|outcome is UNOBSERVED|unobserved, not absent/i);
    expect(SOURCE).toMatch(/RESPONSE is what got lost/i);
  });

  // The artefact's own scoring rule must describe the policy the script
  // actually applies: it said PROVIDER_UNAVAILABLE is excluded and only
  // non-LlmProviderError throws void, while the script voids on BILLING,
  // AUTHENTICATION, REQUEST_INVALID, unclassified UNKNOWN and an empty sample.
  it("persists a scoring rule matching the real voiding policy", () => {
    const rule = SOURCE.slice(SOURCE.indexOf("voided:"), SOURCE.indexOf("voided:") + 700);
    // The excluded rule must not claim the connection defect is the only
    // allowed exclusion: RATE_LIMIT, SERVER_ERROR and deadline expiry are
    // excluded too.
    const excludedRule = SOURCE.slice(SOURCE.indexOf("excluded:"), SOURCE.indexOf("voided:"));
    expect(excludedRule).toMatch(/RATE_LIMIT/);
    expect(excludedRule).toMatch(/SERVER_ERROR/);
    for (const cause of ["BILLING", "AUTHENTICATION", "REQUEST_INVALID", "UNKNOWN", "CANCELLED"]) {
      expect(rule).toContain(cause);
    }
    // And it must distinguish the two CANCELLED cases, or a reader concludes
    // every timeout voids the round.
    expect(rule).toMatch(/deadline expiry is excluded, not voided/i);
  });
});

/**
 * Issue #126 — a billed in-flight run must leave a ledger entry.
 *
 * Plan: docs/reviews/50-issue-126-in-flight-run-ledger-plan.md.
 */
describe("in-flight run ledger (#126)", () => {
  // Every affirmative claim the entry may NOT make. Each was written into an
  // earlier draft of the wording and removed by a separate review round, so
  // this list is a record of four real mistakes, not hypothetical ones.
  //
  // Matched on WORD BOUNDARIES: "ended" occurs inside "recommended" and
  // "billing" must not trip a "billed" ban. A bare includes() guard fires on
  // innocent prose and pressures the next author to weaken the text.
  const FORBIDDEN = [
    "attempted",   // false when the process died before the orchestrator call
    "dispatched",
    "sent",
    "billed",      // "billing status" is required; asserting it WAS billed is not
    "survive",
    "crashed",
    "died",
    "stopped",     // false while the round is still running
    "ended",
    "abandoned",
  ];

  const REQUIRED = [
    "no outcome has been recorded",
    "billing status",
    "unknown",
    "execution began",
    "still in progress",
  ];

  function forbiddenHits(text: string): string[] {
    return FORBIDDEN.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  }

  // CASE 10 — the guard must not contradict the wording it mandates.
  //
  // Sequenced first deliberately. Round 2 of plan review caught a version
  // demanding the text say "whether it WAS BILLED, is unknown" while asserting
  // it must not contain "was billed" — unsatisfiable, and the cheapest repair
  // would have been deleting the billing-uncertainty sentence, destroying the
  // honesty the rule exists to enforce.
  it("case 10: the approved description does not trip its own guard", () => {
    expect(forbiddenHits(IN_FLIGHT_DESCRIPTION)).toEqual([]);
    for (const phrase of REQUIRED) {
      expect(IN_FLIGHT_DESCRIPTION.toLowerCase()).toContain(phrase);
    }
  });

  it("case 10b: the guard still rejects an affirmative claim", () => {
    // Falsification: if the regex were inert, this would pass vacuously.
    expect(forbiddenHits("the request was billed and the round stopped")).toEqual([
      "billed",
      "stopped",
    ]);
    // Word-boundary proof — these must NOT match despite containing the letters.
    expect(forbiddenHits("the recommended billing status is unknown")).toEqual([]);
  });

  // CASE 5 — an in_flight entry must never reach a denominator.
  //
  // Uses the PRODUCTION predicate (partitionResolved), which main() itself
  // calls. A reimplementation here would pass while main() stayed wrong.
  describe("case 5: in_flight is excluded from every figure", () => {
    function outcome(status: string, ticketId: string): RunOutcome {
      return {
        ticketId,
        ticketSummary: "summary",
        ticketParameters: {},
        status,
        validationMessages: [],
        autoCompletedEvidence: 0,
        retrievedChunkIds: [],
        toolCallsMade: [],
      };
    }

    it("splits resolved from unresolved", () => {
      const { resolved, unresolved } = partitionResolved([
        outcome("completed", "T1"),
        outcome("in_flight", "T2"),
        outcome("excluded", "T3"),
      ]);

      expect(resolved.map((o) => o.ticketId)).toEqual(["T1", "T3"]);
      expect(unresolved).toBe(1);
    });

    it("an in_flight entry does not inflate the report-bearing denominator", () => {
      // This is the defect the hoisted filter prevents: in_flight satisfies
      // `status !== "excluded"`, so filtering raw outcomes would count it as
      // report-bearing and understate the completion rate.
      const outcomes = [outcome("completed", "T1"), outcome("in_flight", "T2")];

      const naive = outcomes.filter((o) => o.status !== "excluded").length;
      const { resolved } = partitionResolved(outcomes);
      const correct = resolved.filter((o) => o.status !== "excluded").length;

      expect(naive).toBe(2); // what the pre-#126 expression would have produced
      expect(correct).toBe(1); // what it must produce
    });

    it("reports zero unresolved for a normal round", () => {
      const { resolved, unresolved } = partitionResolved([
        outcome("completed", "T1"),
        outcome("excluded", "T2"),
      ]);
      expect(resolved).toHaveLength(2);
      expect(unresolved).toBe(0);
    });
  });
});

/**
 * Issue #126 — the ordering guarantee, exercised against the same helper
 * `main` uses. These are the cases that actually prove the defect is fixed:
 * an entry must be DURABLE before anything can spend, and resolution must
 * replace that entry rather than append a second one.
 */
describe("in-flight ordering (#126)", () => {
  const ticket = {
    id: "TICKET-9001",
    summary: "elevated error rate on billing-service",
    parameters: { service: "billing-service" },
  };

  function resolvedOutcome(): RunOutcome {
    return {
      ticketId: ticket.id,
      ticketSummary: ticket.summary,
      ticketParameters: ticket.parameters,
      status: "completed",
      validationMessages: [],
      autoCompletedEvidence: 0,
      retrievedChunkIds: ["chunk-1"],
      toolCallsMade: ["get_service_status#1"],
    };
  }

  // CASE 2 — the entry is durable BEFORE the caller can dispatch.
  it("case 2: flushes the provisional entry before returning the resolver", () => {
    const outcomes: RunOutcome[] = [];
    // What the artefact looked like at the moment flush() was called. This is
    // the crash window: everything visible here survives a kill.
    let flushedSnapshot: RunOutcome[] | null = null;

    claimRunSlot(outcomes, provisionalOutcome(ticket), () => {
      flushedSnapshot = outcomes.map((o) => ({ ...o }));
    });

    expect(flushedSnapshot).not.toBeNull();
    expect(flushedSnapshot!).toHaveLength(1);
    expect(flushedSnapshot![0]!.status).toBe("in_flight");
    expect(flushedSnapshot![0]!.ticketId).toBe(ticket.id);
  });

  // CASE 3 — the transition, not the length, is the evidence.
  //
  // Plan review round 1 caught an earlier version asserting only
  // `outcomes.length === N`. That passes against the PRE-change code too,
  // which pushes exactly once per run, so it could not distinguish
  // append-only from replace-in-place and would have been trusted green
  // having proven nothing.
  it("case 3: the same slot transitions in_flight -> resolved, without appending", () => {
    const outcomes: RunOutcome[] = [];
    const resolve1 = claimRunSlot(outcomes, provisionalOutcome(ticket), () => {});

    // State A: provisional.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("in_flight");

    resolve1(resolvedOutcome());

    // State B: same slot, resolved, length unchanged.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
    expect(outcomes[0]!.ticketId).toBe(ticket.id);
    expect(outcomes[0]!.toolCallsMade).toEqual(["get_service_status#1"]);
  });

  it("case 3b: several runs each occupy exactly one slot, in order", () => {
    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = { ...ticket, id: `TICKET-900${i}` };
      const resolveRun = claimRunSlot(outcomes, provisionalOutcome(t), () => {});
      resolveRun({ ...resolvedOutcome(), ticketId: t.id });
    }

    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.ticketId)).toEqual([
      "TICKET-9000",
      "TICKET-9001",
      "TICKET-9002",
    ]);
    expect(partitionResolved(outcomes).unresolved).toBe(0);
  });

  // CASE 4 — the one that proves the issue is fixed. A round that dies
  // mid-run must leave the interrupted run visible, with earlier runs intact.
  it("case 4: a crash mid-run leaves in_flight for exactly that run", () => {
    const outcomes: RunOutcome[] = [];
    let persisted: RunOutcome[] = [];
    const flush = (): void => {
      persisted = outcomes.map((o) => ({ ...o }));
    };

    // Run 1 completes normally.
    const resolve1 = claimRunSlot(outcomes, provisionalOutcome({ ...ticket, id: "T1" }), flush);
    resolve1({ ...resolvedOutcome(), ticketId: "T1" });
    flush();

    // Run 2 claims its slot, then the process dies — nothing else runs.
    claimRunSlot(outcomes, provisionalOutcome({ ...ticket, id: "T2" }), flush);

    // What a later reader finds on disk:
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.status).toBe("completed");
    expect(persisted[0]!.ticketId).toBe("T1");
    expect(persisted[1]!.status).toBe("in_flight");
    expect(persisted[1]!.ticketId).toBe("T2");

    // Pre-#126 this artefact would have held ONE entry and read as complete.
    const { resolved, unresolved } = partitionResolved(persisted);
    expect(resolved).toHaveLength(1);
    expect(unresolved).toBe(1);
  });

  // CASE 9 — killed after the provisional write, before the provider call.
  // Nothing was attempted at all, so the record must not say otherwise.
  it("case 9: the persisted entry makes no claim that a run was attempted", () => {
    const outcomes: RunOutcome[] = [];
    claimRunSlot(outcomes, provisionalOutcome(ticket), () => {});

    const entry = outcomes[0]!;
    expect(entry.status).toBe("in_flight");
    // Carries only facts known before execution.
    expect(entry.toolCallsMade).toEqual([]);
    expect(entry.retrievedChunkIds).toEqual([]);
    expect(entry.validationMessages).toEqual([]);
    expect(entry.autoCompletedEvidence).toBe(0);
    expect(entry.failureCode).toBeUndefined();
    expect(entry.failureMessage).toBeUndefined();
  });
});
