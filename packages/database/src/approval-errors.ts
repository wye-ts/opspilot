export type AgentRunApprovalErrorCode = "RUN_NOT_APPROVAL_ELIGIBLE" | "APPROVAL_ALREADY_DECIDED";

const MESSAGES: Record<AgentRunApprovalErrorCode, (runId: string) => string> = {
  RUN_NOT_APPROVAL_ELIGIBLE: (runId) => `AgentRun ${runId} is not approval-eligible.`,
  APPROVAL_ALREADY_DECIDED: (runId) =>
    `AgentRun ${runId} already has a recorded approval decision that does not match this request.`,
};

// Kept in its own file, sibling to (never merged with) PersistenceError —
// "not eligible" and "already decided" are domain-level facts discovered
// from persisted data, not structural database-operation failures, so they
// are deliberately not PersistenceErrorCode values (see
// docs/13-approval-workflow.md §9).
export class AgentRunApprovalError extends Error {
  readonly code: AgentRunApprovalErrorCode;
  readonly runId: string;

  constructor(code: AgentRunApprovalErrorCode, runId: string, options?: { cause?: unknown }) {
    super(MESSAGES[code](runId), options);
    this.name = "AgentRunApprovalError";
    this.code = code;
    this.runId = runId;
  }
}
