import type { PersistedAgentRun } from "@opspilot/database";

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
      // Two independent reasons to publish nothing.
      //
      // `== null` catches BOTH null and undefined on purpose. `null` is the
      // real domain value meaning "not known", but a run record constructed
      // before this column existed carries no property at all, and handing
      // `undefined` to the formatter would throw a 500 out of a read path.
      //
      // `possibleUnobservedCost` is the subtler one: the stored figure is real
      // but INCOMPLETE — a lower bound, not a total. A first-turn timeout stores
      // 0 while tokens may genuinely have been billed; a failure on turn two
      // stores only turn one's cost. Publishing either would state a precise
      // number that is known to be too low, and "$0.00" would go further and
      // assert the run was free. A missing row says "not known", which is exactly
      // what is true. The bound stays in PostgreSQL for audit.
      estimatedCostUsd:
        persisted.run.estimatedCostNanoUsd == null || persisted.run.possibleUnobservedCost
          ? null
          : formatNanoUsdAsUsdString(persisted.run.estimatedCostNanoUsd),
    },
    trace: persisted.trace,
    outcome: persisted.outcome,
  };
}
