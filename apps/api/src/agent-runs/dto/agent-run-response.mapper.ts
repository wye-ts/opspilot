import type { PersistedAgentRun } from "@opspilot/database";

import { mapAgentJobResponse, type AgentJobResponseData } from "../../agent-jobs/dto/agent-job-response.mapper";

export interface AgentRunResponseData {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly providerMode: string;
  readonly modelIdentifier: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface AgentRunDetailResponseData {
  readonly job: AgentJobResponseData;
  readonly run: AgentRunResponseData;
  readonly trace: PersistedAgentRun["trace"];
  readonly outcome: PersistedAgentRun["outcome"];
}

// Handles both completed and failed terminal outcomes (and the RUNNING
// shape, defensively) by forwarding the outcome value as-is — it is already
// a contract-shaped union with no internal database fields. Trace is
// forwarded in the order the repository returned it (sequenceNumber ASC) —
// never re-sorted here (see docs/12-agent-run-api.md).
export function mapAgentRunResponse(persisted: PersistedAgentRun): AgentRunDetailResponseData {
  return {
    job: mapAgentJobResponse(persisted.job),
    run: {
      id: persisted.run.id,
      jobId: persisted.run.jobId,
      attemptNumber: persisted.run.attemptNumber,
      status: persisted.run.status,
      providerMode: persisted.run.providerMode,
      modelIdentifier: persisted.run.modelIdentifier,
      startedAt: persisted.run.startedAt,
      finishedAt: persisted.run.finishedAt,
      createdAt: persisted.run.createdAt,
    },
    trace: persisted.trace,
    outcome: persisted.outcome,
  };
}
