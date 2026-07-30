import { describe, expect, it } from "vitest";

import {
  estimateCostUsd,
  type ModelPricingTable,
  type PricedTokenUsage,
} from "./cost-estimation";

// Mirrors the real claude-sonnet-5 entry's shape and rates so the arithmetic
// under test is the arithmetic that actually runs, but stays local to this
// package: cost-estimation.ts must remain table-agnostic.
const TABLE: ModelPricingTable = {
  "test-model-5": {
    pricingBasis: "ACTIVE_RATE",
    effectiveFrom: "2026-06-30",
    validThrough: "2026-08-31",
    inputNanoUsdPerToken: 2000, // $2.00 / MTok
    outputNanoUsdPerToken: 10_000, // $10.00 / MTok
    cacheReadNanoUsdPerToken: 200, // $0.20 / MTok
    cacheCreation5mNanoUsdPerToken: 2500, // $2.50 / MTok
    cacheCreation1hNanoUsdPerToken: 4000, // $4.00 / MTok
  },
};

const WITHIN_VALIDITY = new Date("2026-07-28T12:00:00.000Z");

function usage(overrides: Partial<PricedTokenUsage> = {}): PricedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    ...overrides,
  };
}

describe("estimateCostUsd", () => {
  it("prices normal input and output tokens", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result.pricingStatus).toBe("CURRENT");
    expect(result.estimatedCostUsd).toBe(12);
  });

  it("prices cache-read tokens at the cache-read rate, not the input rate", () => {
    const result = estimateCostUsd(
      usage({ cacheReadInputTokens: 1_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result.estimatedCostUsd).toBe(0.2);
  });

  it("prices 5-minute cache-creation tokens at the 5m write rate", () => {
    const result = estimateCostUsd(
      usage({ cacheCreation5mInputTokens: 1_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result.estimatedCostUsd).toBe(2.5);
  });

  it("prices 1-hour cache-creation tokens at the distinct 1h write rate", () => {
    const result = estimateCostUsd(
      usage({ cacheCreation1hInputTokens: 1_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result.estimatedCostUsd).toBe(4);
  });

  it("never conflates the two cache-creation TTLs into one rate", () => {
    const fiveMinute = estimateCostUsd(
      usage({ cacheCreation5mInputTokens: 2_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );
    const oneHour = estimateCostUsd(
      usage({ cacheCreation1hInputTokens: 2_000_000 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(fiveMinute.estimatedCostUsd).toBe(5);
    expect(oneHour.estimatedCostUsd).toBe(8);
    expect(fiveMinute.estimatedCostUsd).not.toBe(oneHour.estimatedCostUsd);
  });

  it("sums every token category for mixed usage", () => {
    const result = estimateCostUsd(
      usage({
        inputTokens: 1861,
        outputTokens: 81,
        cacheReadInputTokens: 500,
        cacheCreation5mInputTokens: 250,
        cacheCreation1hInputTokens: 100,
      }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    // (1861*2000 + 81*10000 + 500*200 + 250*2500 + 100*4000) nanoUSD
    // = 3722000 + 810000 + 100000 + 625000 + 400000 = 5657000 nanoUSD
    expect(result.estimatedCostUsd).toBe(0.005657);
    expect(result.pricingStatus).toBe("CURRENT");
  });

  it("produces clean decimal output with no floating-point noise", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 3, outputTokens: 7 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    // 3*2000 + 7*10000 = 76000 nanoUSD = 0.000076 USD
    expect(result.estimatedCostUsd).toBe(0.000076);
    expect(String(result.estimatedCostUsd)).toBe("0.000076");
  });

  it("returns UNKNOWN_MODEL with a null estimate for a model with no entry", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1000 }),
      "some-other-model",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result).toEqual({
      estimatedCostNanoUsd: null,
      estimatedCostUsd: null,
      pricingStatus: "UNKNOWN_MODEL",
      pricingBasis: null,
      pricingBasisDate: "2026-07-28",
      effectiveFrom: null,
      validThrough: null,
    });
  });

  it("returns STALE after the validity window closes", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1_000_000 }),
      "test-model-5",
      new Date("2026-09-01T00:00:00.000Z"),
      TABLE,
    );

    expect(result.estimatedCostUsd).toBeNull();
    expect(result.pricingStatus).toBe("STALE");
    expect(result.validThrough).toBe("2026-08-31");
  });

  it("returns STALE before the validity window opens", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1_000_000 }),
      "test-model-5",
      new Date("2026-06-29T23:59:59.000Z"),
      TABLE,
    );

    expect(result.pricingStatus).toBe("STALE");
  });

  it("treats both validity boundaries as inclusive", () => {
    const firstDay = estimateCostUsd(
      usage({ inputTokens: 1000 }),
      "test-model-5",
      new Date("2026-06-30T00:00:00.000Z"),
      TABLE,
    );
    const lastDay = estimateCostUsd(
      usage({ inputTokens: 1000 }),
      "test-model-5",
      new Date("2026-08-31T23:59:59.000Z"),
      TABLE,
    );

    expect(firstDay.pricingStatus).toBe("CURRENT");
    expect(lastDay.pricingStatus).toBe("CURRENT");
  });

  it("returns INSUFFICIENT_USAGE_DETAIL rather than guessing a missing cache TTL", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1000, cacheCreationBreakdownMissing: true }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    expect(result.estimatedCostUsd).toBeNull();
    expect(result.pricingStatus).toBe("INSUFFICIENT_USAGE_DETAIL");
    expect(result.pricingBasis).toBe("ACTIVE_RATE");
  });

  it("reports STALE ahead of INSUFFICIENT_USAGE_DETAIL when both apply", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1000, cacheCreationBreakdownMissing: true }),
      "test-model-5",
      new Date("2026-09-15T00:00:00.000Z"),
      TABLE,
    );

    expect(result.pricingStatus).toBe("STALE");
  });

  it("reports UNKNOWN_MODEL ahead of every other status", () => {
    const result = estimateCostUsd(
      usage({ cacheCreationBreakdownMissing: true }),
      "no-such-model",
      new Date("2027-01-01T00:00:00.000Z"),
      TABLE,
    );

    expect(result.pricingStatus).toBe("UNKNOWN_MODEL");
  });

  it("carries the injected observation date as pricingBasisDate", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 10 }),
      "test-model-5",
      new Date("2026-08-15T09:30:00.000Z"),
      TABLE,
    );

    expect(result.pricingBasisDate).toBe("2026-08-15");
    expect(result.effectiveFrom).toBe("2026-06-30");
    expect(result.validThrough).toBe("2026-08-31");
  });

  it("depends on no ambient clock — the same inputs always give the same result", () => {
    const call = () =>
      estimateCostUsd(
        usage({ inputTokens: 1234, outputTokens: 567 }),
        "test-model-5",
        WITHIN_VALIDITY,
        TABLE,
      );

    expect(call()).toEqual(call());
  });
});

