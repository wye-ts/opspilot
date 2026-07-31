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
  /**
   * Exact integer nanoUSD, or `null` when not known — which includes every FAKE
   * run (no provider call was made) and any LIVE run whose pricing could not be
   * established. Never zero as a stand-in for either.
   *
   * One of the two usage columns surfaced on this read model: together they are
   * what the run detail displays. The token counts and pricing status stay in the
   * database for audit rather than being carried through every read path that
   * needs a run summary.
   *
   * NOT display-ready on its own — see `possibleUnobservedCost`.
   */
  readonly estimatedCostNanoUsd: bigint | null;
  /**
   * Whether the run may have spent money this figure does not account for.
   *
   * Carried on the read model purely so the API's DTO mapper can decide what to
   * publish. When true, `estimatedCostNanoUsd` is a LOWER BOUND, not a total: a
   * first-turn timeout records 0 while real tokens may have been billed, and a
   * failure on turn two records only turn one. Presenting either as "the cost"
   * would be a specific, confident, wrong number.
   *
   * The bound itself is kept in PostgreSQL for audit — this flag is what stops it
   * from being read as a total.
   */
  readonly possibleUnobservedCost: boolean;
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

// Pricing confidence for a run's cost figure. Mirrors
// @opspilot/provider-claude's PricingStatus and the agent_runs_pricing_status_chk
// constraint; declared locally because this package must not depend on the
// provider package (module-boundary.test.ts enforces that), and the values are
// kept in agreement by schema-constraints.integration.test.ts.
export type RunPricingStatus = "CURRENT" | "STALE" | "UNKNOWN_MODEL" | "INSUFFICIENT_USAGE_DETAIL";

/**
 * What a finalizing LIVE run records about the provider work it actually did.
 *
 * `estimatedCostNanoUsd` is `bigint | null`, and `null` genuinely means "not
 * known" — never "zero". A null cost, or `possibleUnobservedCost`, closes the
 * day's cost gate rather than being reconciled as a free run.
 */
export interface RunProviderUsageWrite {
  readonly providerCallsObserved: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostNanoUsd: bigint | null;
  readonly pricingStatus: RunPricingStatus;
  readonly possibleUnobservedCost: boolean;
}

/**
 * What the caller asks the run-creation transaction to reserve.
 *
 * `budgetDate` is captured ONCE at admission and carried through to
 * reconciliation. It is never recomputed from the clock at finalization time: a
 * run reserved at 23:59:50Z and finishing at 00:00:30Z must reconcile the day it
 * reserved against, or yesterday's reservation stays permanently unreconciled
 * while today's row is credited for work it never authorized.
 */
export interface LiveRunBudgetReservationInput {
  /** "YYYY-MM-DD", UTC. */
  readonly budgetDate: string;
  readonly dailyLimit: number;
  readonly costCeilingNanoUsd: bigint;
}

// Echoed back out of the transaction that took it, so reconciliation uses the
// date the reservation was actually recorded against rather than re-deriving it.
export interface LiveRunBudgetReservation {
  readonly budgetDate: string;
  readonly runsReserved: number;
}

// Returned by startLiveRunWithAttemptLimit when it actually created a run: the
// same locked job snapshot and new run that startRun returns, plus the budget
// reservation the same transaction consumed. All three commit together or not at
// all.
export interface StartedLiveRun {
  readonly outcome: "started";
  readonly job: AgentJobRecord;
  readonly run: AgentRunRecord;
  readonly reservation: LiveRunBudgetReservation;
}

/**
 * Returned when the request's client key already names a run on this job.
 *
 * NO `reservation`, and that absence is the contract rather than an omission. A
 * replay reserved nothing, incremented nothing, and executed nothing — it only
 * read. Carrying a reservation here would invite the caller's cleanup block to
 * reconcile the day's budget a second time for a run that was already reconciled
 * by the attempt that created it, double-counting its cost.
 *
 * The `run` may be in ANY state, RUNNING included. A RUNNING replay is the
 * normal answer to the case this whole mechanism exists for: the provider
 * executed, finalization failed, and the row is still RUNNING. It is returned as
 * it stands and the caller's ordinary refresh path observes its later state.
 * Re-executing the provider because a row looks unfinished is precisely the
 * duplicate-spend this prevents.
 */
export interface ReplayedLiveRun {
  readonly outcome: "replayed";
  readonly job: AgentJobRecord;
  readonly run: AgentRunRecord;
}

/**
 * Started versus replayed, stated EXPLICITLY on a discriminant.
 *
 * Deliberately not inferred by the caller from row status, attempt number, or a
 * null reservation. Those are all correlated with a replay without meaning one,
 * and every place that guessed would have to guess the same way forever. One
 * discriminated union, decided by the only code that knows.
 */
export type LiveRunStartResult = StartedLiveRun | ReplayedLiveRun;

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
