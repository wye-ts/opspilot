import {
  createJob as dbCreateJob,
  finalizeCompleted as dbFinalizeCompleted,
  finalizeFailed as dbFinalizeFailed,
  getAgentJob as dbGetAgentJob,
  getAgentRun as dbGetAgentRun,
  PersistenceError,
  startRun as dbStartRun,
  type AgentJobRecord,
  type PersistedAgentJob,
  type PersistedAgentRun,
  type PrismaClient,
  type ProviderMode,
  type StartedAgentRun,
} from "@opspilot/database";

import {
  runAgentOrchestrator,
  type AgentOrchestratorParams,
  type AgentOrchestratorResult,
} from "../agent/agent-orchestrator";
import type { AgentConversationMessage, LlmProvider } from "../providers/llm-provider";
import { resolveAbortProvenance, type RunAbortContext } from "../providers/run-abort-context";
import { AgentRunServiceError } from "./agent-run-service-error";
import type { AgentRunRepositoryInterface } from "./agent-run-repository-interface";

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
    finalizeCompleted: (runId, trace, report) => dbFinalizeCompleted(prisma, runId, trace, report),
    finalizeFailed: (runId, trace, code) => dbFinalizeFailed(prisma, runId, trace, code),
    getAgentRun: (runId) => dbGetAgentRun(prisma, runId),
    getAgentJob: (jobId) => dbGetAgentJob(prisma, jobId),
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
export interface ExecuteAndPersistParams
  extends Omit<AgentOrchestratorParams, "initialConversation" | "provider"> {
  readonly jobId: string;
  readonly providerMode: ProviderMode;
  readonly createProvider: (job: AgentJobRecord) => LlmProvider;
  readonly modelIdentifier?: string | null;
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

export type ExecuteAndPersistResult =
  | { readonly persistence: "persisted"; readonly run: PersistedAgentRun }
  // Failure before any AgentRun row exists — no runId to retry against.
  | { readonly persistence: "unavailable"; readonly stage: "run-creation"; readonly error: PersistenceError }
  // The agent produced a real AgentOrchestratorResult, but persisting the
  // terminal outcome failed. runId + agentResult are both included so the
  // caller can retry via retryFinalization (see its durability limit below).
  | {
      readonly persistence: "unavailable";
      readonly stage: "finalization";
      readonly runId: string;
      readonly agentResult: AgentOrchestratorResult;
      readonly error: PersistenceError;
    };

export interface AgentRunService {
  createAgentJob(ticketContext: unknown): Promise<AgentJobRecord>;
  executeAndPersist(params: ExecuteAndPersistParams): Promise<ExecuteAndPersistResult>;
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
  retryFinalization(runId: string, agentResult: AgentOrchestratorResult): Promise<ExecuteAndPersistResult>;
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
): Promise<ExecuteAndPersistResult> {
  try {
    if (agentResult.status === "completed") {
      await repository.finalizeCompleted(runId, agentResult.trace, agentResult.report);
    } else {
      // agentResult.code is already the resolved terminal code — see
      // resolveAgentResultAbortProvenance, called once by executeAndPersist
      // before this function is ever reached. finalize itself resolves
      // nothing: doing so here would mean re-deriving provenance on every
      // retry, using whatever context that retry call happens to supply
      // (retryFinalization supplies none at all).
      await repository.finalizeFailed(runId, agentResult.trace, agentResult.code);
    }
    return { persistence: "persisted", run: await repository.getAgentRun(runId) };
  } catch (error) {
    if (error instanceof PersistenceError) {
      return { persistence: "unavailable", stage: "finalization", runId, agentResult, error };
    }
    throw error;
  }
}

export function createAgentRunService(repository: AgentRunRepositoryInterface): AgentRunService {
  return {
    createAgentJob: (ticketContext) => repository.createJob(ticketContext),

    async executeAndPersist(params) {
      let started: StartedAgentRun;
      try {
        started = await repository.startRun(
          params.jobId,
          params.providerMode,
          params.modelIdentifier ?? null,
        );
      } catch (error) {
        if (error instanceof PersistenceError) {
          return { persistence: "unavailable", stage: "run-creation", error };
        }
        throw error;
      }

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
        const provider = params.createProvider(started.job);
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
        throw new AgentRunServiceError("AGENT_EXECUTION_CRASHED", started.run.id, { cause: rawError });
      }

      // Resolved once, here, before finalize is ever called — see
      // resolveAgentResultAbortProvenance for why this must not move inside
      // finalize or be re-derived on retry.
      const resolvedResult = resolveAgentResultAbortProvenance(agentResult, params.abortContext);

      return finalize(repository, started.run.id, resolvedResult);
    },

    retryFinalization: (runId, agentResult) => finalize(repository, runId, agentResult),

    getAgentRun: (runId) => repository.getAgentRun(runId),
    getAgentJob: (jobId) => repository.getAgentJob(jobId),
  };
}
