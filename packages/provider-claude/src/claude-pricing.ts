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
 * claude-sonnet-5, STANDARD pricing, in effect from 2026-09-01 (re-transcribed
 * from the same page on 2026-09-14):
 *
 *   base input          $3.00 / MTok  → 3000
 *   5m cache write      $3.75 / MTok  → 3750   (1.25x base input)
 *   1h cache write      $6.00 / MTok  → 6000   (2x base input)
 *   cache hit / refresh $0.30 / MTok  →  300   (0.1x base input)
 *   output             $15.00 / MTok  → 15000
 *
 * This replaces the launch introductory rate ($2 / $2.50 / $4 / $0.20 / $10),
 * which expired 2026-08-31. Only one entry per model can be correct at a time,
 * so the superseded rate is NOT kept as a second entry — a wrong-but-plausible
 * number is worse than none.
 *
 * WHY THIS ENTRY IS LOAD-BEARING, not merely informational: a run whose cost
 * cannot be established increments `live_run_budget.pricing_unknown_runs`, and
 * the reservation gate in agent-run-repository.ts requires that counter to be
 * zero. A stale table therefore does not just lose a cost figure — it closes
 * the LIVE budget gate for the remainder of the UTC day after the first run,
 * globally. Between 2026-09-01 and this update the deployed service could
 * admit exactly one LIVE run per day for that reason. Treat `validThrough`
 * below as an operational deadline, not a bookkeeping nicety.
 *
 * SOURCE CONFLICT, recorded rather than silently resolved: the official
 * pricing page read on 2026-09-14 still lists the $3/$15 standard rate from
 * 2026-09-01, and that is what is transcribed here. Several third-party
 * write-ups claim Anthropic cancelled the increase on 2026-08-10 and made
 * $2/$10 permanent. They were not treated as authoritative over Anthropic's
 * own page. The disagreement is also SAFE in this direction: these rates drive
 * a spend gate, so overestimating closes the gate early (conservative), while
 * underestimating would let real spending run past the ceiling. If the lower
 * rate is later confirmed on the official page, correct it there and here —
 * the only cost of being wrong this way is a gate that trips sooner than
 * necessary.
 *
 * `validThrough` is a deliberate RE-VERIFICATION DEADLINE, not an announced end
 * date: Anthropic publishes no end for the standard rate. It is set one year
 * out so the table fails loud (STALE, null cost) rather than silently drifting
 * for years. Moving it forward requires re-reading the published rates first.
 */
export const CLAUDE_PRICING_TABLE: ModelPricingTable = {
  [SUPPORTED_CLAUDE_MODEL]: {
    pricingBasis: "ACTIVE_RATE",
    effectiveFrom: "2026-09-01",
    validThrough: "2027-08-31",
    inputNanoUsdPerToken: 3000,
    outputNanoUsdPerToken: 15_000,
    cacheReadNanoUsdPerToken: 300,
    cacheCreation5mNanoUsdPerToken: 3750,
    cacheCreation1hNanoUsdPerToken: 6000,
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
