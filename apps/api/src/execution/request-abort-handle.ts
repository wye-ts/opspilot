import type { ServerResponse } from "node:http";

/**
 * A cancellation signal that fires when the caller goes away before the
 * response completes.
 *
 * ## Why this observes the response and never the request
 *
 * The obvious implementation — `request.on("close", ...)` — is wrong, and
 * wrong in a way that passes review and then cancels every healthy run.
 *
 * `IncomingMessage` emits `close` once its readable side is finished, which
 * for an ordinary `POST` with a small JSON body happens as soon as the body
 * has been read: long before the handler has done any work, and long before
 * anything has been written back. A handle built on that event aborts
 * essentially immediately on every request. Guarding it with
 * `response.writableEnded` does not save it either, because at that moment
 * nothing has been written, so the guard is false and the abort still fires.
 *
 * The response object does not have this problem. It emits `finish` exactly
 * once, when the response has been handed to the OS, and `close` when the
 * underlying connection goes away — which is the event actually worth
 * listening to.
 *
 * ## Why `writableFinished` and not `writableEnded`
 *
 * `writableEnded` flips as soon as `end()` is *called*; `writableFinished`
 * only once the data has actually been flushed. A socket that dies mid-flush
 * is a real disconnect that `writableEnded` would misreport as a clean finish,
 * so the stricter flag is the correct guard.
 *
 * ## Lifetime
 *
 * The handle is live for the duration of the request handler. `dispose()`
 * detaches both listeners and is safe to call more than once, so the caller
 * can put it in a `finally` without further guarding. Once disposed it stops
 * observing the connection entirely — it does not, and does not claim to,
 * report a disconnect that happens after the handler has returned.
 *
 * ## Already-closed-before-construction
 *
 * A caller can disconnect after the request body is accepted but before this
 * function runs, in which case `close` already fired and no future event
 * will report it. Listeners are attached first, then current state is
 * reconciled once: an already-flushed response settles with no abort, and an
 * already-destroyed, not-yet-flushed response is treated as an
 * already-observed premature close. Attaching before checking means a
 * transition landing in between is caught by the listener instead of being
 * missed by the check, and the `settled` guard makes firing both harmless.
 */
export interface RequestAbortHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createRequestAbortHandle(response: ServerResponse): RequestAbortHandle {
  const controller = new AbortController();

  // One flag guards every transition, so `abort()` can fire at most once and a
  // late event after disposal is a no-op rather than a second abort.
  let settled = false;

  function detach(): void {
    response.off("finish", onFinished);
    response.off("close", onClosed);
  }

  function onFinished(): void {
    // The response completed normally. This is the case a request-based
    // implementation gets wrong: there is nothing to cancel here.
    if (settled) return;
    settled = true;
    detach();
  }

  function onClosed(): void {
    if (settled) return;
    settled = true;
    detach();

    // `close` fires for both outcomes. Only a close that beats the flush is a
    // disconnect; one that follows it is the ordinary end of a served request.
    if (!response.writableFinished) {
      controller.abort();
    }
  }

  response.once("finish", onFinished);
  response.once("close", onClosed);

  // A disconnect between the caller accepting the request body and this
  // handle being constructed fires no future event: `close` already
  // happened. Listeners are attached first, so a transition landing exactly
  // here is caught by them instead of being missed by this check, and the
  // `settled` guard makes running both redundant-safe.
  if (response.writableFinished) {
    onFinished();
  } else if (response.destroyed) {
    onClosed();
  }

  return {
    signal: controller.signal,
    dispose(): void {
      if (settled) return;
      settled = true;
      detach();
    },
  };
}
