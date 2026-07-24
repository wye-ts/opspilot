import type {
  AgentOrchestratorErrorCode,
  AgentTraceEvent,
  ApprovalDecision,
  RecordApprovalDecisionInput,
  ResolutionReport,
  TicketContext,
} from "@opspilot/contracts";

export type { ApprovalDecision, TicketContext };

export type AgentRunStatus = "RUNNING" | "COMPLETED" | "FAILED";
export type ProviderMode = "FAKE" | "LIVE";

export interface AgentJobRecord {
  readonly id: string;
  readonly ticketContext: TicketContext;
  readonly externalTicketId: string;
  readonly createdAt: string;
}

export interface AgentRunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: AgentRunStatus;
  readonly providerMode: ProviderMode;
  readonly modelIdentifier: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export type AgentRunOutcome =
  | { readonly type: "RUNNING" }
  | { readonly type: "COMPLETED"; readonly report: ResolutionReport }
  | {
      readonly type: "FAILED";
      readonly code: AgentOrchestratorErrorCode;
      readonly message: string;
    };

export interface PersistedAgentRun {
  readonly job: AgentJobRecord;
  readonly run: AgentRunRecord;
  readonly trace: readonly AgentTraceEvent[];
  readonly outcome: AgentRunOutcome;
}

// Job-summary read model: the job snapshot plus its ordered run summaries
// (attemptNumber ASC), with no trace events or reports — see
// docs/11-agent-run-persistence.md. AgentRunRecord already excludes
// report/failureCode/trace, so it is reused as-is for `runs`.
export interface PersistedAgentJob {
  readonly job: AgentJobRecord;
  readonly runs: readonly AgentRunRecord[];
}

// Returned by startRun: the AgentJob snapshot loaded from PostgreSQL under
// the same FOR UPDATE lock used to allocate attempt_number, plus the newly
// created AgentRun. This is the only source of truth for a run's ticket
// context — a caller-constructed AgentJobRecord is never accepted (see
// docs/11-agent-run-persistence.md), precisely because a caller could
// otherwise combine one job's id with another job's ticketContext.
export interface StartedAgentRun {
  readonly job: AgentJobRecord;
  readonly run: AgentRunRecord;
}

// The schema-derived type IS the single source of truth — not an
// independently maintained interface. `note` is OPTIONAL (present-or-absent),
// never `null`, exactly mirroring RecordApprovalDecisionInputSchema's parsed
// output.
export type RecordApprovalDecisionParams = RecordApprovalDecisionInput;

// Database write shape — what actually gets bound into the INSERT/comparison.
// NOT the same type as RecordApprovalDecisionParams: `note` here is
// `string | null`, never `undefined`, because SQL has no "absent" — only NULL.
export interface AgentRunApprovalWrite {
  readonly decision: ApprovalDecision;
  readonly reviewerName: string;
  readonly note: string | null;
}

// Persisted-row shape; always fully populated (decided_at is NOT NULL).
export interface AgentRunApprovalRecord {
  readonly id: string;
  readonly runId: string;
  readonly decision: ApprovalDecision;
  readonly reviewerName: string;
  readonly note: string | null;
  readonly decidedAt: Date;
}

export type AgentRunApprovalStatus = "NOT_ELIGIBLE" | "PENDING" | "APPROVED" | "REJECTED";

// GET-time (and POST-response-time) computed read model.
export interface AgentRunApprovalView {
  readonly runId: string;
  readonly status: AgentRunApprovalStatus;
  readonly reviewerName: string | null;
  readonly note: string | null;
  readonly decidedAt: Date | null;
}

export interface RecordApprovalDecisionResult {
  readonly view: AgentRunApprovalView;
  readonly outcome: "created" | "replayed";
}
