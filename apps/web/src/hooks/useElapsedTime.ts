import { useEffect, useState } from "react";

/**
 * The single overall elapsed clock for the current investigation submission.
 *
 * `startedAt`/`finishedAt` are epoch-ms timestamps the CALLER sets at exact
 * request-boundary events (never inferred here) — `finishedAt` specifically
 * must come from a persisted/authoritative source (e.g. the run's own
 * `finishedAt`), never `Date.now()`, whenever `isTerminal` is true.
 *
 * Three states:
 * - `startedAt === null`: nothing submitted yet (or a full reset) — 0.
 * - `finishedAt !== null`: frozen at `finishedAt - startedAt`, permanently —
 *   never ticks again regardless of `isTerminal`.
 * - `finishedAt === null`:
 *   - `isTerminal === false` (genuinely still running / request in flight):
 *     ticks at ~1s resolution against `Date.now()`, as before.
 *   - `isTerminal === true`: the run IS terminal but has no trustworthy
 *     persisted finish time — a data anomaly, not a still-running run. Fails
 *     safe: returns `null` rather than inventing a number from `Date.now()`
 *     (which would either freeze at a wrong value, or — if this state were
 *     ever mistaken for "running" — tick forever past a run that already
 *     finished). Never starts/keeps an interval in this state.
 */
export function useElapsedTime(startedAt: number | null, finishedAt: number | null, isTerminal: boolean): number | null {
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Only a genuinely still-running/in-flight measurement ticks. A terminal
  // run with a missing finishedAt must NOT tick — see the fail-safe case
  // in the doc comment above.
  const shouldTick = startedAt !== null && finishedAt === null && !isTerminal;

  useEffect(() => {
    if (!shouldTick) return;
    setNowTick(Date.now());
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldTick, startedAt]);

  if (startedAt === null) return 0;
  if (finishedAt !== null) return Math.max(0, finishedAt - startedAt);
  if (isTerminal) return null;
  return Math.max(0, nowTick - startedAt);
}

// "1m 30s" is bulkier than plain seconds under 60s, so this switches format
// rather than always showing minutes — an elapsed-time reader never has a
// negative or fractional-second value to render. `null` (the fail-safe
// case above) renders the same "—" placeholder used elsewhere in the app
// for a value that cannot be trusted/computed (see format/datetime.ts).
export function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "—";
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
