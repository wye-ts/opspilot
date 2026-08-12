import type { LlmProviderErrorCategory, PricingStatus } from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";

import type { ClaudeProviderLogEvent } from "./claude-llm-provider";
import { createRunProviderUsageCollector } from "./run-provider-usage-collector";

let requestCounter = 0;

function successEvent(overrides: Partial<Extract<ClaudeProviderLogEvent, { outcome: "response_received" }>> = {}) {
  requestCounter += 1;
  return {
    outcome: "response_received",
    provider: "anthropic",
    model: "claude-sonnet-5",
    providerRequestId: `req-${requestCounter}`,
    providerMessageId: `msg-${requestCounter}`,
    latencyMs: 900,
    stopReason: "tool_use",
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadInputTokens: 10,
    cacheCreation5mInputTokens: 20,
    cacheCreation1hInputTokens: 30,
    // 0 is the PROTECTED-PATH value, and the only one the API accepts once LIVE
    // is servable. Fixtures default to it so every aggregation test below reads
    // as "what the shipped configuration produces"; the retry-uncertainty tests
    // opt into a non-zero value explicitly.
    configuredMaxRetries: 0,
    estimatedCostNanoUsd: "4000000",
    pricingStatus: "CURRENT",
    pricingBasis: "introductory",
    pricingBasisDate: "2026-07-29",
    effectiveFrom: "2026-01-01",
    validThrough: "2026-12-31",
    normalizedResultType: "diagnostic_tool_request",
    ...overrides,
  } satisfies ClaudeProviderLogEvent;
}

function errorEvent(category: LlmProviderErrorCategory): ClaudeProviderLogEvent {
  return {
    outcome: "error",
    provider: "anthropic",
    model: "claude-sonnet-5",
    terminalErrorCategory: category,
    errorSource: "sdk_exception",
    errorClass: "APIError",
    errorStatus: null,
    latencyMs: 120,
    configuredMaxRetries: 0,
  };
}

describe("createRunProviderUsageCollector — aggregation", () => {
  it("reports a known zero for a run with no provider call at all", () => {
    // Distinguishable from "unknown": nothing was attempted, so nothing was
    // spent, and that is a fact rather than an absence of information.
    const summary = createRunProviderUsageCollector().snapshot();

    expect(summary).toEqual({
      providerCallsObserved: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      estimatedCostNanoUsd: 0n,
      pricingStatus: "CURRENT",
      possibleUnobservedCost: false,
    });
  });

  it("sums counts and cost across two successful turns", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent());
    collector.record(successEvent());

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 2,
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadInputTokens: 20,
      cacheCreation5mInputTokens: 40,
      cacheCreation1hInputTokens: 60,
      estimatedCostNanoUsd: 8_000_000n,
    });
  });

  it("keeps only the first turn's usage when the second turn fails", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: "4000000" }));
    collector.record(errorEvent("TIMEOUT"));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      estimatedCostNanoUsd: 4_000_000n,
      possibleUnobservedCost: true,
    });
  });

  it("reports zero calls when the very first turn fails", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(errorEvent("AUTHENTICATION"));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 0,
      estimatedCostNanoUsd: 0n,
      possibleUnobservedCost: false,
    });
  });

  it("returns a stable snapshot that later events do not retroactively change", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent());
    const first = collector.snapshot();

    collector.record(successEvent());

    expect(first.providerCallsObserved).toBe(1);
    expect(collector.snapshot().providerCallsObserved).toBe(2);
  });
});

describe("createRunProviderUsageCollector — exact nanoUSD", () => {
  it("sums as bigint with no float intermediate", () => {
    const collector = createRunProviderUsageCollector();
    // Values chosen so a float sum would drift: 0.1 + 0.2 in USD terms.
    collector.record(successEvent({ estimatedCostNanoUsd: "100000000" }));
    collector.record(successEvent({ estimatedCostNanoUsd: "200000000" }));

    expect(collector.snapshot().estimatedCostNanoUsd).toBe(300_000_000n);
  });

  it("round-trips a decimal string to bigint identically", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: "17956000" }));

    expect(collector.snapshot().estimatedCostNanoUsd).toBe(BigInt("17956000"));
  });

  it("preserves values beyond Number.MAX_SAFE_INTEGER", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: "9007199254740993" }));
    collector.record(successEvent({ estimatedCostNanoUsd: "1" }));

    const total = collector.snapshot().estimatedCostNanoUsd;
    expect(total).toBe(9_007_199_254_740_994n);
    expect(total).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("yields a bigint, so the value cannot be handed to JSON.stringify by accident", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent());
    const { estimatedCostNanoUsd } = collector.snapshot();

    expect(typeof estimatedCostNanoUsd).toBe("bigint");
    // The throw is the safety net: a bigint cannot silently become a JSON
    // number, so any accidental serialization fails loudly instead.
    expect(() => JSON.stringify({ estimatedCostNanoUsd })).toThrow(/BigInt/);
  });
});

