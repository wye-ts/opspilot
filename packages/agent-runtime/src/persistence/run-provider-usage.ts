import type { PricingStatus } from "../providers/cost-estimation";

/**
 * What one run spent, as far as it could be observed.
 *
 * Declared HERE rather than in the vendor package even though only the Claude
 * adapter can produce one. This package must not depend on
 * @opspilot/provider-claude (the dependency runs the other way), and
 * AgentRunService needs this shape to persist usage and hand it back for budget
 * reconciliation. The shape itself is vendor-neutral — token counts, an integer
 * cost, and a pricing confidence — so nothing Claude-specific leaks into the
 * runtime by declaring it here. The adapter's concrete collector satisfies it
 * structurally.
 *
 * `estimatedCostNanoUsd` is `bigint | null`, and `null` means NOT KNOWN, never
 * zero. Making that distinction representable is what stops "we could not
 * measure it" from becoming "it was free" somewhere downstream.
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
  /** True when the run may have been billed for work this summary cannot see. */
  readonly possibleUnobservedCost: boolean;
}

/**
 * The narrow view AgentRunService needs of a usage collector: it takes exactly
 * ONE snapshot and never records anything itself.
 *
 * Recording is the provider adapter's job, wired up by whoever constructs the
 * provider. Keeping `record` out of this interface is what lets the runtime own
 * the collector's lifecycle without knowing the vendor's event type.
 */
export interface AgentRunUsageCollector {
  snapshot(): RunProviderUsageSummary;
}

/**
 * How the service obtains a collector for a live run.
 *
 * A factory rather than a shared instance: each run needs its own accumulator,
 * and handing the service a pre-built one would let two runs silently share
 * counters. The service creates exactly one per live run and none at all for a
 * deterministic one.
 */
export interface AgentRunUsageHooks<TCollector extends AgentRunUsageCollector = AgentRunUsageCollector> {
  createCollector(): TCollector;
}
