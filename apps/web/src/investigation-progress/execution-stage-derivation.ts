import {
  deriveExecutionStageProgress,
  hasCanonicalInvestigationLifecycleMarker,
  type ExecutionStageProgress,
  type InvestigationEventRecord,
  type InvestigationRunStatus,
} from "@opspilot/contracts";

/**
 * The three states canonical execution-stage derivation can be in.
 *
 * Deliberately NOT a boolean-plus-nullable-list: a corrupt canonical stream
 * must never be representable the same way as a legacy stream, because the
 * rendering rule for each is different (§4/§5).
 */
export type ExecutionStageDerivation =
  | { readonly kind: "legacy" }
  | { readonly kind: "canonical"; readonly stages: readonly ExecutionStageProgress[] }
  | { readonly kind: "canonical-invalid"; readonly lastGoodStages: readonly ExecutionStageProgress[] | null };

/**
 * Derives the execution-stage state from the canonical events, run status, and
 * the previous derivation (to preserve last-good stages across a corruption
 * event).
 *
 * `now` is computed once, at the moment a snapshot is accepted — the reducer's
 * `elapsedMs` field is not rendered per-row today, so there is no need to
 * recompute this on a ticking timer.
 */
export function deriveExecutionStageDerivation(
  events: readonly InvestigationEventRecord[],
  runStatus: InvestigationRunStatus,
  now: string,
  previous: ExecutionStageDerivation,
): ExecutionStageDerivation {
  if (!hasCanonicalInvestigationLifecycleMarker(events)) {
    return { kind: "legacy" };
  }

  try {
    return {
      kind: "canonical",
      stages: deriveExecutionStageProgress({ events, runStatus, now }),
    };
  } catch {
    const lastGoodStages =
      previous.kind === "canonical"
        ? previous.stages
        : previous.kind === "canonical-invalid"
          ? previous.lastGoodStages
          : null;
    return { kind: "canonical-invalid", lastGoodStages };
  }
}

/** The stable run identity `lastGoodStages` reuse must be scoped to. */
export interface ExecutionStageIdentity {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptNumber: number;
}

/** A derivation together with the run identity it was computed for. */
export interface ExecutionStageDerivationState {
  readonly identity: ExecutionStageIdentity;
  readonly derivation: ExecutionStageDerivation;
}

function sameExecutionStageIdentity(a: ExecutionStageIdentity, b: ExecutionStageIdentity): boolean {
  return a.jobId === b.jobId && a.runId === b.runId && a.attemptNumber === b.attemptNumber;
}

/**
 * The ONE path every accepted canonical snapshot must derive execution-stage
 * state through — poll, the POST/Refresh authoritative final snapshot,
 * mount/popstate resume, and retry/recovery snapshots alike (independent
 * review Findings 5 and 6 — Codex review).
 *
 * `deriveExecutionStageDerivation` itself has no notion of run identity: it
 * blindly reuses whatever `previous` it is handed. Findings 5/6's fix is
 * this one wrapper — never call `deriveExecutionStageDerivation` directly
 * from an ingestion path again. It resets `previous` to `{ kind: "legacy" }`
 * whenever the candidate's job/run/attempt identity differs from the
 * previously-held state's identity, so:
 *
 * - a first invalid snapshot for a NEW attempt/run/job never inherits a
 *   DIFFERENT run's `lastGoodStages` (Finding 6);
 * - EVERY ingestion path shares the identical fail-closed policy, so a
 *   canonical-invalid result is never silently treated as `legacy` by an
 *   entry point that forgot to check (Finding 5).
 */
export function applyAcceptedSnapshotDerivation(
  identity: ExecutionStageIdentity,
  events: readonly InvestigationEventRecord[],
  runStatus: InvestigationRunStatus,
  now: string,
  previous: ExecutionStageDerivationState | null,
): ExecutionStageDerivationState {
  const previousDerivation: ExecutionStageDerivation =
    previous !== null && sameExecutionStageIdentity(previous.identity, identity) ? previous.derivation : { kind: "legacy" };
  const derivation = deriveExecutionStageDerivation(events, runStatus, now, previousDerivation);
  return { identity, derivation };
}
