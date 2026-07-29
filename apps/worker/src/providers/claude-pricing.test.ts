import { describe, expect, it } from "vitest";

import { CLAUDE_PRICING_TABLE, estimateClaudeCostUsd } from "./claude-pricing";

const WITHIN_VALIDITY = new Date("2026-07-28T00:00:00.000Z");

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
} as const;

describe("CLAUDE_PRICING_TABLE", () => {
  it("contains exactly the one model this milestone supports", () => {
    // Unreachable rows for models no code path can select would be untested,
    // unverifiable claims.
    expect(Object.keys(CLAUDE_PRICING_TABLE)).toEqual(["claude-sonnet-5"]);
  });

  it("transcribes the published claude-sonnet-5 rates", () => {
    expect(CLAUDE_PRICING_TABLE["claude-sonnet-5"]).toEqual({
      pricingBasis: "ACTIVE_RATE",
      effectiveFrom: "2026-06-30",
      validThrough: "2026-08-31",
      inputNanoUsdPerToken: 2000,
      outputNanoUsdPerToken: 10_000,
      cacheReadNanoUsdPerToken: 200,
      cacheCreation5mNanoUsdPerToken: 2500,
      cacheCreation1hNanoUsdPerToken: 4000,
    });
  });

  it("keeps the documented cache multipliers relative to base input", () => {
    const pricing = CLAUDE_PRICING_TABLE["claude-sonnet-5"];
    if (!pricing) throw new Error("expected a claude-sonnet-5 entry");

    expect(pricing.cacheCreation5mNanoUsdPerToken).toBe(pricing.inputNanoUsdPerToken * 1.25);
    expect(pricing.cacheCreation1hNanoUsdPerToken).toBe(pricing.inputNanoUsdPerToken * 2);
    expect(pricing.cacheReadNanoUsdPerToken).toBe(pricing.inputNanoUsdPerToken * 0.1);
  });
});

describe("estimateClaudeCostUsd", () => {
  it("prices a realistic two-turn run", () => {
    // The measured Run-2 totals from docs/reviews/04-agent-design-claude-spike-results.md.
    const result = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 5961, outputTokens: 1674 },
      "claude-sonnet-5",
      WITHIN_VALIDITY,
    );

    // 5961*2000 + 1674*10000 = 11922000 + 16740000 = 28662000 nanoUSD
    expect(result.estimatedCostUsd).toBe(0.028662);
    expect(result.pricingStatus).toBe("CURRENT");
    expect(result.pricingBasis).toBe("ACTIVE_RATE");
    expect(result.pricingBasisDate).toBe("2026-07-28");
  });

  it("prices each cache category at its own rate", () => {
    const result = estimateClaudeCostUsd(
      {
        ...EMPTY_USAGE,
        cacheReadInputTokens: 1_000_000,
        cacheCreation5mInputTokens: 1_000_000,
        cacheCreation1hInputTokens: 1_000_000,
      },
      "claude-sonnet-5",
      WITHIN_VALIDITY,
    );

    // 0.20 + 2.50 + 4.00
    expect(result.estimatedCostUsd).toBe(6.7);
  });

  it("returns null for a model outside the supported set", () => {
    const result = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 1000 },
      "claude-opus-5",
      WITHIN_VALIDITY,
    );

    expect(result.estimatedCostUsd).toBeNull();
    expect(result.pricingStatus).toBe("UNKNOWN_MODEL");
  });

  it("goes stale rather than silently applying an expired rate", () => {
    const result = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 1_000_000 },
      "claude-sonnet-5",
      new Date("2026-09-01T00:00:00.000Z"),
    );

    expect(result.estimatedCostUsd).toBeNull();
    expect(result.pricingStatus).toBe("STALE");
  });

  it("refuses to price an unbroken-down cache write", () => {
    const result = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 100, cacheCreationBreakdownMissing: true },
      "claude-sonnet-5",
      WITHIN_VALIDITY,
    );

    expect(result.estimatedCostUsd).toBeNull();
    expect(result.pricingStatus).toBe("INSUFFICIENT_USAGE_DETAIL");
  });

  it("reads no ambient clock", () => {
    const a = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 42 },
      "claude-sonnet-5",
      WITHIN_VALIDITY,
    );
    const b = estimateClaudeCostUsd(
      { ...EMPTY_USAGE, inputTokens: 42 },
      "claude-sonnet-5",
      WITHIN_VALIDITY,
    );

    expect(a).toEqual(b);
  });
});
