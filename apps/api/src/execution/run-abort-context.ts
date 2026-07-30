import type { ServerResponse } from "node:http";

import type { RunAbortContext } from "@opspilot/agent-runtime";

import { createRequestAbortHandle, type RequestAbortHandle } from "./request-abort-handle";

/**
 * A caller-owned deadline covering Anthropic provider calls across the run.
 * It is a product-level execution budget, not a mathematical worst-case
 * formula.
 *
 * There is deliberately no arithmetic relating this to the SDK's own settings.
 * `ANTHROPIC_TIMEOUT_MS` bounds a single attempt and `ANTHROPIC_MAX_RETRIES`
 * bounds the attempt count, but retry backoff and any `retry-after` delay the
 * SDK honours add time on top and are not observable from the response — so
 * "timeout x attempts" is not a real ceiling and is never claimed as one here.
 * This value is chosen for how long a person will wait for an interactive demo
 * before the run stops being useful.
 *
 * Scope: this reaches the Anthropic provider calls only. Tool execution,
 * retrieval, and persistence cancellation are NOT wired in PR 6B1, so a run
 * whose deadline expires still finishes its in-flight tool call and its
 * finalizing write. That is milliseconds for a seeded in-memory tool and one
 * UPDATE — but it means this is not whole-run cancellation, and nothing in the
 * codebase or the docs may describe it as such.
 */
export const DEFAULT_PROVIDER_DEADLINE_MS = 120_000;

export interface RunAbortHandles {
  readonly context: RunAbortContext;
  dispose(): void;
}

/**
 * Builds the per-run abort context.
 *
 * The two source signals are kept alongside the merged one because the merge
 * is lossy in exactly the dimension that matters: the SDK reports a deadline
 * abort and a caller disconnect identically, so only the originals can say
 * which happened. See resolveAbortProvenance in @opspilot/agent-runtime.
 *
 * `AbortSignal.timeout` schedules an `unref`'d timer that becomes
 * garbage-collectable once the signal is unreachable, so there is nothing to
 * clear on the success path — `dispose()` only has to detach the response
 * listeners.
 */
export function createRunAbortHandles(
  response: ServerResponse,
  providerDeadlineMs: number,
): RunAbortHandles {
  const deadlineSignal = AbortSignal.timeout(providerDeadlineMs);
  const disconnect: RequestAbortHandle = createRequestAbortHandle(response);

  return {
    context: {
      deadlineSignal,
      disconnectSignal: disconnect.signal,
      signal: AbortSignal.any([deadlineSignal, disconnect.signal]),
    },
    dispose: () => disconnect.dispose(),
  };
}
