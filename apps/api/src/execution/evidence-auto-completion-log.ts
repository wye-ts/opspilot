import type { EvidenceLocator } from "@opspilot/contracts";

/**
 * The only place an Issue #114 evidence auto-completion reaches the server
 * log.
 *
 * Same one-line JSON convention as logProviderEvent/logReportValidationFailure
 * /logEventEmissionFailure, so all four are greppable together. `locators` is
 * already the exact, harness-derived set of synthesized (sourceType,
 * evidenceId) pairs (packages/agent-runtime's AgentOrchestratorResult) —
 * never model-authored content, and never the model's own `finding`/
 * `supports` text for any entry, synthesized or not.
 *
 * BEST-EFFORT OBSERVABILITY ONLY, not a durable audit trail — this is the ONE
 * place this fact can be observed at all; nothing in this codebase persists
 * it to the database alongside the report (see
 * docs/reviews/44-issue-114-conditional-evidence-nonempty-plan.md §2.6/§0.6).
 * If this call is never reached (process crash between the hook firing and
 * this line, or a caller that never wires the hook at all), the fact that
 * specific entries were synthesized this run is unrecoverable — only the
 * persisted report's fixed `EVIDENCE_AUTO_COMPLETION_FINDING` literal
 * survives in the data, and that string is a human-readable hint only.
 *
 * Non-throwing as defense in depth — logging must never be able to affect
 * execution — but this is not the boundary of record: AgentRunService
 * (packages/agent-runtime) wraps every onEvidenceAutoCompleted call in its
 * own try/catch regardless of what a caller-supplied hook does.
 */
export function logEvidenceAutoCompletion(diagnostic: {
  readonly runId: string;
  readonly locators: readonly EvidenceLocator[];
}): void {
  try {
    console.log(
      JSON.stringify({
        event: "evidence_auto_completed",
        runId: diagnostic.runId,
        locators: diagnostic.locators,
      }),
    );
  } catch {
    // Logging must never be able to affect execution.
  }
}