describe("createRunProviderUsageCollector — unknown cost", () => {
  it("makes the total null when any turn reports a null cost", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: "4000000" }));
    collector.record(successEvent({ estimatedCostNanoUsd: null }));

    expect(collector.snapshot().estimatedCostNanoUsd).toBeNull();
  });

  it("keeps the total null once it is null, whatever follows", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: null }));
    collector.record(successEvent({ estimatedCostNanoUsd: "4000000" }));

    expect(collector.snapshot().estimatedCostNanoUsd).toBeNull();
  });

  it("still counts tokens for a turn whose cost is unknown", () => {
    // The token counts are observed facts even when pricing is not, and the
    // audit trail should keep them.
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: null, inputTokens: 500, outputTokens: 60 }));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      inputTokens: 500,
      outputTokens: 60,
      estimatedCostNanoUsd: null,
    });
  });

  it("never reports a null cost as a known zero", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ estimatedCostNanoUsd: null }));

    const { estimatedCostNanoUsd } = collector.snapshot();
    expect(estimatedCostNanoUsd).toBeNull();
    expect(estimatedCostNanoUsd).not.toBe(0n);
  });

  /**
   * A null total and a "cost is complete" claim are contradictory, and the
   * collector used to persist exactly that pair.
   *
   * A successful turn reporting a null cost set the aggregate to null but left
   * possibleUnobservedCost false, so the stored record said "this run's cost is
   * fully accounted for, and we do not know what it is". Nothing downstream was
   * fooled — reconciliation treats a null cost as unknown on its own, and the
   * DTO hides it — but the audit record was internally inconsistent and any
   * future consumer trusting the flag alone would have been misled.
   */
  describe("a successful null-cost turn is also UNCERTAIN", () => {
    it("marks a single null-cost success as possibly incomplete", () => {
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ estimatedCostNanoUsd: null }));

      expect(collector.snapshot()).toMatchObject({
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: true,
      });
    });

    it("becomes uncertain when a known turn is followed by a null-cost turn", () => {
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ estimatedCostNanoUsd: "4000000" }));
      collector.record(successEvent({ estimatedCostNanoUsd: null }));

      expect(collector.snapshot()).toMatchObject({
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: true,
      });
    });

    it("stays uncertain when a null-cost turn is followed by a known turn", () => {
      // The flag is monotonic: a later measurable turn cannot vouch for an
      // earlier unmeasurable one.
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ estimatedCostNanoUsd: null }));
      collector.record(successEvent({ estimatedCostNanoUsd: "4000000" }));

      expect(collector.snapshot()).toMatchObject({
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: true,
      });
    });

    it("keeps the uncertainty when the same null-cost event is recorded twice", () => {
      const collector = createRunProviderUsageCollector();
      const event = successEvent({ estimatedCostNanoUsd: null, inputTokens: 500, outputTokens: 60 });

      collector.record(event);
      collector.record(event);

      // Deduplicated by providerRequestId — one call, one set of tokens — and
      // still uncertain.
      expect(collector.snapshot()).toMatchObject({
        providerCallsObserved: 1,
        inputTokens: 500,
        outputTokens: 60,
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: true,
      });
    });

    it("does NOT mark an exact known zero as uncertain", () => {
      // "0" is a measurement, not an absence of one. Conflating the two would
      // close the day's cost gate on every genuinely free turn.
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ estimatedCostNanoUsd: "0" }));

      expect(collector.snapshot()).toMatchObject({
        estimatedCostNanoUsd: 0n,
        possibleUnobservedCost: false,
      });
    });

    it("keeps a retry-capable success uncertain for its own reason", () => {
      // Two independent routes to the same flag; neither depends on the other.
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ estimatedCostNanoUsd: "4000000", configuredMaxRetries: 1 }));

      expect(collector.snapshot()).toMatchObject({
        estimatedCostNanoUsd: 4_000_000n,
        possibleUnobservedCost: true,
      });
    });
  });
});

