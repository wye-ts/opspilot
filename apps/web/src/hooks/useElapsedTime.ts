import { useEffect, useState } from "react";

/**
 * The single overall elapsed clock for the current investigation submission.
 *
 * `startedAt`/`finishedAt` are epoch-ms timestamps the CALLER sets at exact
 * request-boundary events (never inferred here). While `finishedAt` is null
 * and `startedAt` is set, this ticks at ~1s resolution; the moment the caller
 * sets `finishedAt`, the interval stops and the returned value freezes at
 * `finishedAt - startedAt` — it does not keep counting, and it does not reset
 * to 0 on its own. `startedAt === null` (nothing submitted yet, or a full
 * reset) returns 0.
 */
export function useElapsedTime(startedAt: number | null, finishedAt: number | null): number {
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null || finishedAt !== null) return;
    setNowTick(Date.now());
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [startedAt, finishedAt]);

  if (startedAt === null) return 0;
  const endAt = finishedAt ?? nowTick;
  return Math.max(0, endAt - startedAt);
}

// "1m 30s" is bulkier than plain seconds under 60s, so this switches format
// rather than always showing minutes — an elapsed-time reader never has a
// negative or fractional-second value to render.
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
