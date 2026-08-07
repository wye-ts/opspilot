import type { InvestigationStateResponse } from "../api/types";

/**
 * Pure helper for deciding whether an incoming poll response may replace the
 * currently-held investigation snapshot. Returns `true` only when the
 * incoming data is demonstrably newer — never walks the Timeline backwards.
 *
 * This is used ONLY by poll ticks to determine whether a snapshot may update
 * `run`/`events`. The separate question of who performs terminal side effects
 * is decided by the terminal settlement coordinator (§5).
 */
export function isNewerInvestigationSnapshot(
  current: InvestigationStateResponse,
  currentJobId: string,
  currentPollGeneration: number,
  minAttemptNumber: number,
  incoming: InvestigationStateResponse,
  incomingPollGeneration: number,
): boolean {
  // Stale poll generation — this fetch was superseded by a new polling session.
  if (incomingPollGeneration < currentPollGeneration) return false;

  // Different job — navigation happened while this tick was in flight.
  if (incoming.job.id !== currentJobId) return false;

  // Incoming has no run while we already know one — regressive.
  if (incoming.run === null && current.run !== null) return false;

  // Both have runs — check attempt and monotonicity.
  if (incoming.run !== null && current.run !== null) {
    // Below the attempt floor from a retry.
    if (incoming.run.attemptNumber < minAttemptNumber) return false;

    // Below the CURRENTLY HELD attempt — independent of minAttemptNumber.
    // minAttemptNumber is set once, before a retry's own new POST begins;
    // it does not track the highest attempt ACTUALLY OBSERVED so far. A late
    // poll snapshot for an older attempt can pass the floor check yet still
    // be older than what is already on screen (e.g. current=attempt 2,
    // incoming=attempt 1, floor=1) — this rule closes that gap.
    if (incoming.run.attemptNumber < current.run.attemptNumber) return false;

    // RUNNING arriving after we already saw a terminal is regressive.
    if (incoming.run.status === "RUNNING" && current.run.status !== "RUNNING") return false;

    // Fewer events than we already hold for the same runId — can't walk backwards.
    if (
      incoming.run.id === current.run.id &&
      incoming.events.length < current.events.length
    ) {
      return false;
    }
  }

  return true;
}
