import type { AgentRunRecord, PersistedAgentRun } from "@opspilot/database";

import { mapAgentJobResponse, type AgentJobResponseData } from "../../agent-jobs/dto/agent-job-response.mapper";
import { formatNanoUsdAsUsdString } from "../../execution/nano-usd";

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
  /**
   * A decimal USD STRING, never a JSON number.
   *
   * Money as a JSON number would be a float on every consumer, reintroducing
   * exactly the rounding the integer nanoUSD path exists to prevent. The
   * underlying value is a bigint, which `JSON.stringify` cannot serialize at all
   * — so formatting here is not optional politeness, it is the boundary that
   * makes the response representable.
   *
   * `null` means the cost is NOT KNOWN, which covers three cases: every FAKE run,
   * any LIVE run whose pricing could not be established, and any run whose
   * observed figure is only a LOWER BOUND (`possibleUnobservedCost`). Consumers
   * hide the row entirely rather than rendering "$0.00", which would assert a free
   * run that was never measured.
   */
  readonly estimatedCostUsd: string | null;
}

export interface AgentRunDetailResponseData {
  readonly job: AgentJobResponseData;
  readonly run: AgentRunResponseData;
  readonly trace: PersistedAgentRun["trace"];
  readonly outcome: PersistedAgentRun["outcome"];
}

// Maps just the run record (no job, trace, or outcome). Extracted so the
// investigation-state mapper (§3) can reuse it without duplicating the cost
// formatting logic.
export function mapAgentRunRecordResponse(run: AgentRunRecord): AgentRunResponseData {
  return {
    id: run.id,
    jobId: run.jobId,
    attemptNumber: run.attemptNumber,
    status: run.status,
    providerMode: run.providerMode,
    modelIdentifier: run.modelIdentifier,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    estimatedCostUsd:
      run.estimatedCostNanoUsd == null || run.possibleUnobservedCost
        ? null
        : formatNanoUsdAsUsdString(run.estimatedCostNanoUsd),
  };
}

// Handles both completed and failed terminal outcomes (and the RUNNING
// shape, defensively) by forwarding the outcome value as-is — it is already
// a contract-shaped union with no internal database fields. Trace is
// forwarded in the order the repository returned it (sequenceNumber ASC) —
// never re-sorted here (see docs/12-agent-run-api.md).
export function mapAgentRunResponse(persisted: PersistedAgentRun): AgentRunDetailResponseData {
  return {
    job: mapAgentJobResponse(persisted.job),
    run: mapAgentRunRecordResponse(persisted.run),
    trace: persisted.trace,
    outcome: persisted.outcome,
  };
}
