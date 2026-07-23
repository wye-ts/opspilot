export type AgentRunServiceErrorCode = "AGENT_EXECUTION_CRASHED";

const AGENT_EXECUTION_CRASHED_MESSAGE = "The agent execution terminated unexpectedly.";

// Thrown (never returned inside a public result object) when
// runAgentOrchestrator itself throws after startRun has already committed a
// RUNNING row — a crash, not a persistence failure and not an agent-domain
// decision. The fixed message and stable code are the only things safe to
// surface publicly (logs, the persisted demo); the raw cause is retained
// solely for internal debugging via Error.cause. See
// docs/11-agent-run-persistence.md for the full rationale and the explicit
// retryFinalization durability limit this implies (no process-restart-safe
// recovery — the row remains RUNNING pending a future reaper milestone).
export class AgentRunServiceError extends Error {
  readonly code: AgentRunServiceErrorCode;
  readonly runId: string;

  constructor(code: AgentRunServiceErrorCode, runId: string, options?: { cause?: unknown }) {
    super(AGENT_EXECUTION_CRASHED_MESSAGE, options);
    this.name = "AgentRunServiceError";
    this.code = code;
    this.runId = runId;
  }
}
