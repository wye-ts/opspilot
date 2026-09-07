import {
  appendInvestigationEvent as dbAppendInvestigationEvent,
  createJob as dbCreateJob,
  finalizeCompleted as dbFinalizeCompleted,
  finalizeFailed as dbFinalizeFailed,
  getAgentJob as dbGetAgentJob,
  getAgentRun as dbGetAgentRun,
  getInvestigationState as dbGetInvestigationState,
  PersistenceError,
  reconcileLiveRunBudget as dbReconcileLiveRunBudget,
  replayLiveRun as dbReplayLiveRun,
  startLiveRunWithAttemptLimit as dbStartLiveRunWithAttemptLimit,
  startRun as dbStartRun,
  type AgentJobRecord,
  type LiveRunBudgetReservation,
  type LiveRunBudgetReservationInput,
  type PersistedAgentJob,
  type PersistedAgentRun,
  type PersistedInvestigationState,
  type PersistenceErrorCode,
  type PrismaClient,
  type ProviderMode,
  type PublicTrialReservationInput,
  type RunProviderUsageWrite,
  type StartedAgentRun,
} from "@opspilot/database";

import {
  InvestigationEventContractError,
  type InvestigationEventContractErrorCode,
  type InvestigationEventPayload,
  type ReportValidationIssue,
} from "@opspilot/contracts";

import {
  runAgentOrchestrator,
  type AgentOrchestratorParams,
  type AgentOrchestratorResult,
} from "../agent/agent-orchestrator";
import type { AgentConversationMessage, LlmProvider } from "../providers/llm-provider";
import { resolveAbortProvenance, type RunAbortContext } from "../providers/run-abort-context";
import type { RetrievalInput } from "../rag/runbook-retriever";
import {
  AgentRunConfigurationError,
  AgentRunServiceError,
  InvestigationEventEmissionError,
} from "./agent-run-service-error";
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
    replayLiveRun: (params) => dbReplayLiveRun(prisma, params),
    appendInvestigationEvent: (runId, payload) => dbAppendInvestigationEvent(prisma, runId, payload),
    finalizeCompleted: (runId, report, usage) => dbFinalizeCompleted(prisma, runId, report, usage),
    finalizeFailed: (runId, code, failedStage, usage) =>
      dbFinalizeFailed(prisma, runId, code, failedStage, usage),
    reconcileLiveRunBudget: (reservation, usage) =>
      dbReconcileLiveRunBudget(prisma, reservation, usage),
    getAgentRun: (runId) => dbGetAgentRun(prisma, runId),
    getAgentJob: (jobId) => dbGetAgentJob(prisma, jobId),
    getInvestigationState: (jobId) => dbGetInvestigationState(prisma, jobId),
  };
}

/**
 * The `cause` of an `InvestigationEventEmissionError` is whatever
 * `appendInvestigationEvent` threw. Every failure path in that function
 * already normalizes through `normalizeDatabaseError`, so a `PersistenceError`
 * is what actually arrives — but the type is `unknown`, and silently casting
 * would let a future non-normalized throw reach the API's error mapper as
 * something it cannot classify. Anything unexpected becomes a fixed
 * PERSISTENCE_UNAVAILABLE rather than being passed through raw.
 */
function toPersistenceError(cause: unknown): PersistenceError {
  if (cause instanceof PersistenceError) return cause;
  return new PersistenceError(
    "PERSISTENCE_UNAVAILABLE",
    "Canonical investigation event persistence failed.",
    { cause },
  );
}

/**
 * The sanitized facts a caller may log about a canonical-ledger write failure.
 *
 * Every field is a UUID, a closed enum member, or absent. Deliberately
 * absent: prompt text, report content, tool input/output, provider responses,
 * API keys, the database URL, and any visitor token — the underlying `cause`
 * is never stringified here, only inspected for its closed `code`.
 *
 * This package does no logging of its own (see `onReportSchemaInvalid` for the
 * identical precedent): it hands the caller a safe, already-narrowed
 * diagnostic and lets `apps/api` decide how to emit it.
 */
