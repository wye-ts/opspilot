/**
 * Terminal settlement coordinator — pure decision function, no refs.
 *
 * The blocking POST and the poller are two independent observers of the same
 * run; either may see the terminal outcome first. This function decides whether
 * THIS observation is the first ("owner"), a harmless duplicate (same identity
 * + same status), or an impossible internal-consistency failure (same identity
 * + OPPOSITE status).
 *
 * The ref that holds the last claim lives in App.tsx; this module is just the
 * decision function, unit-tested with a plain object standing in for the ref's
 * current value.
 */

export interface TerminalSettlementIdentity {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  /**
   * The MAIN App workflow generation from `beginWorkflow()` — the same number
   * `isStale(generation)` already checks at every call site. NEVER
   * `useInvestigationPoll`'s own internal generation: that number exists purely
   * for the poll hook's own overlap bookkeeping and is not visible outside it.
   */
  readonly generation: number;
}

/**
 * Durable finalization phase for a claimed identity (independent review
 * Finding 3 — Codex review).
 *
 * `resolveTerminalObservation` alone only decides ownership at the MOMENT an
 * observation arrives — it cannot see a contradiction that arrives LATER,
 * while the owner is awaiting an authoritative final read or an approval
 * fetch. Without a durable marker, the owner's continuation would resume
 * from that await still believing itself authorized, and overwrite the
 * inconsistency notice/state a later contradictory observation already
 * applied.
 *
 * - `finalizing` — an owner claimed this identity and is still working
 *   through its (possibly async) settlement continuation.
 * - `settled` — the owner's continuation completed its terminal writes.
 * - `inconsistent` — a contradictory observation arrived for this identity;
 *   PERMANENT for this identity. No pending or future continuation for it
 *   may perform a normal terminal write again.
 */
export type TerminalSettlementPhase = "finalizing" | "settled" | "inconsistent";

export interface TerminalSettlementClaim {
  readonly identity: TerminalSettlementIdentity;
  readonly terminalStatus: "COMPLETED" | "FAILED";
  readonly phase: TerminalSettlementPhase;
}

export type TerminalObservationDecision =
  | { readonly kind: "owner" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "inconsistent-terminal-status" }
  /**
   * This identity was ALREADY marked `inconsistent` by an earlier
   * observation — this one arrived even later. Handled identically to
   * `inconsistent-terminal-status` by callers (the fixed safety notice
   * already stands), kept distinct only so a caller can tell "I just found
   * the contradiction" apart from "someone else already did".
   */
  | { readonly kind: "already-inconsistent" };

function sameTerminalSettlementIdentity(a: TerminalSettlementIdentity, b: TerminalSettlementIdentity): boolean {
  return a.jobId === b.jobId && a.runId === b.runId && a.attemptNumber === b.attemptNumber && a.generation === b.generation;
}

/**
 * Pure function — takes the ref's current value as a plain argument rather
 * than reading a ref itself, so it is trivially unit-testable.
 *
 * Rules:
 * - No prior claim for this identity → record identity + status, phase
 *   `"finalizing"` → `"owner"`
 * - Prior claim for this identity already `"inconsistent"` → `"already-inconsistent"`,
 *   claim unchanged (permanent — see `TerminalSettlementPhase`)
 * - Same identity + same terminal status → `"duplicate"`, claim unchanged
 * - Same identity + opposite terminal status → `"inconsistent-terminal-status"`,
 *   claim's `terminalStatus` preserved (the first accepted state), phase set
 *   to `"inconsistent"`
 */
export function resolveTerminalObservation(
  priorClaim: TerminalSettlementClaim | null,
  identity: TerminalSettlementIdentity,
  terminalStatus: "COMPLETED" | "FAILED",
): { readonly decision: TerminalObservationDecision; readonly nextClaim: TerminalSettlementClaim } {
  const sameIdentity = priorClaim !== null && sameTerminalSettlementIdentity(priorClaim.identity, identity);

  if (!sameIdentity) {
    return { decision: { kind: "owner" }, nextClaim: { identity, terminalStatus, phase: "finalizing" } };
  }

  if (priorClaim.phase === "inconsistent") {
    return { decision: { kind: "already-inconsistent" }, nextClaim: priorClaim };
  }

  if (priorClaim.terminalStatus === terminalStatus) {
    return { decision: { kind: "duplicate" }, nextClaim: priorClaim };
  }

  return {
    decision: { kind: "inconsistent-terminal-status" },
    nextClaim: { ...priorClaim, phase: "inconsistent" },
  };
}

/**
 * Whether a claimed OWNER's continuation is still authorized to perform a
 * normal terminal write. Must be called with the ref's LATEST value —
 * immediately after every await inside the owner's continuation, and
 * immediately before every terminal state/notice/clock/approval write — not
 * cached from before any await, since a contradictory observation could
 * have arrived and changed it during that await.
 */
export function isFinalizationAuthorized(
  currentClaim: TerminalSettlementClaim | null,
  identity: TerminalSettlementIdentity,
): boolean {
  return currentClaim !== null && sameTerminalSettlementIdentity(currentClaim.identity, identity) && currentClaim.phase !== "inconsistent";
}

/**
 * Marks a still-authorized owner's claim `"settled"` once its terminal
 * writes are complete. A no-op (returns `currentClaim` unchanged) if the
 * claim no longer matches this identity or is no longer authorized — never
 * resurrects an identity that was marked `inconsistent` during finalization.
 */
export function markFinalizationSettled(
  currentClaim: TerminalSettlementClaim | null,
  identity: TerminalSettlementIdentity,
): TerminalSettlementClaim | null {
  if (currentClaim === null || !isFinalizationAuthorized(currentClaim, identity)) return currentClaim;
  return { ...currentClaim, phase: "settled" };
}
