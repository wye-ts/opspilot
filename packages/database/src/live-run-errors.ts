export type LiveRunAdmissionErrorCode =
  | "LIVE_RUN_ATTEMPT_LIMIT"
  | "LIVE_RUN_BUDGET_EXHAUSTED"
  | "LIVE_RUN_CONTEXT_INVALID";

const MESSAGES: Record<LiveRunAdmissionErrorCode, string> = {
  LIVE_RUN_ATTEMPT_LIMIT: "The agent job has reached its live run attempt limit.",
  LIVE_RUN_BUDGET_EXHAUSTED: "The live agent run allowance for the current UTC day has been used.",
  // Says WHICH rule was not met and nothing about the offending value — no
  // stored summary, no measured length, no field name beyond the two the public
  // message already names. See the catalog entry this maps to.
  LIVE_RUN_CONTEXT_INVALID:
    "The agent job's stored ticket context does not satisfy the current live execution bounds.",
};

/**
 * Kept in its own file, sibling to (never merged with) PersistenceError.
 *
 * "This job is out of attempts" and "today's allowance is used" are domain-level
 * facts discovered from perfectly valid persisted data — the database did
 * exactly what it was asked to. They are not structural operation failures, so
 * they are deliberately not PersistenceErrorCode values, exactly as
 * AgentRunApprovalError is not (see approval-errors.ts and
 * docs/13-approval-workflow.md §9).
 *
 * Keeping them separate is what lets the API map them to 429 while every real
 * PersistenceError keeps mapping to 409/500/503 — a shared code would force one
 * of those two mappings to be wrong.
 *
 * Neither message carries a limit, a count, or a remaining quota: these strings
 * are internal, but the public catalog entries they map to are equally silent
 * (see apps/api/src/errors/api-error-catalog.ts).
 */
export class LiveRunAdmissionError extends Error {
  readonly code: LiveRunAdmissionErrorCode;

  constructor(code: LiveRunAdmissionErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = "LiveRunAdmissionError";
    this.code = code;
  }
}
