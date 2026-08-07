import { useCallback, useEffect, useRef, useState } from "react";
import { getInvestigationState } from "../api/endpoints";
import type { InvestigationStateResponse } from "../api/types";
import {
  classifyInvestigationPollError,
  type PollErrorClassification,
} from "../api/poll-error-classification";

/**
 * What the poll hook reports back to App.tsx on each settle.
 * Exactly ONE of `snapshot` or `error` is non-null at a time.
 */
export interface PollSnapshot {
  readonly snapshot: InvestigationStateResponse;
  readonly pollGeneration: number;
}

export interface PollError {
  readonly classification: PollErrorClassification;
  readonly pollGeneration: number;
}

export type PollEvent = PollSnapshot | PollError;

/** The externally visible state of the polling session. */
export type PollStatus = "idle" | "polling" | "paused";

/**
 * Every reason a polling session can stop or pause.
 *
 * `transient-ceiling` / `time-ceiling` / `data-corrupt` are PAUSABLE: the
 * session's jobId/callbacks are kept so a later `resume()` ("Check again")
 * can restart a fresh bounded session for the SAME job.
 *
 * `terminal` / `not-found` / `permanent-invalid` / `aborted` are genuinely
 * STOPPED: the session's jobId/callbacks are cleared, and `resume()` is a
 * no-op afterwards — there is nothing left to resume.
 */
export type PollStopReason =
  | "terminal"
  | "not-found"
  | "permanent-invalid"
  | "data-corrupt"
  | "transient-ceiling"
  | "time-ceiling"
  | "aborted";

const PAUSABLE_REASONS: ReadonlySet<PollStopReason> = new Set([
  "transient-ceiling",
  "time-ceiling",
  "data-corrupt",
]);

/** How long the polling session has been running (ms). */
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 6;

/** Cadence: bounded, deliberately not exponential while healthy. */
function healthyInterval(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1_000;
  if (elapsedMs < 60_000) return 2_000;
  return 5_000;
}

/** Transient backoff sequence: 2s → 4s → 8s → 15s → 15s. */
function transientBackoff(consecutiveFailures: number): number {
  switch (consecutiveFailures) {
    case 1:
      return 2_000;
    case 2:
      return 4_000;
    case 3:
      return 8_000;
    default:
      return 15_000;
  }
}

export interface PollCallbacks {
  /** Called with every valid snapshot — terminal or non-terminal. */
  readonly onSnapshot: (event: PollSnapshot) => void;
  /** Called when an error is classified (transient or otherwise). */
  readonly onError: (event: PollError) => void;
  /** Called when polling reaches a stop or pause condition. */
  readonly onStop: (reason: PollStopReason) => void;
}

/**
 * One self-scheduling setTimeout chain; never setInterval.
 * Overlap is structurally impossible — the next tick is scheduled only after
 * the previous response settles.
 *
 * The hook's INTERNAL generation is for its own overlap bookkeeping only.
 * It must never be used as the terminal settlement identity's `generation`
 * field — that field comes from App.tsx's main `beginWorkflow()` generation.
 */
