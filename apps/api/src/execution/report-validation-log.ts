import type { ReportValidationIssue } from "@opspilot/contracts";

/**
 * The only place a REPORT_SCHEMA_INVALID failure reaches the server log.
 *
 * Same one-line JSON convention as logProviderEvent, so the two are
 * greppable together. `issues` is already sanitized by
 * summarizeReportValidationIssues (packages/contracts) before this ever sees
 * it: validation issue paths, codes, expected/received type names, and this
 * codebase's own static schema bounds — never the raw report Claude
 * submitted, never a secret, never the idempotency key.
 *
 * Non-throwing as defense in depth — logging must never be able to affect
 * execution — but this is not the boundary of record: AgentRunService
 * (packages/agent-runtime) wraps every onReportSchemaInvalid call in its own
 * try/catch regardless of what a caller-supplied hook does.
 */
export function logReportValidationFailure(diagnostic: {
  readonly runId: string;
  readonly providerMode: string;
  readonly modelIdentifier: string | null;
  readonly issues: readonly ReportValidationIssue[];
}): void {
  try {
    console.log(
      JSON.stringify({
        event: "report_schema_invalid",
        runId: diagnostic.runId,
        providerMode: diagnostic.providerMode,
        model: diagnostic.modelIdentifier,
        issues: diagnostic.issues,
      }),
    );
  } catch {
    // Logging must never be able to affect execution.
  }
}
