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
 * claude-sonnet-5, STANDARD pricing (re-transcribed from the same page on
 * 2026-09-22):
 *
 *   base input          $2.00 / MTok  → 2000
 *   5m cache write      $2.50 / MTok  → 2500   (1.25x base input)
 *   1h cache write      $4.00 / MTok  → 4000   (2x base input)
 *   cache hit / refresh $0.20 / MTok  →  200   (0.1x base input)
 *   output             $10.00 / MTok  → 10000
 *
 * The $2/$10 rate launched as introductory pricing through 2026-08-31. It is
 * now the STANDARD rate: the pricing page states that the scheduled increase
 * to $3/$15 on 2026-09-01 "will not occur". There is therefore no superseded
 * rate to keep — only one entry per model can be correct at a time, and a
 * wrong-but-plausible number is worse than none.
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
 * SOURCE CONFLICT, now RESOLVED — kept rather than deleted, so the next reader
 * does not re-litigate it. A 2026-09-14 read of the official page was
 * transcribed here as $3/$15, against several third-party write-ups claiming
 * Anthropic had cancelled the increase and made $2/$10 permanent. The
 * third-party claims were declined as non-authoritative, which was the right
 * procedure; the transcription was simply wrong. A 2026-09-22 read of the same
 * page shows `Claude Sonnet 5  $2 / $2.50 / $4 / $0.20 / $10`, with an explicit
 * note that the scheduled 2026-09-01 increase "will not occur".
 *
 * The error's DIRECTION was the safe one, exactly as the earlier note reasoned:
 * these rates drive a spend gate, so overestimating trips the gate early
 * (conservative) while underestimating would let real spending run past the
 * ceiling. The cost of being wrong this way was a gate tripping sooner than
 * necessary, and every LIVE run being accounted at 1.5x its real cost.
 *
 * `effectiveFrom` stays 2026-09-01 — the date these rates became the STANDARD
 * rate. The same $2/$10 numbers applied earlier as introductory pricing, so an
 * earlier `effectiveFrom` would also be numerically correct, but it would
 * require transcribing Sonnet 5's launch date, which has not been verified
 * here. The conservative bound fails loud (STALE, null cost) for an
 * observation before it rather than pricing an unverified window.
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
    validThrough: "2027-09-22",
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
