import type { LlmProviderErrorCategory, PricingStatus } from "@opspilot/agent-runtime";

import type { ClaudeProviderLogEvent } from "./claude-llm-provider";

/**
 * What one run actually spent, aggregated across its provider turns.
 *
 * `estimatedCostNanoUsd` is `bigint | null`, and `null` means NOT KNOWN — never
 * zero. Every consumer has to decide what to do about an unknown cost, and
 * making that a distinguishable value is what stops "we could not measure it"
 * from silently becoming "it was free".
 */
export interface RunProviderUsageSummary {
  readonly providerCallsObserved: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  readonly estimatedCostNanoUsd: bigint | null;
  readonly pricingStatus: PricingStatus;
  /**
   * True when the run may have been billed for work this summary cannot see.
   *
   * Set on any failure that could have occurred AFTER the model began
   * inference. Fail closed: a caller must be able to tell "definitely spent
   * nothing" from "possibly spent something we cannot measure", because
   * treating the second as the first is how a budget silently overruns.
   */
  readonly possibleUnobservedCost: boolean;
}

export interface RunProviderUsageCollector {
  record(event: ClaudeProviderLogEvent): void;
  snapshot(): RunProviderUsageSummary;
}

/**
 * Worst-observed-status ordering. A run's pricing confidence is only as good as
 * its least confident turn, so these are ranked and the maximum wins.
 */
const PRICING_STATUS_SEVERITY: Record<PricingStatus, number> = {
  CURRENT: 0,
  STALE: 1,
  INSUFFICIENT_USAGE_DETAIL: 2,
  UNKNOWN_MODEL: 3,
};

/**
 * Whether a terminal provider error PROVES no inference was billed.
 *
 * `true` here means the request was provably rejected before the model ran, so
 * the run definitely spent nothing on that turn. Everything else is treated as
 * possibly billed.
 *
 *   AUTHENTICATION (401/403) — rejected at the edge, no inference
 *   BILLING        (402)     — refused before work began
 *   RATE_LIMIT     (429)     — shed before admission
 *   REQUEST_INVALID(4xx)     — rejected as malformed, never dispatched
 *
 * The rest genuinely cannot be resolved from the client side:
 *
 *   CONNECTION   — the request may have arrived and been processed; the
 *                  response is what got lost
 *   TIMEOUT      — the model may well have run to completion server-side
 *   CANCELLED    — the caller aborted, but tokens already generated are billed
 *   SERVER_ERROR — a 5xx after partial generation is billable
 *   UNKNOWN      — unclassified, so no claim is possible
 */
const PROVABLY_UNBILLED_CATEGORIES: ReadonlySet<LlmProviderErrorCategory> = new Set([
  "AUTHENTICATION",
  "BILLING",
  "RATE_LIMIT",
  "REQUEST_INVALID",
]);

/**
 * Accumulates a run's real token usage and cost from the provider's own log
 * events.
 *
 * A second consumer of an existing callback, not new instrumentation:
 * ClaudeLlmProvider already accepts an injected `logger` and already emits every
 * field needed here. Parsing the structured log stream to recover these numbers
 * would be both fragile and untestable.
 *
 * Lives in this package rather than the neutral runtime because it consumes a
 * Claude-specific event type — it belongs beside the adapter that produces it.
 *
 * RETRY BLIND SPOT, and how it is now handled. With `ANTHROPIC_MAX_RETRIES > 0`,
 * a turn that fails once and succeeds on retry emits only the FINAL attempt's
 * usage. The SDK exposes no per-attempt accounting and no "did I retry?" flag, so
 * an earlier attempt that MAY have reached the provider and MAY have been billed
 * is invisible here.
 *
 * This used to be documented and then ignored: such a success was recorded with
 * `possibleUnobservedCost: false`, i.e. as an EXACT figure. That let the API
 * publish a lower bound as though it were a total, and let budget reconciliation
 * keep the cost gate open across spend nobody could see.
 *
 * The collector now refuses to make that claim — see `record`. Completeness
 * cannot be proven when retries are configured, so it is not asserted.
 *
 * Every cost this collector reports remains a LOWER BOUND in the general case.
 * The hard control — the daily run count, reserved before execution — is
 * unaffected by this, which is exactly why the run count and not the dollar
 * figure is the thing described as hard.
 */