export function useInvestigationPoll() {
  const [status, setStatus] = useState<PollStatus>("idle");

  // Internal state refs — not React state, because they change on every tick
  // and must never cause a re-render (the caller ticks its own state).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const startTimeRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);
  // Kept across a PAUSE (cleared only on a genuine stop) so resume() ("Check
  // again") knows what job/callbacks to restart polling for.
  const jobIdRef = useRef<string | null>(null);
  const callbacksRef = useRef<PollCallbacks | null>(null);

  // Cancels any pending tick and aborts any in-flight fetch on unmount. Without
  // this, a session active when the component unmounts leaks its scheduled
  // setTimeout indefinitely — in the browser, a closed/replaced investigation
  // view would keep polling forever; in tests, a leftover timer fires during a
  // LATER test against whatever fetch mock that test has stubbed, silently
  // corrupting its call sequence.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const scheduleNext = useCallback(
    (delayMs: number) => {
      clearTimer();
      if (!runningRef.current) return;

      timerRef.current = setTimeout(() => {
        if (!runningRef.current) return;
        void poll();
      }, delayMs);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [clearTimer],
  );

  /**
   * Stops or pauses the current session, per `PAUSABLE_REASONS`.
   *
   * A pausable reason keeps `jobIdRef`/`callbacksRef` intact so `resume()`
   * can restart polling for the SAME job; a genuine stop clears both, so a
   * later `resume()` call is a safe no-op (nothing left to resume).
   */
  const stop = useCallback(
    (reason: PollStopReason) => {
      runningRef.current = false;
      clearTimer();
      abort();
      generationRef.current += 1;
      const pausable = PAUSABLE_REASONS.has(reason);
      setStatus(pausable ? "paused" : "idle");
      callbacksRef.current?.onStop(reason);
      if (!pausable) {
        callbacksRef.current = null;
        jobIdRef.current = null;
      }
    },
    [clearTimer, abort],
  );

  const poll = useCallback(async () => {
    const jobId = jobIdRef.current;
    const callbacks = callbacksRef.current;
    const gen = generationRef.current;
    if (!runningRef.current || jobId === null || callbacks === null) return;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: snapshot } = await getInvestigationState(jobId, controller.signal);

      // Stale check — abort or a newer poll session may have invalidated this tick.
      if (!runningRef.current || generationRef.current !== gen) return;
      if (controller.signal.aborted) return;

      // Success — reset the transient backoff counter.
      consecutiveFailuresRef.current = 0;
      callbacks.onSnapshot({ snapshot, pollGeneration: gen });

      // The callback may have synchronously stopped the session (e.g. a
      // terminal observation calls poll.stop("terminal") from inside
      // onSnapshot). Re-check liveness/generation before scheduling anything
      // further — a session App just stopped must never get one more tick.
      if (!runningRef.current || generationRef.current !== gen) return;

      // The 5-minute ceiling applies to EVERY tick, healthy or not — a run
      // left RUNNING forever (an event-emission failure, a crashed worker)
      // must not poll indefinitely just because every individual response
      // happens to succeed.
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed >= FIVE_MINUTES_MS) {
        stop("time-ceiling");
        return;
      }
      scheduleNext(healthyInterval(elapsed));
    } catch (error) {
      if (!runningRef.current || generationRef.current !== gen) return;
      if (error instanceof DOMException && error.name === "AbortError") return;

      const classification = classifyInvestigationPollError(error);
      callbacks.onError({ classification, pollGeneration: gen });

      if (classification.kind === "transient") {
        consecutiveFailuresRef.current += 1;
        const elapsed = Date.now() - startTimeRef.current;

        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
          stop("transient-ceiling");
          return;
        }
        if (elapsed >= FIVE_MINUTES_MS) {
          stop("time-ceiling");
          return;
        }

        scheduleNext(transientBackoff(consecutiveFailuresRef.current));
        return;
      }

      // Non-transient — stop/pause immediately.
      if (classification.kind === "not-found") {
        stop("not-found");
      } else if (classification.kind === "data-corrupt") {
        stop("data-corrupt");
      } else {
        stop("permanent-invalid");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleNext, stop]);

  const start = useCallback(
    (jobId: string, callbacks: PollCallbacks) => {
      // Invalidate any previous session — a genuine stop, not a pause, since
      // this is a NEW job/session replacing whatever came before.
      stop("aborted");

      runningRef.current = true;
      generationRef.current += 1;
      startTimeRef.current = Date.now();
      consecutiveFailuresRef.current = 0;
      jobIdRef.current = jobId;
      callbacksRef.current = callbacks;
      setStatus("polling");

      // Kick off the first tick immediately.
      scheduleNext(0);
    },
    [stop, scheduleNext],
  );

  /**
   * "Check again" — restarts a fresh bounded session for the SAME job after
   * a `transient-ceiling` / `time-ceiling` / `data-corrupt` pause, resetting
   * the failure counter, the 5-minute budget, and the backoff sequence.
   *
   * A no-op when there is nothing resumable: `not-found` / `permanent-invalid`
   * / `terminal` / `aborted` sessions clear `jobIdRef`/`callbacksRef` in
   * `stop()`, so this returns immediately for any of those.
   *
   * Deliberately does NOT call `stop()` first — that would emit a spurious
   * `onStop("aborted")` for the very session being resumed. Instead it
   * invalidates the paused session's timer/controller/generation directly,
   * without notifying the caller of a stop that never conceptually happened.
   */
  const resume = useCallback(() => {
    const jobId = jobIdRef.current;
    const callbacks = callbacksRef.current;
    if (jobId === null || callbacks === null) return;

    clearTimer();
    abort();
    generationRef.current += 1;

    runningRef.current = true;
    startTimeRef.current = Date.now();
    consecutiveFailuresRef.current = 0;
    setStatus("polling");

    scheduleNext(0);
  }, [clearTimer, abort, scheduleNext]);

  /**
   * Establishes a resumable `paused` session for `jobId` WITHOUT firing any
   * request — the counterpart to `stop(reason)` for ingestion paths that
   * observe canonical-invalid data OUTSIDE of an active polling tick (mount/
   * popstate resume, a terminal POST/Refresh authoritative final read) and
   * therefore have no live session for `stop()` to pause. `resume()` ("Check
   * again") then performs the one fresh bounded GET on demand.
   *
   * Deliberately does NOT call `stop()` first and does NOT invoke
   * `callbacks.onStop(...)` — the caller already knows why it is entering
   * this state (it is choosing the outcome deliberately, not reacting to a
   * poll tick's failure), so no spurious stop notification is emitted.
   */
  const enterPaused = useCallback(
    (jobId: string, callbacks: PollCallbacks) => {
      clearTimer();
      abort();
      runningRef.current = false;
      generationRef.current += 1;
      consecutiveFailuresRef.current = 0;
      jobIdRef.current = jobId;
      callbacksRef.current = callbacks;
      setStatus("paused");
    },
    [clearTimer, abort],
  );

  return { status, start, stop, resume, enterPaused };
}
