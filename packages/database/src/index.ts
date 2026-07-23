export { createPrismaClient } from "./client";
export type { PrismaClient, PrismaClientHandle } from "./client";

export { PersistenceError, normalizeDatabaseError } from "./errors";
export type { PersistenceErrorCode } from "./errors";

export { FAILURE_DISPLAY_MESSAGES } from "./failure-messages";

export { TicketContextSchema, validateOrThrow } from "./validation";

export type {
  AgentJobRecord,
  AgentRunOutcome,
  AgentRunRecord,
  AgentRunStatus,
  PersistedAgentRun,
  ProviderMode,
  StartedAgentRun,
  TicketContext,
} from "./types";

export {
  createJob,
  finalizeCompleted,
  finalizeFailed,
  getAgentRun,
  startRun,
} from "./repositories/agent-run-repository";
