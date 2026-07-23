import {
  createJob as dbCreateJob,
  finalizeCompleted as dbFinalizeCompleted,
  finalizeFailed as dbFinalizeFailed,
  getAgentRun as dbGetAgentRun,
  PersistenceError,
  startRun as dbStartRun,
  type AgentJobRecord,
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
import type { AgentConversationMessage } from "../providers/llm-provider";
import { AgentRunServiceError } from "./agent-run-service-error";
import type { AgentRunRepositoryInterface } from "./agent-run-repository-interface";

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
export interface ExecuteAndPersistParams extends Omit<AgentOrchestratorParams, "initialConversation"> {
  readonly jobId: string;
  readonly providerMode: ProviderMode;
  readonly modelIdentifier?: string | null;
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

      // runAgentOrchestrator remains completely unchanged and persistence-free
      // (see agent-orchestrator.ts) — this is Option A, persist-after: the
      // orchestrator runs fully in memory before any trace/outcome is written.
      let agentResult: AgentOrchestratorResult;
      try {
        agentResult = await runAgentOrchestrator({
          ...params,
          initialConversation: [ticketContextMessage],
        });
      } catch (rawError) {
        // Not a PersistenceError (persistence worked correctly up to this
        // point). Not an AgentOrchestratorErrorCode (this is not an
        // agent-domain decision). Not returned inside ExecuteAndPersistResult
        // — thrown instead, since there is nothing structured to hand back.
        // The run row stays RUNNING; recovery is deferred (see class doc).
        throw new AgentRunServiceError("AGENT_EXECUTION_CRASHED", started.run.id, { cause: rawError });
      }

      return finalize(repository, started.run.id, agentResult);
    },

    retryFinalization: (runId, agentResult) => finalize(repository, runId, agentResult),

    getAgentRun: (runId) => repository.getAgentRun(runId),
  };
}
