import type { LiveRunBudgetReservation } from "@opspilot/database";

import type { RunProviderUsageSummary } from "./run-provider-usage";

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
/**
 * Whatever the crashed run had already established about its provider spend.
 *
 * INTERNAL ONLY — never serialized into an HTTP response. It exists so a crash
 * does not lose the budget accounting: the controller reads it in its cleanup
 * block to reconcile a run that spent real tokens before dying. Without it, a
 * crash after a provider call would silently leak a reservation and understate
 * the day's spend.
 */
export interface AgentRunExecutionContext {
  readonly usageSummary: RunProviderUsageSummary | null;
  readonly reservation: LiveRunBudgetReservation | null;
}

/**
 * A caller wired `executeAndPersist` into a state its contract forbids — a LIVE
 * run missing a safeguard input, or a FAKE run carrying one.
 *
 * A PROGRAMMER error, deliberately distinct from `AgentRunServiceError`: nothing
 * has executed, no row exists, no provider was built, and no runId can be
 * reported because none was ever allocated. It is thrown before the first
 * repository call, so there is nothing to reconcile or recover — the request
 * simply cannot be served as asked.
 *
 * Unreachable from any HTTP request on a correctly wired server: the controller
 * supplies all three live inputs together for LIVE and none for FAKE. If it ever
 * does surface, it becomes a 500 (never a 429 or a 503) because it describes a
 * bug in this process, not a client mistake or a transient outage — and the
 * fixed message says only which inputs disagreed, never their values.
 */
export class AgentRunConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunConfigurationError";
  }
}

export class AgentRunServiceError extends Error {
  readonly code: AgentRunServiceErrorCode;
  readonly runId: string;
  readonly executionContext?: AgentRunExecutionContext;

  constructor(
    code: AgentRunServiceErrorCode,
    runId: string,
    options?: { cause?: unknown; executionContext?: AgentRunExecutionContext },
  ) {
    super(AGENT_EXECUTION_CRASHED_MESSAGE, options);
    this.name = "AgentRunServiceError";
    this.code = code;
    this.runId = runId;
    if (options?.executionContext !== undefined) {
      this.executionContext = options.executionContext;
    }
  }
}
