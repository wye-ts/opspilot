import { estimateCostUsd } from "@opspilot/agent-runtime";
import type {
  CostEstimate,
  ModelPricingTable,
  PricedTokenUsage,
} from "@opspilot/agent-runtime";

import { SUPPORTED_CLAUDE_MODEL } from "./claude-model";


/**
 * Anthropic list rates, transcribed from platform.claude.com/docs/en/about-claude/pricing
 * on 2026-07-28.
 *
 * Rates are integer **nanoUSD per token** (1 USD = 1e9 nanoUSD) so the whole
 * calculation stays exact integer arithmetic — see ModelPricing in
 * packages/agent-runtime/src/providers/cost-estimation.ts. Conversion:
 * $X per MTok → X * 1000 nanoUSD per token.
 *
 * claude-sonnet-5, introductory pricing, in effect through 2026-08-31:
 *
 *   base input          $2.00 / MTok  → 2000
 *   5m cache write      $2.50 / MTok  → 2500   (1.25x base input)
 *   1h cache write      $4.00 / MTok  → 4000   (2x base input)
 *   cache hit / refresh $0.20 / MTok  →  200   (0.1x base input)
 *   output             $10.00 / MTok  → 10000
 *
 * From 2026-09-01 the standard rate ($3 / $3.75 / $6 / $0.30 / $15 per MTok)
 * replaces it. That rollover is NOT encoded here as a second entry, because
 * only one entry can be correct at a time and a wrong-but-plausible number is
 * worse than none: once `validThrough` passes, every estimate becomes
 * `pricingStatus: "STALE"` with a null cost until the table is deliberately
 * updated. No test asserts against the wall clock, so nothing starts failing
 * on 2026-09-01 — the estimate simply stops claiming to be current.
 *
 * `effectiveFrom` is a conservative lower bound. Anthropic documents the
 * introductory rate's end date but not its start date, so this is set to a
 * date known to be inside the window rather than invented precision.
 */
export const CLAUDE_PRICING_TABLE: ModelPricingTable = {
  [SUPPORTED_CLAUDE_MODEL]: {
    pricingBasis: "ACTIVE_RATE",
    effectiveFrom: "2026-06-30",
    validThrough: "2026-08-31",
    inputNanoUsdPerToken: 2000,
    outputNanoUsdPerToken: 10_000,
    cacheReadNanoUsdPerToken: 200,
    cacheCreation5mNanoUsdPerToken: 2500,
    cacheCreation1hNanoUsdPerToken: 4000,
  },
};

/**
 * Prices a response. `model` must be the model Anthropic actually returned
 * (`message.model`), not the one that was requested — a server-side resolution
 * difference would otherwise be priced against the wrong rate silently.
 *
 * `observedAt` is injected rather than read from the clock here so the whole
 * path stays deterministic and testable.
 */
export function estimateClaudeCostUsd(
  usage: PricedTokenUsage,
  model: string,
  observedAt: Date,
): CostEstimate {
  return estimateCostUsd(usage, model, observedAt, CLAUDE_PRICING_TABLE);
}
