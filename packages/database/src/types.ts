import type {
  AgentOrchestratorErrorCode,
  AgentTraceEvent,
  ResolutionReport,
} from "@opspilot/contracts";

export interface TicketContext {
  readonly ticketId: string;
  readonly summary: string;
}

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
