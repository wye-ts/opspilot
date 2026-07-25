import { getApprovalDecision, recordApprovalDecision } from "@opspilot/database";
import type {
  AgentRunApprovalView,
  PrismaClient,
  RecordApprovalDecisionParams,
  RecordApprovalDecisionResult,
} from "@opspilot/database";

// Thin, factory-created pass-through to @opspilot/database's own
// recordApprovalDecision/getApprovalDecision — not a class, no adapter
// layer. Must not duplicate eligibility calculation, FOR UPDATE locking,
// replay comparison, corruption-state detection, transaction logic, or
// database validation; all of that stays exclusively in packages/database
// (see docs/13-approval-workflow.md §7/§10).
export interface AgentRunApprovalService {
  recordApprovalDecision(runId: string, input: RecordApprovalDecisionParams): Promise<RecordApprovalDecisionResult>;
  getApprovalDecision(runId: string): Promise<AgentRunApprovalView>;
}

export function createAgentRunApprovalService(prisma: PrismaClient): AgentRunApprovalService {
  return {
    recordApprovalDecision: (runId, input) => recordApprovalDecision(prisma, runId, input),
    getApprovalDecision: (runId) => getApprovalDecision(prisma, runId),
  };
}