export function createRunProviderUsageCollector(): RunProviderUsageCollector {
  let providerCallsObserved = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreation5mInputTokens = 0;
  let cacheCreation1hInputTokens = 0;

  // Starts at 0n, not null: a run with no provider call at all spent a known
  // zero. It becomes null only when a turn reports an unknown cost.
  let costNanoUsd: bigint | null = 0n;
  let pricingStatus: PricingStatus = "CURRENT";
  let possibleUnobservedCost = false;

  // Successful turns are deduplicated by the provider's own request id. The SDK
  // can surface the same response to more than one logger invocation under
  // retry bookkeeping, and double-counting a turn would overstate both tokens
  // and cost. Error events carry no request id and are counted by arrival
  // instead, which cannot double-count because the adapter emits exactly one
  // terminal event per runAgentTurn.
  const seenRequestIds = new Set<string>();

  function worsenPricingStatus(candidate: PricingStatus): void {
    if (PRICING_STATUS_SEVERITY[candidate] > PRICING_STATUS_SEVERITY[pricingStatus]) {
      pricingStatus = candidate;
    }
  }

  return {
    record(event: ClaudeProviderLogEvent): void {
      if (event.outcome === "error") {
        if (!PROVABLY_UNBILLED_CATEGORIES.has(event.terminalErrorCategory)) {
          possibleUnobservedCost = true;
        }
        return;
      }

      // A SUCCESS can still hide spend. If the SDK was configured to retry, this
      // response may be the second or third attempt, and any abandoned earlier
      // ones may have reached the provider and may have been billed without ever
      // reaching this logger. Nothing in the Messages response says whether a
      // retry happened, so "complete" is not a provable claim — and an unprovable
      // claim about money must not be made.
      //
      // Recorded BEFORE the duplicate-request-id guard on purpose: a repeated
      // event for an already-seen request id returns early below, and the
      // uncertainty must not depend on which copy of the event arrived first.
      //
      // The observed cost is still accumulated as a lower bound; it is the
      // *certainty* that is withdrawn, not the number. The DTO hides the figure
      // (see mapAgentRunResponse) and reconciliation closes the day's cost gate
      // through pricing_unknown_runs.
      if (event.configuredMaxRetries > 0) {
        possibleUnobservedCost = true;
      }

      if (seenRequestIds.has(event.providerRequestId)) {
        return;
      }
      seenRequestIds.add(event.providerRequestId);

      providerCallsObserved += 1;
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      cacheReadInputTokens += event.cacheReadInputTokens;
      cacheCreation5mInputTokens += event.cacheCreation5mInputTokens;
      cacheCreation1hInputTokens += event.cacheCreation1hInputTokens;

      worsenPricingStatus(event.pricingStatus);

      if (event.estimatedCostNanoUsd === null) {
        // One unknown turn cost makes the run's total unknown. Skipping the turn
        // instead would report a smaller number as though it were complete.
        costNanoUsd = null;
        // ...and the run is UNCERTAIN, not merely unpriced. The two were
        // previously allowed to disagree: a successful turn reporting a null cost
        // set the total to null but left possibleUnobservedCost false, persisting
        // the self-contradictory pair
        //
        //     estimatedCostNanoUsd = NULL, possibleUnobservedCost = false
        //
        // which reads as "we know this run's cost is complete, and we do not know
        // what it is". Nothing downstream was fooled — reconciliation treats a
        // null cost as unknown independently, and the DTO hides it — but the
        // persisted audit record was internally inconsistent, and any future
        // consumer trusting the flag alone would have been misled.
        //
        // A KNOWN ZERO is deliberately different: "0" is a measurement, so it
        // does not set this flag by itself.
        possibleUnobservedCost = true;
      } else if (costNanoUsd !== null) {
        // BigInt of the exact decimal string the provider emitted — never
        // reconstructed from `estimatedCostUsd`, whose float representation is
        // precisely the precision loss the nanoUSD path exists to avoid.
        costNanoUsd += BigInt(event.estimatedCostNanoUsd);
      }
    },

    snapshot(): RunProviderUsageSummary {
      return {
        providerCallsObserved,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreation5mInputTokens,
        cacheCreation1hInputTokens,
        estimatedCostNanoUsd: costNanoUsd,
        pricingStatus,
        possibleUnobservedCost,
      };
    },
  };
}
