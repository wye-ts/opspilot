import type { AgentJobRecord, AgentRunRecord, PersistedAgentJob, PersistedInvestigationState } from "@opspilot/database";

import { mapAgentRunRecordResponse, type AgentRunResponseData } from "../../agent-runs/dto/agent-run-response.mapper";

// Explicit response shapes — never a spread of the domain/database record.
// Tests assert the exact key set to prevent a future field (e.g. an
// internal database column) from silently leaking into a response.
export interface AgentJobResponseData {
  readonly id: string;
  readonly ticketId: string;
  readonly summary: string;
  readonly createdAt: string;
}

export function mapAgentJobResponse(job: AgentJobRecord): AgentJobResponseData {
  return {
    id: job.id,
    ticketId: job.ticketContext.ticketId,
    summary: job.ticketContext.summary,
    createdAt: job.createdAt,
  };
}

export interface AgentRunSummaryResponseData {
  readonly id: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly providerMode: string;
  readonly modelIdentifier: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

// No trace, report, or failure payload — this is the job-summary read
// model only (see docs/12-agent-run-api.md).
export function mapAgentRunSummaryResponse(run: AgentRunRecord): AgentRunSummaryResponseData {
  return {
    id: run.id,
    attemptNumber: run.attemptNumber,
    status: run.status,
    providerMode: run.providerMode,
    modelIdentifier: run.modelIdentifier,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

export interface AgentJobDetailResponseData extends AgentJobResponseData {
  readonly runs: readonly AgentRunSummaryResponseData[];
}

// runs are already ordered attemptNumber ASC by getAgentJob's own query — no
// re-sort here.
export function mapAgentJobDetailResponse(persisted: PersistedAgentJob): AgentJobDetailResponseData {
  return {
    ...mapAgentJobResponse(persisted.job),
    runs: persisted.runs.map(mapAgentRunSummaryResponse),
  };
}

export interface InvestigationStateResponseData {
  readonly job: AgentJobResponseData;
  readonly run: AgentRunResponseData | null;
  readonly trace: PersistedInvestigationState["trace"];
  readonly outcome: PersistedInvestigationState["outcome"];
  readonly events: PersistedInvestigationState["events"];
}

// Explicit field-by-field mapping — never a spread of the domain record.
// Tests assert the exact key set (§8 #10).
export function mapInvestigationStateResponse(
  state: PersistedInvestigationState,
): InvestigationStateResponseData {
  return {
    job: mapAgentJobResponse(state.job),
    run: state.run !== null ? mapAgentRunRecordResponse(state.run) : null,
    trace: state.trace,
    outcome: state.outcome,
    events: state.events,
  };
}
