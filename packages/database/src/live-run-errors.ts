export type LiveRunAdmissionErrorCode =
  | "LIVE_RUN_ATTEMPT_LIMIT"
  | "LIVE_RUN_BUDGET_EXHAUSTED"
  | "LIVE_RUN_CONTEXT_INVALID"
  // Issue #39 — PUBLIC trial only. Thrown when the visitor already has
  // today's row in `live_run_visitor_usage`; carries its own unambiguous
  // meaning, unlike LIVE_RUN_BUDGET_EXHAUSTED, so it needs no `reason`
  // classification (see below).
  | "LIVE_RUN_VISITOR_QUOTA_EXHAUSTED";

const MESSAGES: Record<LiveRunAdmissionErrorCode, string> = {
  LIVE_RUN_ATTEMPT_LIMIT: "The agent job has reached its live run attempt limit.",
  LIVE_RUN_BUDGET_EXHAUSTED: "The live agent run allowance for the current UTC day has been used.",
  // Says WHICH rule was not met and nothing about the offending value — no
  // stored summary, no measured length, no field name beyond the two the public
  // message already names. See the catalog entry this maps to.
  LIVE_RUN_CONTEXT_INVALID:
    "The agent job's stored ticket context does not satisfy the current live execution bounds.",
  LIVE_RUN_VISITOR_QUOTA_EXHAUSTED: "This visitor has already used today's live trial run.",
};

/**
 * Issue #39 — internal-only classification of WHY the budget reservation's
 * WHERE clause rejected a request, computed by one additional read-only
 * SELECT of the same row (same transaction) only when the reservation
 * returns zero rows. Never surfaced to the anonymous caller: the public
 * `ApiError` code stays the single opaque `LIVE_RUN_BUDGET_EXHAUSTED`
 * regardless of which of these fired. Exists purely so the internal
 * one-line-per-decision log (`logDecision`) can distinguish the six ways the
 * shared budget gate can be closed.
 *
 * Fixed precedence, first match wins: the two shared/global latches (1–2)
 * gate everything and are checked first; the overall hard limits (3–4) are
 * more fundamental than a public sub-limit, so they outrank the
 * public-specific reasons (5–6) when several are simultaneously true.
 */
export type LiveRunBudgetRejectionReason =
  | "BUDGET_LATCH_UNRECONCILED"
  | "BUDGET_PRICING_UNKNOWN"
  | "BUDGET_OVERALL_COUNT_EXHAUSTED"
  | "BUDGET_OVERALL_COST_EXHAUSTED"
  | "BUDGET_PUBLIC_COUNT_EXHAUSTED"
  | "BUDGET_PUBLIC_COST_EXHAUSTED";

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
  /**
   * Set only for `LIVE_RUN_BUDGET_EXHAUSTED` — see
   * `LiveRunBudgetRejectionReason`. Internal-only: read by the admission
   * controller's decision logger and never serialized into the public error
   * envelope (see apps/api's ApiError, which carries this error only as its
   * `cause`).
   */
  readonly reason?: LiveRunBudgetRejectionReason;

  constructor(
    code: LiveRunAdmissionErrorCode,
    options?: { cause?: unknown; reason?: LiveRunBudgetRejectionReason },
  ) {
    super(MESSAGES[code], options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LiveRunAdmissionError";
    this.code = code;
    if (options?.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}
