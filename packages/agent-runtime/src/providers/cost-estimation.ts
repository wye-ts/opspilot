/**
 * Provider-neutral cost estimation.
 *
 * SDK-free by construction: this module ships inside the API production
 * image (docs/08-cicd-deployment.md §13), so it must never import
 * @anthropic-ai/sdk. It knows how to *price* a usage record; it does not
 * know which vendor produced one. The rate table itself is provider-specific
 * and lives with the adapter that owns it.
 *
 * Two properties matter more than the arithmetic:
 *
 *  1. No clock is read here. `observedAt` is injected, so tests pin dates
 *     explicitly and no test starts failing on a calendar boundary.
 *  2. An estimate that cannot be produced correctly is `null` with a reason,
 *     never a guess. A silently stale or partially-priced number is worse
 *     than no number.
 */

/**
 * Cache-creation tokens are priced at different multipliers per TTL (5-minute
 * writes and 1-hour writes are separate rates), so they are separate priced
 * quantities and must never be summed into one.
 */
export interface PricedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  /**
   * Set by the adapter when the provider reported a non-zero *aggregate*
   * cache-creation total but no per-TTL breakdown to price it with. The TTL
   * is never inferred: without the breakdown the request genuinely cannot be
   * priced, and the estimate becomes INSUFFICIENT_USAGE_DETAIL.
   */
  readonly cacheCreationBreakdownMissing?: boolean;
}

/**
 * Rates are integer **nanoUSD per token** (1 USD = 1e9 nanoUSD), not floats
 * per million tokens. Every published Anthropic rate lands on an integer in
 * these units — $2.00/MTok is 2000, $0.20/MTok is 200, $2.50/MTok is 2500 —
 * so the whole calculation is exact integer arithmetic and cannot accumulate
 * binary floating-point noise across five separate token categories.
 */
export interface ModelPricing {
  readonly pricingBasis: string;
  /** Inclusive ISO date (YYYY-MM-DD) from which these rates apply. */
  readonly effectiveFrom: string;
  /** Inclusive ISO date (YYYY-MM-DD) through which these rates apply. */
  readonly validThrough: string;
  readonly inputNanoUsdPerToken: number;
  readonly outputNanoUsdPerToken: number;
  readonly cacheReadNanoUsdPerToken: number;
  readonly cacheCreation5mNanoUsdPerToken: number;
  readonly cacheCreation1hNanoUsdPerToken: number;
}

export type ModelPricingTable = Readonly<Record<string, ModelPricing>>;

export type PricingStatus =
  | "CURRENT"
  | "STALE"
  | "UNKNOWN_MODEL"
  | "INSUFFICIENT_USAGE_DETAIL";

export interface CostEstimate {
  readonly estimatedCostUsd: number | null;
  readonly pricingStatus: PricingStatus;
  readonly pricingBasis: string | null;
  /** The observation date the estimate was computed against (YYYY-MM-DD). */
  readonly pricingBasisDate: string | null;
  readonly effectiveFrom: string | null;
  readonly validThrough: string | null;
}

// ISO YYYY-MM-DD strings compare correctly with plain lexicographic
// ordering, which sidesteps timezone arithmetic entirely: a validity window
// is a calendar-day concept, not an instant.
function toIsoDate(observedAt: Date): string {
  return observedAt.toISOString().slice(0, 10);
}

// Exact integer arithmetic; see ModelPricing's note on units.
function totalNanoUsd(usage: PricedTokenUsage, pricing: ModelPricing): number {
  return (
    usage.inputTokens * pricing.inputNanoUsdPerToken +
    usage.outputTokens * pricing.outputNanoUsdPerToken +
    usage.cacheReadInputTokens * pricing.cacheReadNanoUsdPerToken +
    usage.cacheCreation5mInputTokens * pricing.cacheCreation5mNanoUsdPerToken +
    usage.cacheCreation1hInputTokens * pricing.cacheCreation1hNanoUsdPerToken
  );
}

// Rounded to whole microUSD (6 decimal places). Small live runs cost on the
// order of $0.03, so micro-dollar resolution is far finer than the estimate's
// own accuracy, while keeping printed output and test expectations free of
// trailing floating-point noise.
function nanoUsdToUsd(nanoUsd: number): number {
  return Math.round(nanoUsd / 1000) / 1_000_000;
}

/**
 * Status precedence, when more than one applies:
 *
 *   UNKNOWN_MODEL → STALE → INSUFFICIENT_USAGE_DETAIL → CURRENT
 *
 * STALE outranks INSUFFICIENT_USAGE_DETAIL deliberately: stale pricing is the
 * operator-actionable problem (the table needs updating), whereas a missing
 * cache breakdown is a property of one response.
 */
export function estimateCostUsd(
  usage: PricedTokenUsage,
  model: string,
  observedAt: Date,
  pricingTable: ModelPricingTable,
): CostEstimate {
  const observedDate = toIsoDate(observedAt);
  const pricing = pricingTable[model];

  if (!pricing) {
    return {
      estimatedCostUsd: null,
      pricingStatus: "UNKNOWN_MODEL",
      pricingBasis: null,
      pricingBasisDate: observedDate,
      effectiveFrom: null,
      validThrough: null,
    };
  }

  const metadata = {
    pricingBasis: pricing.pricingBasis,
    pricingBasisDate: observedDate,
    effectiveFrom: pricing.effectiveFrom,
    validThrough: pricing.validThrough,
  } as const;

  if (observedDate < pricing.effectiveFrom || observedDate > pricing.validThrough) {
    return { estimatedCostUsd: null, pricingStatus: "STALE", ...metadata };
  }

  if (usage.cacheCreationBreakdownMissing === true) {
    return {
      estimatedCostUsd: null,
      pricingStatus: "INSUFFICIENT_USAGE_DETAIL",
      ...metadata,
    };
  }

  return {
    estimatedCostUsd: nanoUsdToUsd(totalNanoUsd(usage, pricing)),
    pricingStatus: "CURRENT",
    ...metadata,
  };
}
