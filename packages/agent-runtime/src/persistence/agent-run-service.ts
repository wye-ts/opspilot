import {
  createJob as dbCreateJob,
  finalizeCompleted as dbFinalizeCompleted,
  finalizeFailed as dbFinalizeFailed,
  getAgentJob as dbGetAgentJob,
  getAgentRun as dbGetAgentRun,
  PersistenceError,
  reconcileLiveRunBudget as dbReconcileLiveRunBudget,
  startLiveRunWithAttemptLimit as dbStartLiveRunWithAttemptLimit,
  startRun as dbStartRun,
  type AgentJobRecord,
  type LiveRunBudgetReservation,
  type LiveRunBudgetReservationInput,
  type PersistedAgentJob,
  type PersistedAgentRun,
  type PrismaClient,
  type ProviderMode,
  type RunProviderUsageWrite,
  type StartedAgentRun,
} from "@opspilot/database";

import {
  runAgentOrchestrator,
  type AgentOrchestratorParams,
  type AgentOrchestratorResult,
} from "../agent/agent-orchestrator";
import type { AgentConversationMessage, LlmProvider } from "../providers/llm-provider";
import { resolveAbortProvenance, type RunAbortContext } from "../providers/run-abort-context";
import { AgentRunConfigurationError, AgentRunServiceError } from "./agent-run-service-error";
import type { AgentRunRepositoryInterface } from "./agent-run-repository-interface";
import type {
  AgentRunUsageCollector,
  AgentRunUsageHooks,
  RunProviderUsageSummary,
} from "./run-provider-usage";

// @opspilot/database's index.ts exports PersistenceError as BOTH a plain-const
// value and a local `export type PersistenceError = InstanceType<typeof _PersistenceError>`
// alias (see that file's comment). This is an ordinary named import — not a
// destructured default import — so the bare name `PersistenceError` resolves
// correctly in both a value position (`new PersistenceError(...)`,
// `error instanceof PersistenceError`) and a type position (`readonly error:
// PersistenceError`) without any InstanceType<typeof X> workaround.

// The real, Prisma-backed implementation of AgentRunRepositoryInterface —
// a thin adapter binding @opspilot/database's free functions to one
// PrismaClient. This is the one place packages/database's repository
// functions and apps/worker's orchestrator are wired together.
export function createPrismaAgentRunRepository(prisma: PrismaClient): AgentRunRepositoryInterface {
  return {
    createJob: (ticketContext) => dbCreateJob(prisma, ticketContext),
    startRun: (jobId, providerMode, modelIdentifier) =>
      dbStartRun(prisma, jobId, providerMode, modelIdentifier),
    startLiveRunWithAttemptLimit: (params) => dbStartLiveRunWithAttemptLimit(prisma, params),
    finalizeCompleted: (runId, trace, report, usage) =>
      dbFinalizeCompleted(prisma, runId, trace, report, usage),
    finalizeFailed: (runId, trace, code, usage) => dbFinalizeFailed(prisma, runId, trace, code, usage),
    reconcileLiveRunBudget: (reservation, usage) =>
      dbReconcileLiveRunBudget(prisma, reservation, usage),
    getAgentRun: (runId) => dbGetAgentRun(prisma, runId),
    getAgentJob: (jobId) => dbGetAgentJob(prisma, jobId),
  };
}

/**
 * Narrows an observed usage summary to what the database stores.
 *
 * The summary carries cache-token breakdowns the schema deliberately does not:
 * they are useful in a log line but would be four more columns nobody queries.
 * Cost and the two headline token counts are what the budget and the audit need.
 */
function toUsageWrite(summary: RunProviderUsageSummary): RunProviderUsageWrite {
  return {
    providerCallsObserved: summary.providerCallsObserved,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    estimatedCostNanoUsd: summary.estimatedCostNanoUsd,
    pricingStatus: summary.pricingStatus,
    possibleUnobservedCost: summary.possibleUnobservedCost,
  };
}

