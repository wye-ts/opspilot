import type { AgentTraceEvent } from "@opspilot/contracts";
import type {
  AgentJobRecord,
  AgentRunRecord,
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  LiveRunStartResult,
  PersistedAgentJob,
  PersistedAgentRun,
  ProviderMode,
  ReplayedLiveRun,
  RunProviderUsageWrite,
  StartedAgentRun,
} from "@opspilot/database";

// The narrow surface AgentRunService depends on — implemented for real by
// createPrismaAgentRunRepository (agent-run-service.ts) and, in tests, by an
// in-memory fake implementing this exact interface. Never a fake Prisma
// transaction client — see docs/11-agent-run-persistence.md.
export interface AgentRunRepositoryInterface {
  createJob(ticketContext: unknown): Promise<AgentJobRecord>;
  // Returns the AgentJob snapshot loaded from PostgreSQL under the same
  // lock used to allocate attempt_number, alongside the new AgentRun —
  // this is the only source of truth for the run's ticket context; see
  // agent-run-service.ts.
  startRun(
    jobId: string,
    providerMode: ProviderMode,
    modelIdentifier: string | null,
  ): Promise<StartedAgentRun>;
  /**
   * Creates a LIVE run, enforcing the per-job attempt limit and reserving the
   * day's budget, in ONE transaction that commits before any provider call.
   *
   * Separate from `startRun` rather than a parameterization of it: the FAKE path
   * takes no reservation, has no attempt cap, and must not pay for either. See
   * the implementation in @opspilot/database for the lock order and the
   * properties the single transaction buys.
   *
   * IDEMPOTENT ON `clientRequestId`. Repeating a key that already names a run on
   * this job returns that run as `outcome: "replayed"` — no reservation, no
   * attempt, no insert — and the caller MUST NOT execute a provider for it. That
   * discriminant, not the returned row's status, is what says which happened.
   */
  startLiveRunWithAttemptLimit(params: {
    readonly jobId: string;
    readonly modelIdentifier: string | null;
    readonly maxLiveAttempts: number;
    readonly budget: LiveRunBudgetReservationInput;
    readonly clientRequestId: string;
  }): Promise<LiveRunStartResult>;
  /**
   * Whether this key already names a LIVE run on this job — READ ONLY.
   *
   * The recovery half of idempotency, separated from `startLiveRunWithAttemptLimit`
   * so the caller can answer "does this request already exist?" BEFORE it asks
   * "may a new paid execution start?". Those are different questions, and running
   * the second one first is what made a documented 200 replay unreachable
   * whenever the day's budget, the rate window, or the concurrency slot was
   * closed — including when the request's own original attempt was what closed it.
   *
   * Takes the same AgentJob lock the creating transaction does, so it cannot read
   * past an in-flight original and wrongly conclude that nothing was created.
   * Performs no write, consumes no attempt, and takes no reservation.
   *
   * `null` means no run bears this key, which is NOT permission to start one —
   * the caller still runs every new-run gate, and the authoritative transaction
   * still rechecks the key under the lock.
   */
  replayLiveRun(params: {
    readonly jobId: string;
    readonly clientRequestId: string;
  }): Promise<ReplayedLiveRun | null>;
  // `usage` is omitted for FAKE, which is what leaves the six usage columns
  // NULL for a deterministic run. It is written in the same statement that sets
  // the terminal status — never a second update afterwards.
  finalizeCompleted(
    runId: string,
    trace: readonly AgentTraceEvent[],
    report: unknown,
    usage?: RunProviderUsageWrite,
  ): Promise<AgentRunRecord>;
  finalizeFailed(
    runId: string,
    trace: readonly AgentTraceEvent[],
    code: unknown,
    usage?: RunProviderUsageWrite,
  ): Promise<AgentRunRecord>;
  /**
   * Adds a finished run's usage to the day it RESERVED against.
   *
   * Autocommit, deliberately outside the run's finalization transaction: a run
   * that spent tokens must be accounted for even when persisting its own outcome
   * failed.
   */
  reconcileLiveRunBudget(
    reservation: LiveRunBudgetReservation,
    usage: RunProviderUsageWrite,
  ): Promise<void>;
  getAgentRun(runId: string): Promise<PersistedAgentRun>;
  getAgentJob(jobId: string): Promise<PersistedAgentJob>;
}