export interface InvestigationEventEmissionDiagnostic {
  readonly runId: string;
  readonly attemptedEventType: InvestigationEventPayload["type"];
  readonly persistenceErrorCode: PersistenceErrorCode;
  /**
   * The reducer's own closed contract-error code, present ONLY when the
   * cause chain contains a genuine `InvestigationEventContractError` (see
   * `buildEmissionDiagnostic` below) — never an arbitrary string that merely
   * happens to occupy a `.code` property.
   */
  readonly contractErrorCode?: InvestigationEventContractErrorCode;
}

/**
 * Walks a standard `Error.cause` chain looking for a genuine
 * `InvestigationEventContractError`, proven by `instanceof` — never by shape.
 *
 * The real production chain is exactly one level deep
 * (`appendInvestigationEvent`'s `PersistenceError.cause` is the reducer's own
 * throw), but the walk is not hard-coded to that depth: an intermediate
 * wrapper anywhere in the chain must not hide a genuine contract error, and
 * conversely nothing that is merely `instanceof Error` — a raw driver
 * failure, a hand-built object with a matching-looking `.code` string — is
 * ever mistaken for one. Bounded defensively against a pathological or
 * cyclic chain; no genuine error in this codebase nests anywhere near this
 * deep.
 */
// InstanceType<typeof X>, not the bare name, because @opspilot/contracts
// re-exports InvestigationEventContractError as a plain `const` (the
// package's TS2323-avoidance pattern for every error class it exports — see
// PersistenceError's identical treatment in @opspilot/database), which
// occupies only the value namespace and is not usable as a type by name.
function findGenuineContractError(
  value: unknown,
): InstanceType<typeof InvestigationEventContractError> | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof InvestigationEventContractError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function buildEmissionDiagnostic(
  error: InvestigationEventEmissionError,
): InvestigationEventEmissionDiagnostic {
  const cause = error.cause;
  const persistenceErrorCode: PersistenceErrorCode =
    cause instanceof PersistenceError ? cause.code : "PERSISTENCE_UNAVAILABLE";

  // `contractErrorCode` is populated ONLY when (a) the repository's own code
  // for a reducer refusal is present, AND (b) the cause chain beneath it
  // genuinely contains an `InvestigationEventContractError` (Codex Phase B
  // review, finding M2). Without both, an arbitrary driver/adapter error
  // whose thrown value happens to carry a string-shaped `.code` (a raw
  // PostgreSQL/Prisma code such as "23505", or unbounded text from a future
  // custom adapter) could be logged as though it were this closed,
  // safe-to-log value — the exact trust-boundary failure this field exists
  // to prevent. `instanceof` is reliable here: this package and
  // @opspilot/database both resolve the same single workspace copy of
  // @opspilot/contracts, exactly like the existing
  // `cause instanceof PersistenceError` check above.
  const contractErrorCode =
    persistenceErrorCode === "PERSISTENCE_EVENT_STREAM_INVALID" && cause instanceof PersistenceError
      ? findGenuineContractError(cause.cause)?.code
      : undefined;

  return {
    runId: error.runId,
    attemptedEventType: error.attemptedEventType,
    persistenceErrorCode,
    ...(contractErrorCode === undefined ? {} : { contractErrorCode }),
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
   * Issue #72 §2.2 (round-2 review correction): resolved into a concrete
   * `retrievalInput` HERE, immediately after `started.job` becomes available
   * — the same authoritative locked read this method already performs —
   * never inside the orchestrator. `AgentOrchestratorParams.retrievalInput`
   * stays a plain `RetrievalInput`, unchanged, because the orchestrator has
   * no `AgentJobRecord` in scope to resolve a factory against; advertising a
   * factory shape it could not execute would reopen the "no
   * orchestrator/contract change" scope boundary this field exists to avoid.
   *
   * Present together with `retriever` or omitted together with it — see the
   * same all-or-nothing validation `AgentOrchestratorParams` already applies
   * to `retriever`/`retrievalInput` (agent-orchestrator.ts's
   * `validateOrchestratorParams`); this field is simply the per-job-derived
   * source of that value for a caller (apps/api) that only has a `jobId`
   * until the locked row is read.
   */
  readonly retrievalInputFactory?: (job: AgentJobRecord) => RetrievalInput;
  /**
   * REQUIRED, all four, when `providerMode` is `"LIVE"`; FORBIDDEN, all four,
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
   * The caller's key for THIS live run request — the fourth live-only input, and
   * subject to exactly the same all-or-nothing rule as the other three.
   *
   * It belongs in this group rather than beside `modelIdentifier` because it is
   * a SAFEGUARD, not a descriptor: without it a repeated request creates a second
   * paid attempt, which is the same class of failure as a missing budget
   * reservation. Making it optional in the type only (like the others) is what
   * lets a FAKE call omit it; `resolveLiveInputs` enforces the real rule.
   */
  readonly clientRequestId?: string;
  /**
   * Present only for a PUBLIC trial LIVE run (issue #39) — unlike the four
   * inputs above, OPTIONAL even when `providerMode` is `"LIVE"`: a private,
   * token-authenticated LIVE call supplies every other live input but never
   * this one. Forbidden on a FAKE call, exactly like the other live-only
   * inputs.
   */
  readonly publicTrial?: PublicTrialReservationInput;
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
  /**
   * Fires exactly once, only when the orchestrator fails with
   * REPORT_SCHEMA_INVALID, before finalize() persists the run. This package
   * does no logging itself (see createProvider's own logger for the parallel
   * pattern at the provider-turn level) — a caller that wants this failure
   * observable (apps/api does, as a one-line sanitized JSON log analogous to
   * logProviderEvent) supplies this hook. `issues` is already sanitized by
   * summarizeReportValidationIssues: paths, codes, expected/received type
   * names, and this package's own static schema bounds — never the raw
   * report Claude submitted.
   */
  readonly onReportSchemaInvalid?: (diagnostic: {
    readonly runId: string;
    readonly providerMode: ProviderMode;
    readonly modelIdentifier: string | null;
    readonly issues: readonly ReportValidationIssue[];
  }) => void;
  /**
   * Fires exactly once, only when a canonical lifecycle event could not be
   * persisted, before `executeAndPersist` returns its `event-emission` result.
   * Same contract as `onReportSchemaInvalid` above: this package does no
   * logging itself, the diagnostic is already narrowed to safe closed values
   * (see InvestigationEventEmissionDiagnostic), and a throwing hook cannot
   * change the returned result.
   */
  readonly onEventEmissionFailure?: (diagnostic: InvestigationEventEmissionDiagnostic) => void;
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
      /**
       * Whether this call actually ran the agent, or returned a run an EARLIER
       * call with the same client key had already created.
       *
       * Explicit, because every other signal is ambiguous. A replayed run may be
       * RUNNING (finalization failed after the provider executed), COMPLETED, or
       * FAILED; a freshly started one is any of those too. `usageSummary: null`
       * is likewise true of both a replay and a FAKE run. Only the code that
       * performed the lookup knows, so only it says.
       *
       * `"replayed"` always carries `usageSummary: null` and `reservation: null`
       * — a replay measured nothing and reserved nothing, and the attempt that
       * created the run already reconciled the day from its own figures.
       */
      readonly execution: "started" | "replayed";
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
    }
  // Persisting one canonical lifecycle event failed MID-RUN (issue #37).
  //
  // The run aborts and stays RUNNING: no terminal event, no terminal status,
  // and nothing the provider or a tool already did is re-executed. There is
  // deliberately NO retry path — unlike finalization there is no durable
  // in-memory result to replay, and forcing a terminal write would require a
  // failure code that is not an AgentOrchestratorErrorCode plus a failedStage
  // the ledger never recorded as active. The row lands in the documented
  // orphaned-RUNNING gap (docs/11-agent-run-persistence.md §10).
  //
  // Usage and reservation ride along exactly as they do for the finalization
  // variant, so a run that spent real tokens is still reconciled by the
  // caller's cleanup block.
  | {
      readonly persistence: "unavailable";
      readonly stage: "event-emission";
      readonly runId: string;
      readonly attemptedEventType: InvestigationEventPayload["type"];
      readonly error: PersistenceError;
      readonly usageSummary: RunProviderUsageSummary | null;
      readonly reservation: LiveRunBudgetReservation | null;
    };

/**
 * The four inputs a LIVE run cannot execute without, resolved together.
 *
 * `null` is the FAKE answer, and it is a different thing from "some inputs were
 * missing" — which is an error, not a mode.
 */
interface LiveExecutionInputs<TCollector extends AgentRunUsageCollector> {
  readonly usageHooks: AgentRunUsageHooks<TCollector>;
  readonly liveAttemptLimit: number;
  readonly budgetReservationInput: LiveRunBudgetReservationInput;
  readonly clientRequestId: string;
  /** Present only for a PUBLIC trial LIVE run (issue #39) — see ExecuteAndPersistParams. */
  readonly publicTrial: PublicTrialReservationInput | undefined;
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
 *   LIVE  → all four are required      → startLiveRunWithAttemptLimit, one collector
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
  const { usageHooks, liveAttemptLimit, budgetReservationInput, clientRequestId, publicTrial } = params;
  const present = {
    usageHooks: usageHooks !== undefined,
    liveAttemptLimit: liveAttemptLimit !== undefined,
    budgetReservationInput: budgetReservationInput !== undefined,
    clientRequestId: clientRequestId !== undefined,
    // Checked for FORBIDDEN-on-FAKE alongside the other four, but — unlike
    // them — never checked for REQUIRED-on-LIVE below: a private,
    // token-authenticated LIVE call has every other live input and never
    // this one.
    publicTrial: publicTrial !== undefined,
  };
  const names = (wanted: boolean) =>
    Object.entries(present)
      .filter(([, supplied]) => supplied === wanted)
      .map(([name]) => name)
      .join(", ");

  if (params.providerMode !== "LIVE") {
    if (
      present.usageHooks ||
      present.liveAttemptLimit ||
      present.budgetReservationInput ||
      present.clientRequestId ||
      present.publicTrial
    ) {
      throw new AgentRunConfigurationError(
        `executeAndPersist: providerMode "${params.providerMode}" does not accept live-only inputs (${names(true)}).`,
      );
    }
    return null;
  }

  // Re-tested individually rather than via the booleans above so TypeScript
  // narrows each field — this is what makes the returned object's non-optional
  // types real rather than asserted. publicTrial is deliberately excluded from
  // this check: it stays optional even on a LIVE call.
  if (
    usageHooks === undefined ||
    liveAttemptLimit === undefined ||
    budgetReservationInput === undefined ||
    clientRequestId === undefined
  ) {
    throw new AgentRunConfigurationError(
      `executeAndPersist: providerMode "LIVE" requires every live safeguard input (missing: ${names(false)}).`,
    );
  }

  return { usageHooks, liveAttemptLimit, budgetReservationInput, clientRequestId, publicTrial };
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

/**
 * The answer to "does this request already exist?", asked BEFORE "may a new paid
 * execution start?".
 *
 * Three cases, stated explicitly rather than collapsed into a nullable run:
 *
 *   found        the key already names a run — return it, admit nothing
 *   absent       no run bears the key — the caller may go on to new-run admission
 *   unavailable  the lookup itself failed — the caller must NOT go on
 *
 * `absent` and `unavailable` are the pair that must never be confused. Treating a
 * failed lookup as "no run exists" would send a request that may already have
 * executed straight into new-run admission, which is precisely the duplicate paid
 * attempt the key exists to prevent. A nullable return would have made that the
 * easy mistake to write; a third case makes it one you have to choose.
 */
export type ReplayLiveRunResult =
  | { readonly replay: "found"; readonly run: PersistedAgentRun }
  | { readonly replay: "absent" }
  | { readonly replay: "unavailable"; readonly error: PersistenceError };

export interface AgentRunService {
  createAgentJob(ticketContext: unknown): Promise<AgentJobRecord>;
  executeAndPersist<TCollector extends AgentRunUsageCollector = AgentRunUsageCollector>(
    params: ExecuteAndPersistParams<TCollector>,
  ): Promise<ExecuteAndPersistResult>;
  /**
   * Recovers an existing keyed LIVE run, without admitting a new one.
   *
   * Deliberately NOT folded into `executeAndPersist`. That method's job is to run
   * an agent, and everything it needs to do so — a budget reservation, an attempt
   * limit, usage hooks — is exactly what a recovery must NOT require. Asking for
   * them in order to answer "did this already happen?" is what made the answer
   * unreachable whenever the day's spend admission was closed.
   *
   * Builds no collector, constructs no provider, executes nothing, finalizes
   * nothing, and returns no reservation for the caller to reconcile. The run it
   * returns was created — and paid for, if it got that far — by the attempt that
   * created it.
   */
  replayLiveRun(params: {
    readonly jobId: string;
    readonly clientRequestId: string;
  }): Promise<ReplayLiveRunResult>;
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
  getInvestigationState(jobId: string): Promise<PersistedInvestigationState>;
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
      await repository.finalizeCompleted(runId, agentResult.report, usage);
    } else {
      // agentResult.code is already the resolved terminal code — see
      // resolveAgentResultAbortProvenance, called once by executeAndPersist
      // before this function is ever reached. finalize itself resolves
      // nothing: doing so here would mean re-deriving provenance on every
      // retry, using whatever context that retry call happens to supply
      // (retryFinalization supplies none at all).
      // failedStage travels with the result, so a retry names the same stage
      // the first attempt would have — persistence never re-derives it.
      await repository.finalizeFailed(runId, agentResult.code, agentResult.failedStage, usage);
    }
    return {
      persistence: "persisted",
      run: await repository.getAgentRun(runId),
      usageSummary,
      reservation,
      // `finalize` is only ever reached by a run this process actually executed
      // — a replay returns long before this, without building a provider.
      execution: "started",
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
          // The atomic path: locks the job, replays a repeated client key,
          // revalidates the stored context against current LIVE bounds, enforces
          // the per-job live attempt limit, reserves the day's budget, and
          // inserts the run — then COMMITS, before any provider call below.
          const startedLive = await repository.startLiveRunWithAttemptLimit({
            jobId: params.jobId,
            modelIdentifier: params.modelIdentifier ?? null,
            maxLiveAttempts: live.liveAttemptLimit,
            budget: live.budgetReservationInput,
            clientRequestId: live.clientRequestId,
            ...(live.publicTrial !== undefined ? { publicTrial: live.publicTrial } : {}),
          });

          /**
           * THE REPLAY EXIT, and everything it steps over is the point.
           *
           * Returning here means no collector is created, no provider is
           * constructed, no orchestrator runs, nothing is finalized, and no
           * reservation is handed to the caller's cleanup to reconcile. The run
           * this returns was created — and paid for, if it got that far — by an
           * earlier request carrying the same key.
           *
           * The row's STATUS is deliberately not consulted. A RUNNING replay is
           * the normal shape of the case this exists for: the provider executed
           * and finalization failed. Re-running the agent because the row looks
           * unfinished is exactly the duplicate paid execution the key prevents.
           * If that run does finalize later, the caller's ordinary refresh sees
           * it; if it never does, it stays RUNNING, which is a pre-existing
           * recovery gap and not something a second charge would fix.
           *
           * `getAgentRun` runs inside this try/catch on purpose: if the read
           * fails, the caller gets the `run-creation` unavailable variant (503)
           * and retrying with the SAME key replays again. A retry after this
           * point can never execute a provider.
           */
          if (startedLive.outcome === "replayed") {
            return {
              persistence: "persisted",
              run: await repository.getAgentRun(startedLive.run.id),
              usageSummary: null,
              reservation: null,
              execution: "replayed",
            };
          }

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

      // Issue #72 §2.2 (round-2 review correction): resolved HERE, against
      // the same authoritative `started.job` the ticket context message
      // above was just built from — never inside the orchestrator, which has
      // no AgentJobRecord in scope. Absent when the caller supplied no
      // factory, matching `params.retrievalInput`'s existing optionality.
      const resolvedRetrievalInput: RetrievalInput | undefined =
        params.retrievalInputFactory?.(started.job) ?? params.retrievalInput;

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
      // The CANONICAL emission channel, bound to the runId the orchestrator
      // never learns. Wrapping the PersistenceError here — where payload.type
      // is in scope — is what lets the service report WHICH event failed
      // without the orchestrator ever importing a persistence type.
      const emitLifecycleEvent = async (payload: InvestigationEventPayload): Promise<void> => {
        try {
          await repository.appendInvestigationEvent(started.run.id, payload);
        } catch (cause) {
          throw new InvestigationEventEmissionError({
            runId: started.run.id,
            attemptedEventType: payload.type,
            cause,
          });
        }
      };

      let agentResult: AgentOrchestratorResult;
      try {
        const provider = params.createProvider(started.job, collector);
        agentResult = await runAgentOrchestrator({
          provider,
          toolRegistry: params.toolRegistry,
          initialConversation: [ticketContextMessage],
          emitLifecycleEvent,
          // Conditional spreads — exactOptionalPropertyTypes:true means an
          // optional property must be either fully absent or a real value,
          // never an explicit `undefined`; AgentOrchestratorParams's
          // optional fields do not include `| undefined` in their declared
          // type, so unconditionally forwarding params.X (which may itself
          // be undefined) would fail to typecheck.
          ...(params.allowedRagChunkIds !== undefined ? { allowedRagChunkIds: params.allowedRagChunkIds } : {}),
          ...(params.retriever !== undefined ? { retriever: params.retriever } : {}),
          ...(resolvedRetrievalInput !== undefined ? { retrievalInput: resolvedRetrievalInput } : {}),
          ...(params.outputBudget !== undefined ? { outputBudget: params.outputBudget } : {}),
          // Scope: this reaches the provider turns only; tool, retrieval, and
          // persistence cancellation are not wired in this milestone.
          ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        });
      } catch (rawError) {
        // A canonical-ledger failure is NOT a crash: persistence is exactly
        // what went wrong, and there is something structured to hand back.
        // Abort, leave the run RUNNING, and carry the usage the collector has
        // already accumulated so the caller's cleanup still reconciles a run
        // that spent real tokens. `collector.snapshot()` is the same mechanism
        // the crash path below uses — the accumulator is mutable and live, and
        // the adapter records into it as each provider turn completes, so every
        // call billed before the failed append is already counted.
        if (rawError instanceof InvestigationEventEmissionError) {
          // Best-effort observability only, exactly like onReportSchemaInvalid:
          // a caller-supplied hook throwing must never change what this method
          // returns, or a logging bug would become an execution bug.
          try {
            params.onEventEmissionFailure?.(buildEmissionDiagnostic(rawError));
          } catch {
            // Swallowed deliberately — the hook's failure is not this run's.
          }
          return {
            persistence: "unavailable",
            stage: "event-emission",
            runId: started.run.id,
            attemptedEventType: rawError.attemptedEventType,
            error: toPersistenceError(rawError.cause),
            usageSummary: collector?.snapshot() ?? null,
            reservation,
          };
        }

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

      if (agentResult.status === "failed" && agentResult.code === "REPORT_SCHEMA_INVALID") {
        // Best-effort observability only. A caller-supplied hook throwing must
        // never skip finalize() below — that would leave an already-known
        // terminal failure unpersisted and the row stuck RUNNING. This
        // service owns that guarantee; it cannot rely solely on the concrete
        // apps/api logger also being non-throwing (see
        // report-validation-log.ts's own try/catch, which is defense in
        // depth, not the boundary of record).
        try {
          params.onReportSchemaInvalid?.({
            runId: started.run.id,
            providerMode: params.providerMode,
            modelIdentifier: params.modelIdentifier ?? null,
            issues: agentResult.reportValidationIssues ?? [],
          });
        } catch {
          // Swallowed deliberately: the hook's failure is not this run's
          // failure, and its error must never reach a caller or a response.
        }
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

    async replayLiveRun({ jobId, clientRequestId }) {
      try {
        const found = await repository.replayLiveRun({ jobId, clientRequestId });
        if (found === null) return { replay: "absent" };
        // Re-read through getAgentRun so a replay's body is produced by the SAME
        // read model a fresh run's is — trace, outcome and job included. The
        // locked lookup returns only the run row, which is all it needs to decide
        // the question; assembling the response from it here would be a second,
        // subtly different projection of the same run.
        return { replay: "found", run: await repository.getAgentRun(found.run.id) };
      } catch (error) {
        if (error instanceof PersistenceError) {
          // Carried out rather than thrown, so the caller has to handle it. A
          // missing job arrives here too (PERSISTENCE_NOT_FOUND) and becomes the
          // same 404 the creating transaction produces for it.
          return { replay: "unavailable", error };
        }
        throw error;
      }
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
    getInvestigationState: (jobId) => repository.getInvestigationState(jobId),
  };
}