// Callers supply only jobId — never a job object or a ticket context.
// AgentJobRecord is a public structural interface; accepting a
// caller-constructed one here would let a caller combine one job's id with
// a different job's ticketContext, storing the resulting AgentRun under
// the wrong AgentJob while investigating an unrelated ticket. The real
// ticket context is loaded from PostgreSQL by repository.startRun, under
// the same row lock used to allocate attempt_number — see
// docs/11-agent-run-persistence.md.
//
// createProvider replaces a plain `provider` field: it is invoked with the
// exact AgentJobRecord repository.startRun returns (see executeAndPersist
// below), so a provider parameterized by the ticket being investigated
// (e.g. a deterministic scenario derived from the real ticket summary) can
// be constructed from that one authoritative, locked read — never from a
// second, separately-timed read that could in principle observe different
// data.
export interface ExecuteAndPersistParams<
  TCollector extends AgentRunUsageCollector = AgentRunUsageCollector,
> extends Omit<AgentOrchestratorParams, "initialConversation" | "provider"> {
  readonly jobId: string;
  readonly providerMode: ProviderMode;
  /**
   * Receives the collector this service created for a LIVE run, so the caller
   * can wire it into the provider it builds. Absent for FAKE, which creates no
   * collector at all.
   *
   * The collector type is a parameter so the caller's callback sees its own
   * concrete collector (with its vendor-specific `record`) rather than this
   * package's narrow snapshot-only view. TypeScript infers it from `usageHooks`.
   */
  readonly createProvider: (job: AgentJobRecord, collector?: TCollector) => LlmProvider;
  readonly modelIdentifier?: string | null;
  /**
   * REQUIRED, all three, when `providerMode` is `"LIVE"`; FORBIDDEN, all three,
   * otherwise. Optional in the type only because a FAKE call must be able to omit
   * them — `resolveLiveInputs` enforces the real rule at runtime, before any
   * repository call.
   *
   * They travel together because none of them is meaningful alone — a budget
   * reservation with no attempt limit, or usage hooks with no reservation to
   * reconcile against, would each be a half-configured live run.
   */
  readonly usageHooks?: AgentRunUsageHooks<TCollector>;
  readonly liveAttemptLimit?: number;
  readonly budgetReservationInput?: LiveRunBudgetReservationInput;
  /**
   * Supplied for a LIVE run so the persisted failure code can distinguish "ran
   * out of time" from "caller went away" — the merged signal alone cannot,
   * because the SDK reports both as a user abort. See resolveAbortProvenance.
   *
   * When supplied, `abortContext.signal` — not the bare `signal` (inherited
   * from AgentOrchestratorParams) — is the signal that actually reaches the
   * provider; the same context is also kept around to resolve deadline/
   * disconnect provenance at finalization. Bare `signal` remains the fallback
   * for legacy/internal callers with no RunAbortContext to supply. The API
   * controller passes only `abortContext`.
   */
  readonly abortContext?: RunAbortContext;
}

/**
 * The union is EXTENDED with usage/reservation rather than replaced by a flat
 * `{ run, usageSummary }`. The `unavailable` variants are what the API maps to
 * 503/409 via mapDomainError; collapsing them into one shape would silently drop
 * that error contract.
 *
 * `usageSummary` and `reservation` are `null` for a FAKE run, which has neither.
 */
export type ExecuteAndPersistResult =
  | {
      readonly persistence: "persisted";
      readonly run: PersistedAgentRun;
      readonly usageSummary: RunProviderUsageSummary | null;
      readonly reservation: LiveRunBudgetReservation | null;
    }
  // Failure before any AgentRun row exists — no runId to retry against, and no
  // provider call happened, so there is nothing to reconcile either.
  | { readonly persistence: "unavailable"; readonly stage: "run-creation"; readonly error: PersistenceError }
  // The agent produced a real AgentOrchestratorResult, but persisting the
  // terminal outcome failed. runId + agentResult are both included so the
  // caller can retry via retryFinalization (see its durability limit below).
  //
  // Provider calls DID happen here, so usage and reservation ride along: the
  // budget must still be reconciled even though the run's own row could not be
  // finalized. Dropping them would mean a run that spent money went unaccounted.
  | {
      readonly persistence: "unavailable";
      readonly stage: "finalization";
      readonly runId: string;
      readonly agentResult: AgentOrchestratorResult;
      readonly error: PersistenceError;
      readonly usageSummary: RunProviderUsageSummary | null;
      readonly reservation: LiveRunBudgetReservation | null;
    };

/**
 * The three inputs a LIVE run cannot execute without, resolved together.
 *
 * `null` is the FAKE answer, and it is a different thing from "some inputs were
 * missing" — which is an error, not a mode.
 */
