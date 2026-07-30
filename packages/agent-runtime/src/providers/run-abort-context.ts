import type { AgentOrchestratorErrorCode } from "@opspilot/contracts";

/**
 * The three signals a live run is bounded by, kept separately alongside the
 * merged one that is actually handed to the provider.
 *
 * `AbortSignal.any([...])` produces a single aborted signal, and the Anthropic
 * SDK surfaces every abort identically as `APIUserAbortError` → `CANCELLED`.
 * So by the time a failure reaches persistence, the merged signal alone cannot
 * answer the only question an operator actually asks: did this run exceed its
 * budget, or did the caller walk away? Those need different responses — the
 * first is a capacity or configuration problem, the second is nobody's fault —
 * and conflating them makes a dashboard of "cancelled" runs useless.
 *
 * Keeping the two source signals lets the persistence layer recover the answer
 * without the provider ever learning what an HTTP request is.
 *
 * Deliberately provider-neutral and HTTP-free: `AbortSignal` is a platform
 * primitive, so this type lives in the neutral runtime and carries no Express,
 * response, or status-code knowledge. Constructing `disconnectSignal` from a
 * real connection is the API layer's job.
 */
export interface RunAbortContext {
  /** The merged signal forwarded to every provider turn. */
  readonly signal: AbortSignal;
  /** Fires when the run's own provider-call budget is exhausted. */
  readonly deadlineSignal: AbortSignal;
  /** Fires when the caller went away before the response completed. */
  readonly disconnectSignal: AbortSignal;
}

/**
 * Recovers why a run was aborted, given the failure code the provider path
 * already produced.
 *
 * Precedence — deadline first:
 *
 *   deadlineSignal.aborted   → PROVIDER_TIMEOUT
 *   disconnectSignal.aborted → PROVIDER_CANCELLED
 *   neither                  → unchanged
 *
 * Deadline wins a near-simultaneous race deliberately. A run that both
 * exceeded its budget and lost its client is more usefully recorded as a
 * timeout, because the timeout is the actionable fact; the disconnect is
 * usually its consequence (a caller giving up on a slow request), not an
 * independent event.
 *
 * Scope is narrow on purpose: only a code that an abort could actually have
 * produced is eligible. A run that failed on TOOL_EXECUTION_FAILED while the
 * deadline happened to expire afterwards must keep the tool failure as its
 * cause — the deadline did not produce it, and overwriting it would send an
 * operator chasing a timeout that was a symptom rather than the disease.
 */
const ABORT_DERIVED_CODES: ReadonlySet<AgentOrchestratorErrorCode> = new Set([
  "PROVIDER_CANCELLED",
  "PROVIDER_TIMEOUT",
]);

export function resolveAbortProvenance(
  code: AgentOrchestratorErrorCode,
  context: RunAbortContext | undefined,
): AgentOrchestratorErrorCode {
  if (context === undefined || !ABORT_DERIVED_CODES.has(code)) {
    return code;
  }

  if (context.deadlineSignal.aborted) {
    return "PROVIDER_TIMEOUT";
  }

  if (context.disconnectSignal.aborted) {
    return "PROVIDER_CANCELLED";
  }

  // Neither outer signal fired, so this was the transport's own timeout or
  // abort. The provider's classification is the best information available.
  return code;
}