describe("createRunProviderUsageCollector — pricing status precedence", () => {
  it.each<[PricingStatus, PricingStatus, PricingStatus]>([
    ["CURRENT", "STALE", "STALE"],
    ["STALE", "CURRENT", "STALE"],
    ["CURRENT", "INSUFFICIENT_USAGE_DETAIL", "INSUFFICIENT_USAGE_DETAIL"],
    ["STALE", "INSUFFICIENT_USAGE_DETAIL", "INSUFFICIENT_USAGE_DETAIL"],
    ["INSUFFICIENT_USAGE_DETAIL", "UNKNOWN_MODEL", "UNKNOWN_MODEL"],
    ["UNKNOWN_MODEL", "CURRENT", "UNKNOWN_MODEL"],
    ["CURRENT", "CURRENT", "CURRENT"],
  ])("resolves %s then %s to %s", (first, second, expected) => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ pricingStatus: first }));
    collector.record(successEvent({ pricingStatus: second }));

    expect(collector.snapshot().pricingStatus).toBe(expected);
  });

  it("keeps the worst status regardless of arrival order", () => {
    const ascending = createRunProviderUsageCollector();
    ascending.record(successEvent({ pricingStatus: "CURRENT" }));
    ascending.record(successEvent({ pricingStatus: "UNKNOWN_MODEL" }));

    const descending = createRunProviderUsageCollector();
    descending.record(successEvent({ pricingStatus: "UNKNOWN_MODEL" }));
    descending.record(successEvent({ pricingStatus: "CURRENT" }));

    expect(ascending.snapshot().pricingStatus).toBe("UNKNOWN_MODEL");
    expect(descending.snapshot().pricingStatus).toBe("UNKNOWN_MODEL");
  });
});

describe("createRunProviderUsageCollector — fail closed on ambiguity", () => {
  it.each<LlmProviderErrorCategory>(["AUTHENTICATION", "BILLING", "RATE_LIMIT", "REQUEST_INVALID"])(
    "does not flag unobserved cost for %s, which is provably pre-inference",
    (category) => {
      const collector = createRunProviderUsageCollector();
      collector.record(errorEvent(category));

      expect(collector.snapshot().possibleUnobservedCost).toBe(false);
    },
  );

  it.each<LlmProviderErrorCategory>(["CONNECTION", "TIMEOUT", "CANCELLED", "SERVER_ERROR", "UNKNOWN"])(
    "flags unobserved cost for %s, which could have been billed",
    (category) => {
      const collector = createRunProviderUsageCollector();
      collector.record(errorEvent(category));

      expect(collector.snapshot().possibleUnobservedCost).toBe(true);
    },
  );

  it("covers every provider error category, so a new one cannot be silently unclassified", () => {
    const allCategories: readonly LlmProviderErrorCategory[] = [
      "AUTHENTICATION",
      "BILLING",
      "RATE_LIMIT",
      "CONNECTION",
      "TIMEOUT",
      "CANCELLED",
      "SERVER_ERROR",
      "REQUEST_INVALID",
      "UNKNOWN",
    ];
    const provablyUnbilled = new Set(["AUTHENTICATION", "BILLING", "RATE_LIMIT", "REQUEST_INVALID"]);

    for (const category of allCategories) {
      const collector = createRunProviderUsageCollector();
      collector.record(errorEvent(category));
      expect(collector.snapshot().possibleUnobservedCost).toBe(!provablyUnbilled.has(category));
    }

    expect(allCategories).toHaveLength(9);
  });

  it("keeps the flag set once any ambiguous failure has occurred", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(errorEvent("TIMEOUT"));
    collector.record(errorEvent("AUTHENTICATION"));

    expect(collector.snapshot().possibleUnobservedCost).toBe(true);
  });

  it("flags a cancelled run, because generated tokens are billed even when the caller left", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent());
    collector.record(errorEvent("CANCELLED"));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      possibleUnobservedCost: true,
    });
  });
});

/**
 * A SUCCESS can hide spend too.
 *
 * The SDK reports only the final attempt of a retried request. If retries were
 * configured, an earlier attempt may have reached Anthropic and been billed
 * without ever reaching this collector — and nothing in the response says whether
 * that happened. The collector previously recorded such a success as an exact
 * figure, which let the API publish a lower bound as a total and let budget
 * reconciliation keep the day's cost gate open over spend nobody could see.
 *
 * The claim is now withdrawn rather than the number: the observed cost is still
 * accumulated, but it is no longer asserted to be complete.
 */