interface LiveExecutionInputs<TCollector extends AgentRunUsageCollector> {
  readonly usageHooks: AgentRunUsageHooks<TCollector>;
  readonly liveAttemptLimit: number;
  readonly budgetReservationInput: LiveRunBudgetReservationInput;
}

/**
 * Decides the execution path from `providerMode` ALONE, and refuses anything
 * inconsistent with it.
 *
 * The previous rule inferred "this is a live run" from the accidental presence
 * of all three live inputs. That made a partially-configured LIVE call succeed
 * QUIETLY on the ordinary `startRun` path: a `providerMode: "LIVE"` request that
 * lost, say, `budgetReservationInput` in a refactor would have run against the
 * real provider with no per-job attempt limit, no daily budget reservation, no
 * usage collector, and no usage persistence — every spend safeguard disabled at
 * once, with a successful 201 and a row marked LIVE to show for it. The failure
 * mode of a missing safeguard must never be "spend anyway".
 *
 * So the declared mode is authoritative and the inputs must agree with it:
 *
 *   FAKE  → no live input is permitted → startRun, no collector
 *   LIVE  → all three are required     → startLiveRunWithAttemptLimit, one collector
 *
 * Both directions are enforced. Rejecting live inputs on a FAKE run matters as
 * much as requiring them on a LIVE one: a FAKE call carrying a budget
 * reservation is a caller that believes it asked for something it did not get,
 * and silently ignoring the extra inputs would let that belief stand.
 *
 * Called BEFORE the first repository call, so a rejected combination creates no
 * AgentRun row, consumes no reservation, and builds no provider.
 */
function resolveLiveInputs<TCollector extends AgentRunUsageCollector>(
  params: ExecuteAndPersistParams<TCollector>,
): LiveExecutionInputs<TCollector> | null {
  const { usageHooks, liveAttemptLimit, budgetReservationInput } = params;
  const present = {
    usageHooks: usageHooks !== undefined,
    liveAttemptLimit: liveAttemptLimit !== undefined,
    budgetReservationInput: budgetReservationInput !== undefined,
  };
  const names = (wanted: boolean) =>
    Object.entries(present)
      .filter(([, supplied]) => supplied === wanted)
      .map(([name]) => name)
      .join(", ");

  if (params.providerMode !== "LIVE") {
    if (present.usageHooks || present.liveAttemptLimit || present.budgetReservationInput) {
      throw new AgentRunConfigurationError(
        `executeAndPersist: providerMode "${params.providerMode}" does not accept live-only inputs (${names(true)}).`,
      );
    }
    return null;
  }

  // Re-tested individually rather than via the booleans above so TypeScript
  // narrows each field — this is what makes the returned object's non-optional
  // types real rather than asserted.
  if (usageHooks === undefined || liveAttemptLimit === undefined || budgetReservationInput === undefined) {
    throw new AgentRunConfigurationError(
      `executeAndPersist: providerMode "LIVE" requires every live safeguard input (missing: ${names(false)}).`,
    );
  }

  return { usageHooks, liveAttemptLimit, budgetReservationInput };
}

/**
 * What a retry needs to finalize a run whose first finalization rolled back.
 *
 * An object, replacing the old positional `(runId, agentResult)` — and
 * `usageSummary` is REQUIRED rather than optional, which is the entire point.
 * The original call already measured the run's tokens and cost, persisted
 * nothing (the transaction rolled back), and reconciled the day's budget from
 * those measured figures. A retry that could omit the summary would finalize the
 * run with NULL usage columns while the budget row said it cost money — the
 * audit trail and the ledger disagreeing about the same run, silently.
 *
 * Making it required means dropping the usage has to be written down as
 * `usageSummary: null`, which is exactly the right amount of friction: that IS
 * the correct value for a FAKE retry, and an obvious mistake anywhere else.
 */
export interface RetryFinalizationParams {
  readonly runId: string;
  /**
   * The ORIGINAL result, with abort provenance already resolved by the first
   * attempt — see resolveAgentResultAbortProvenance. A retry re-derives nothing.
   */
  readonly agentResult: AgentOrchestratorResult;
  /**
   * The authoritative snapshot taken by the original attempt, or `null` for a run
   * that has no usage to preserve. Never re-snapshotted: the collector belongs to
   * an execution that already finished, and a second reading of it could differ
   * from the one the budget was reconciled against.
   */
  readonly usageSummary: RunProviderUsageSummary | null;
}

