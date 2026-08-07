import type { InvestigationEventPayload } from "@opspilot/contracts";
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

const EVENT_EMISSION_FAILED_MESSAGE =
  "A canonical investigation lifecycle event could not be persisted.";

/**
 * Persisting one canonical lifecycle event failed mid-run.
 *
 * INTERNAL, and deliberately its own type rather than an
 * `AgentOrchestratorErrorCode`: execution failure and ledger-infrastructure
 * failure are separate domains. The agent did not fail — the ledger did — so
 * collapsing this into the orchestrator's closed failure enum would force
 * persistence to lie about what happened, and would require a `failedStage`
 * the ledger never actually recorded as active.
 *
 * Thrown by the emitter closure `executeAndPersist` supplies, and allowed to
 * escape `runAgentOrchestrator` unchanged (its only catch re-throws anything
 * that is not an `LlmProviderError`). The run aborts immediately: no further
 * provider turn, no further tool call, no legacy trace push for the event
 * whose canonical write failed, and no terminal finalization — the row stays
 * RUNNING.
 *
 * Carries only safe metadata. `attemptedEventType` is a closed enum member.
 * There is deliberately NO `sequence`: allocation happens inside the
 * transaction that failed, so the caller cannot know whether one was ever
 * assigned, and inventing one would be a lie. The underlying
 * `PersistenceError` is retained solely as `cause`.
 */
export class InvestigationEventEmissionError extends Error {
  readonly runId: string;
  readonly attemptedEventType: InvestigationEventPayload["type"];

  constructor(params: {
    readonly runId: string;
    readonly attemptedEventType: InvestigationEventPayload["type"];
    readonly cause?: unknown;
  }) {
    super(EVENT_EMISSION_FAILED_MESSAGE, { cause: params.cause });
    this.name = "InvestigationEventEmissionError";
    this.runId = params.runId;
    this.attemptedEventType = params.attemptedEventType;
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
