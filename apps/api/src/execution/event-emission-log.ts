import type { InvestigationEventEmissionDiagnostic } from "@opspilot/agent-runtime";

/**
 * The only place a canonical lifecycle-event write failure reaches the server
 * log (issue #37).
 *
 * Same one-line JSON convention as logProviderEvent and
 * logReportValidationFailure, so all three are greppable together. Every field
 * is already narrowed to a safe closed value by
 * `InvestigationEventEmissionDiagnostic` (packages/agent-runtime) before this
 * ever sees it: a run UUID, the attempted event type, the PersistenceErrorCode,
 * and — when the write was refused because the resulting stream would not have
 * reduced — the reducer's own InvestigationEventContractError code.
 *
 * Never logged: prompt text, report content, tool input or output, provider
 * responses, API keys, the database URL, the visitor token, or the internal
 * idempotency key. The underlying error's `cause` is never stringified.
 *
 * Non-throwing as defense in depth — logging must never be able to affect
 * execution — but this is not the boundary of record: AgentRunService wraps
 * every onEventEmissionFailure call in its own try/catch regardless of what a
 * caller-supplied hook does.
 */
export function logEventEmissionFailure(diagnostic: InvestigationEventEmissionDiagnostic): void {
  try {
    console.log(
      JSON.stringify({
        event: "investigation_event_emission_failed",
        runId: diagnostic.runId,
        attemptedEventType: diagnostic.attemptedEventType,
        persistenceErrorCode: diagnostic.persistenceErrorCode,
        ...(diagnostic.contractErrorCode === undefined
          ? {}
          : { contractErrorCode: diagnostic.contractErrorCode }),
      }),
    );
  } catch {
    // Logging must never be able to affect execution.
  }
}