export interface AgentRunService {
  createAgentJob(ticketContext: unknown): Promise<AgentJobRecord>;
  executeAndPersist<TCollector extends AgentRunUsageCollector = AgentRunUsageCollector>(
    params: ExecuteAndPersistParams<TCollector>,
  ): Promise<ExecuteAndPersistResult>;
  // retryFinalization is caller-controlled, in-memory retry ONLY, valid
  // while the original AgentOrchestratorResult is still held by the calling
  // process. It handles a failed finalization call and an uncertain
  // post-commit connection failure via the exact-replay contract (see
  // packages/database's finalizeCompleted/finalizeFailed) — never
  // allocating a new attempt. It does NOT support process restart, loss of
  // the in-memory AgentOrchestratorResult, durable resumption, or orphaned
  // RUNNING-row recovery; those remain deferred to a future reaper/recovery
  // milestone. This is explicitly not process-restart-safe resumption — see
  // docs/11-agent-run-persistence.md.
  retryFinalization(params: RetryFinalizationParams): Promise<ExecuteAndPersistResult>;
  /**
   * Adds a finished live run's usage to the day it RESERVED against.
   *
   * Exposed on the service (a thin pass-through to the repository) so the API
   * controller does not need a second injected dependency purely for cleanup.
   * Deliberately NOT folded into executeAndPersist: reconciliation has to happen
   * in the caller's cleanup block, where it can be made unable to affect either
   * the HTTP response or the concurrency lease release.
   */
  reconcileLiveRunBudget(
    reservation: LiveRunBudgetReservation,
    usage: RunProviderUsageSummary,
  ): Promise<void>;
  getAgentRun(runId: string): Promise<PersistedAgentRun>;
  getAgentJob(jobId: string): Promise<PersistedAgentJob>;
}

/**
 * Resolves abort provenance exactly once, against the complete
 * `AgentOrchestratorResult`, before any persistence is attempted.
 *
 * This must happen before `finalize`'s try/catch, not inside it. `finalize`
 * can fail with a transient `PersistenceError`, in which case it returns the
 * `persistence: "unavailable", stage: "finalization"` variant carrying the
 * SAME `agentResult` object back to the caller for `retryFinalization`. If
 * provenance were instead derived only in the value passed to
 * `repository.finalizeFailed(...)`, that returned `agentResult` would still
 * carry the ORIGINAL orchestrator code — so a retry (which has no
 * `RunAbortContext` to re-derive provenance from) would persist whatever the
 * provider adapter first reported (e.g. `PROVIDER_CANCELLED`) even when the
 * deadline had actually fired (`PROVIDER_TIMEOUT`) on the very first attempt.
 * A transient database failure must never be able to change the terminal
 * failure code — resolving once, up front, is what makes that impossible by
 * construction rather than by discipline.
 */
function resolveAgentResultAbortProvenance(
  result: AgentOrchestratorResult,
  context: RunAbortContext | undefined,
): AgentOrchestratorResult {
  if (result.status === "completed") return result;

  const code = resolveAbortProvenance(result.code, context);
  return code === result.code ? result : { ...result, code };
}

async function finalize(
  repository: AgentRunRepositoryInterface,
  runId: string,
  agentResult: AgentOrchestratorResult,
  usageSummary: RunProviderUsageSummary | null = null,
  reservation: LiveRunBudgetReservation | null = null,
): Promise<ExecuteAndPersistResult> {
  // Derived once from the single snapshot, so the value written to agent_runs
  // and the value the caller reconciles the budget from are the same object's
  // projection — identical by construction, not by matching code paths.
  const usage = usageSummary === null ? undefined : toUsageWrite(usageSummary);

  try {
    if (agentResult.status === "completed") {
      await repository.finalizeCompleted(runId, agentResult.trace, agentResult.report, usage);
    } else {
      // agentResult.code is already the resolved terminal code — see
      // resolveAgentResultAbortProvenance, called once by executeAndPersist
      // before this function is ever reached. finalize itself resolves
      // nothing: doing so here would mean re-deriving provenance on every
      // retry, using whatever context that retry call happens to supply
      // (retryFinalization supplies none at all).
      await repository.finalizeFailed(runId, agentResult.trace, agentResult.code, usage);
    }
    return {
      persistence: "persisted",
      run: await repository.getAgentRun(runId),
      usageSummary,
      reservation,
    };
  } catch (error) {
    if (error instanceof PersistenceError) {
      // Usage and reservation ride along so the caller can still reconcile the
      // budget for a run that spent tokens but could not be finalized.
      return {
        persistence: "unavailable",
        stage: "finalization",
        runId,
        agentResult,
        error,
        usageSummary,
        reservation,
      };
    }
    throw error;
  }
}

