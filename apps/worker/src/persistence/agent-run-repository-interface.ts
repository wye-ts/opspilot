import type { AgentTraceEvent } from "@opspilot/contracts";
import type {
  AgentJobRecord,
  AgentRunRecord,
  PersistedAgentRun,
  ProviderMode,
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
  finalizeCompleted(
    runId: string,
    trace: readonly AgentTraceEvent[],
    report: unknown,
  ): Promise<AgentRunRecord>;
  finalizeFailed(
    runId: string,
    trace: readonly AgentTraceEvent[],
    code: unknown,
  ): Promise<AgentRunRecord>;
  getAgentRun(runId: string): Promise<PersistedAgentRun>;
}
