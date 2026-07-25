import type { AgentRunApprovalStatus, AgentRunApprovalView } from "@opspilot/database";

export interface AgentRunApprovalResponseData {
  readonly runId: string;
  readonly status: AgentRunApprovalStatus;
  readonly reviewerName: string | null;
  readonly note: string | null;
  readonly decidedAt: string | null;
}

// The ONLY Date -> string conversion point for approval responses — mirrors
// agent-run-response.mapper.ts's explicit-mapper convention (never a raw
// spread). view.decidedAt is a Date | null at this layer, never already a
// string, so a bare pass-through here would be a type error, not just a
// style choice.
export function mapAgentRunApprovalResponse(view: AgentRunApprovalView): AgentRunApprovalResponseData {
  return {
    runId: view.runId,
    status: view.status,
    reviewerName: view.reviewerName,
    note: view.note,
    decidedAt: view.decidedAt?.toISOString() ?? null,
  };
}