describe("createRunProviderUsageCollector — retry-configured successes", () => {
  it("reports an exact cost when retries are disabled", () => {
    // The protected public path, where ANTHROPIC_MAX_RETRIES must be 0. Only
    // here can a success be claimed as complete.
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ configuredMaxRetries: 0 }));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      estimatedCostNanoUsd: 4_000_000n,
      possibleUnobservedCost: false,
    });
  });

  it.each([1, 2, 5])(
    "reports a possibly-incomplete cost when maxRetries is %i, even on success",
    (configuredMaxRetries) => {
      const collector = createRunProviderUsageCollector();
      collector.record(successEvent({ configuredMaxRetries }));

      const summary = collector.snapshot();
      expect(summary.possibleUnobservedCost).toBe(true);
      // The observed figure is KEPT — it is a lower bound, not a lie. Discarding
      // it would lose real audit information; the flag is what stops it being
      // read as a total.
      expect(summary.estimatedCostNanoUsd).toBe(4_000_000n);
      expect(summary.providerCallsObserved).toBe(1);
    },
  );

  it("does not let a duplicate success event undo the uncertainty", () => {
    // The dedup guard returns early for a repeated request id. If the flag were
    // set after that guard, whether the run looked exact would depend on which
    // copy of the event arrived first.
    const collector = createRunProviderUsageCollector();
    const event = successEvent({ configuredMaxRetries: 1 });

    collector.record(event);
    collector.record(event);

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      possibleUnobservedCost: true,
    });
  });

  it("retains uncertainty across a mix of retry-configured and clean turns", () => {
    // One ambiguous turn is enough. A later turn that happens to be exact cannot
    // vouch for the one before it.
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ configuredMaxRetries: 1 }));
    collector.record(successEvent({ configuredMaxRetries: 0 }));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 2,
      possibleUnobservedCost: true,
    });
  });

  it("retains uncertainty when a retry-configured success precedes a clean error", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ configuredMaxRetries: 2 }));
    collector.record(errorEvent("AUTHENTICATION"));

    expect(collector.snapshot().possibleUnobservedCost).toBe(true);
  });
});

describe("createRunProviderUsageCollector — deduplication", () => {
  it("ignores a repeated providerRequestId rather than double-counting it", () => {
    const collector = createRunProviderUsageCollector();
    const event = successEvent();

    collector.record(event);
    collector.record(event);

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      inputTokens: 1_000,
      outputTokens: 200,
      estimatedCostNanoUsd: 4_000_000n,
    });
  });

  it("ignores a duplicate even when the repeat carries different numbers", () => {
    const collector = createRunProviderUsageCollector();
    const first = successEvent({ inputTokens: 1_000, estimatedCostNanoUsd: "4000000" });
    collector.record(first);
    collector.record({ ...first, inputTokens: 99_999, estimatedCostNanoUsd: "99999999" });

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 1,
      inputTokens: 1_000,
      estimatedCostNanoUsd: 4_000_000n,
    });
  });

  it("counts distinct request ids separately", () => {
    const collector = createRunProviderUsageCollector();
    collector.record(successEvent({ providerRequestId: "req-a" }));
    collector.record(successEvent({ providerRequestId: "req-b" }));

    expect(collector.snapshot().providerCallsObserved).toBe(2);
  });

  it("counts each error event by arrival, since errors carry no request id", () => {
    // Safe because the adapter emits exactly one terminal event per
    // runAgentTurn, so arrival counting cannot double-count.
    const collector = createRunProviderUsageCollector();
    collector.record(errorEvent("TIMEOUT"));
    collector.record(errorEvent("TIMEOUT"));

    expect(collector.snapshot()).toMatchObject({
      providerCallsObserved: 0,
      possibleUnobservedCost: true,
    });
  });

  it("does not let a duplicate worsen the pricing status twice over", () => {
    const collector = createRunProviderUsageCollector();
    const event = successEvent({ pricingStatus: "STALE" });
    collector.record(event);
    collector.record(event);

    expect(collector.snapshot()).toMatchObject({ pricingStatus: "STALE", providerCallsObserved: 1 });
  });
});