export function createAgentRunService(repository: AgentRunRepositoryInterface): AgentRunService {
  return {
    createAgentJob: (ticketContext) => repository.createJob(ticketContext),

    async executeAndPersist(params) {
      // FIRST, before any repository call: the declared providerMode decides the
      // path, and the supplied inputs must agree with it or nothing runs at all.
      // See resolveLiveInputs for why inferring the mode from the inputs was
      // unsafe.
      const live = resolveLiveInputs(params);

      let started: StartedAgentRun;
      let reservation: LiveRunBudgetReservation | null = null;
      try {
        if (live !== null) {
          // The atomic path: locks the job, enforces the per-job live attempt
          // limit, reserves the day's budget, and inserts the run — then
          // COMMITS, before any provider call below.
          const startedLive = await repository.startLiveRunWithAttemptLimit({
            jobId: params.jobId,
            modelIdentifier: params.modelIdentifier ?? null,
            maxLiveAttempts: live.liveAttemptLimit,
            budget: live.budgetReservationInput,
          });
          started = { job: startedLive.job, run: startedLive.run };
          reservation = startedLive.reservation;
        } else {
          started = await repository.startRun(
            params.jobId,
            params.providerMode,
            params.modelIdentifier ?? null,
          );
        }
      } catch (error) {
        if (error instanceof PersistenceError) {
          return { persistence: "unavailable", stage: "run-creation", error };
        }
        // A LiveRunAdmissionError (attempt limit / budget exhausted) is a domain
        // rejection, not a persistence failure, and propagates to the caller
        // unchanged so it can become a 429 rather than a 503.
        throw error;
      }

      // Exactly ONE collector per live run, created here and nowhere else. The
      // service owns its whole lifecycle — creation, wiring, the single
      // snapshot, and persistence — because only the service is in a position to
      // write what it observed in the same statement that finalizes the run.
      // A controller-owned collector could only hand its numbers back after
      // finalization, which would mean a second update.
      //
      // FAKE creates none at all.
      const collector = live === null ? undefined : live.usageHooks.createCollector();

      // The initial conversation is derived exclusively from the AgentJob
      // snapshot startRun loaded from PostgreSQL under its row lock — never
      // from any caller-supplied value, since the caller supplied only
      // jobId — so the agent can never investigate a ticket other than the
      // one the locked AgentJob row actually carries.
      const ticketContextMessage: AgentConversationMessage = {
        role: "ticket_context",
        ticketId: started.job.ticketContext.ticketId,
        summary: started.job.ticketContext.summary,
      };

      // A single signal source. `abortContext.signal` — when supplied — is
      // ALREADY the merged deadline/disconnect signal (see
      // createRunAbortHandles), so it takes precedence over a bare `signal`.
      // Plain `signal` remains for callers that supply no RunAbortContext at
      // all (apps/worker's demo scripts, and any other caller that only
      // wants cancellation with no abort-provenance tracking).
      //
      // Deriving exactly one effective signal here — rather than letting a
      // caller pass both `signal` and `abortContext` as independent values —
      // is what makes it impossible for the provider to be cancelled by one
      // signal while finalization resolves provenance from a different one.
      // The API controller supplies only `abortContext`; nothing in this
      // codebase constructs both from unrelated sources.
      const effectiveSignal = params.abortContext?.signal ?? params.signal;

      // runAgentOrchestrator remains completely unchanged and persistence-free
      // (see agent-orchestrator.ts) — this is Option A, persist-after: the
      // orchestrator runs fully in memory before any trace/outcome is written.
      //
      // createProvider(started.job) runs INSIDE this same try/catch — a
      // factory failure is indistinguishable, from the caller's perspective,
      // from an orchestrator crash: both leave the run RUNNING and both
      // surface only as AgentRunServiceError("AGENT_EXECUTION_CRASHED",
      // started.run.id), never a raw error.
      let agentResult: AgentOrchestratorResult;
      try {
        const provider = params.createProvider(started.job, collector);
        agentResult = await runAgentOrchestrator({
          provider,
          toolRegistry: params.toolRegistry,
          initialConversation: [ticketContextMessage],
          // Conditional spreads — exactOptionalPropertyTypes:true means an
          // optional property must be either fully absent or a real value,
          // never an explicit `undefined`; AgentOrchestratorParams's
          // optional fields do not include `| undefined` in their declared
          // type, so unconditionally forwarding params.X (which may itself
          // be undefined) would fail to typecheck.
          ...(params.allowedRagChunkIds !== undefined ? { allowedRagChunkIds: params.allowedRagChunkIds } : {}),
          ...(params.retriever !== undefined ? { retriever: params.retriever } : {}),
          ...(params.retrievalInput !== undefined ? { retrievalInput: params.retrievalInput } : {}),
          ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
          // Scope: this reaches the provider turns only; tool, retrieval, and
          // persistence cancellation are not wired in this milestone.
          ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        });
      } catch (rawError) {
        // Not a PersistenceError (persistence worked correctly up to this
        // point). Not an AgentOrchestratorErrorCode (this is not an
        // agent-domain decision). Not returned inside ExecuteAndPersistResult
        // — thrown instead, since there is nothing structured to hand back.
        // The run row stays RUNNING; recovery is deferred (see class doc).
        //
        // The crash still carries whatever spend was already established, so the
        // caller's cleanup can reconcile the budget. A crash after a provider
        // call would otherwise leak the reservation and understate the day's
        // spend — the run cost real money whether or not it crashed. This context
        // is internal and is never serialized into a response.
        throw new AgentRunServiceError("AGENT_EXECUTION_CRASHED", started.run.id, {
          cause: rawError,
          executionContext: {
            usageSummary: collector?.snapshot() ?? null,
            reservation,
          },
        });
      }

      // Resolved once, here, before finalize is ever called — see
      // resolveAgentResultAbortProvenance for why this must not move inside
      // finalize or be re-derived on retry.
      const resolvedResult = resolveAgentResultAbortProvenance(agentResult, params.abortContext);

      // EXACTLY ONE snapshot per run, taken here. Every consumer — the
      // agent_runs columns, the returned summary, and the caller's budget
      // reconciliation — reads this same value, so the persisted cost and the
      // reconciled cost are identical by construction rather than by two code
      // paths happening to agree. A second snapshot could differ from the first
      // if any event arrived between them.
      const usageSummary = collector?.snapshot() ?? null;

      return finalize(repository, started.run.id, resolvedResult, usageSummary, reservation);
    },

    /**
     * Finalizes with the ORIGINAL attempt's usage, and reconciles nothing.
     *
     * Two different decisions that used to look like one. The old signature took
     * no usage at all, and the comment justified it as "a retry has no collector
     * to snapshot" — true, and the reason it must be PASSED IN rather than
     * re-measured. But the code then wrote NULL usage columns, so a run whose
     * first finalization rolled back was recorded as having cost nothing, while
     * the day's budget row had already been reconciled from the measured figures.
     *
     * `usageSummary` therefore travels with the retry: same snapshot, same
     * projection through toUsageWrite, same numbers the budget already saw.
     *
     * `reservation` stays null, and that is still correct — it is what tells the
     * caller's cleanup block there is nothing to reconcile. The first attempt
     * reconciled the budget from these exact figures whether or not its
     * finalization transaction committed; doing it again would double-count the
     * run's cost. Persisting the usage and re-reconciling it are independent, and
     * only the first is a retry's job.
     */
    retryFinalization: ({ runId, agentResult, usageSummary }) =>
      finalize(repository, runId, agentResult, usageSummary),

    reconcileLiveRunBudget: (reservation, usage) =>
      // Narrowed through the same toUsageWrite the persistence path uses, so the
      // reconciled figures and the stored figures are the same projection of the
      // same snapshot.
      repository.reconcileLiveRunBudget(reservation, toUsageWrite(usage)),

    getAgentRun: (runId) => repository.getAgentRun(runId),
    getAgentJob: (jobId) => repository.getAgentJob(jobId),
  };
}