/**
 * The accounting field is the one downstream code sums, persists, and compares
 * (PR 6B2 accumulates it into a durable daily total). These assertions are
 * about exactness surviving the boundary, not about the arithmetic — which the
 * suite above already covers through the USD projection.
 */
describe("estimateCostUsd — exact nanoUSD accounting value", () => {
  it("reports the exact integer nanoUSD as a decimal string", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 200 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    // 1000*2000 + 50*10000 + 200*200 = 2000000 + 500000 + 40000
    expect(result.estimatedCostNanoUsd).toBe("2540000");
  });

  it("round-trips through BigInt without loss", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1234, outputTokens: 567 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    const exact = BigInt(result.estimatedCostNanoUsd as string);

    expect(exact).toBe(1234n * 2000n + 567n * 10_000n);
    expect(exact.toString()).toBe(result.estimatedCostNanoUsd);
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // Synthetic, far beyond any real run: the point is that exactness is a
    // property of the representation, not of the magnitude. As a float this
    // total would silently round; the assertion below would then fail.
    const enormous = 10_000_000_000_000n;
    const result = estimateCostUsd(
      usage({ inputTokens: Number(enormous) }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    const exact = BigInt(result.estimatedCostNanoUsd as string);

    expect(exact).toBe(enormous * 2000n);
    expect(exact).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(exact % 2000n).toBe(0n);
  });

  it("sums across turns without drift", () => {
    // The multi-turn aggregation PR 6B2 performs, done here in bigint. The
    // equivalent float sum of the USD projections does not reproduce it.
    const turns = [
      usage({ inputTokens: 1117, outputTokens: 293 }),
      usage({ inputTokens: 883, outputTokens: 407 }),
    ].map((u) => estimateCostUsd(u, "test-model-5", WITHIN_VALIDITY, TABLE));

    const total = turns.reduce(
      (sum, turn) => sum + BigInt(turn.estimatedCostNanoUsd as string),
      0n,
    );

    expect(total).toBe(2000n * 2000n + 700n * 10_000n);
  });

  it("keeps a null estimate null rather than reporting zero", () => {
    // A cost that could not be computed must never reconcile as a known $0.
    const unknownModel = estimateCostUsd(usage({ inputTokens: 1000 }), "nope", WITHIN_VALIDITY, TABLE);
    const stale = estimateCostUsd(
      usage({ inputTokens: 1000 }),
      "test-model-5",
      new Date("2026-09-01T00:00:00.000Z"),
      TABLE,
    );
    const missingBreakdown = estimateCostUsd(
      { ...usage({ inputTokens: 100 }), cacheCreationBreakdownMissing: true },
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    for (const result of [unknownModel, stale, missingBreakdown]) {
      expect(result.estimatedCostNanoUsd).toBeNull();
      expect(result.estimatedCostNanoUsd).not.toBe("0");
    }
  });

  it("survives JSON serialization, which a bigint field would not", () => {
    const result = estimateCostUsd(
      usage({ inputTokens: 1000, outputTokens: 50 }),
      "test-model-5",
      WITHIN_VALIDITY,
      TABLE,
    );

    // The reason the field is a string and not a bigint: this call throws
    // "Do not know how to serialize a BigInt" if it ever becomes one, and the
    // sanitized provider log event carrying it is JSON-serialized.
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result)).estimatedCostNanoUsd).toBe("2500000");
  });
});
