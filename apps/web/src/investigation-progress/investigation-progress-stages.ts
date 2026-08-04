import type { BadgeTone } from "../components/StatusBadge";

export type InvestigationProgressStageKey = "availability" | "job" | "run" | "approval";

export type InvestigationProgressStageStatus = "pending" | "active" | "completed" | "failed";

/**
 * Distinguishes not-started, in-flight, completed (including "no approval
 * applicable" — a NOT_ELIGIBLE result is still a LOADED approval read), and
 * failed. `approval === null` alone cannot tell these apart, which is exactly
 * the ambiguity this type exists to remove.
 */
export type ApprovalLoadStatus = "idle" | "loading" | "loaded" | "failed";

/** The agent's own outcome for an existing run, or `null` when no run exists yet. */
export type RunOutcomeKind = "RUNNING" | "COMPLETED" | "FAILED";

export interface InvestigationProgressStageViewModel {
  readonly key: InvestigationProgressStageKey;
  readonly status: InvestigationProgressStageStatus;
  readonly label: string;
}

/**
 * THE canonical stage-label source — exactly the owner-approved copy, no
 * arbitrary rewording. Used by the visual active/completed stage rows below
 * AND, via App.tsx's `PHASE_LABELS`, by the submit button's busy copy and the
 * sole `role="status"` live region — one source, not two independently
 * maintained strings that can drift out of sync with each other.
 *
 * Only two labels per stage: no separate "failed" or "pending" phrasing
 * exists, because a failed/pending stage is still described by what it was
 * about to do (see stageViewModel below); the StatusBadge alongside it (or,
 * for the live region, `stageFailureAnnouncement` below) carries the actual
 * status.
 */
export const STAGE_LABELS: Record<InvestigationProgressStageKey, { readonly active: string; readonly completed: string }> = {
  availability: { active: "Checking Live Claude availability…", completed: "Live Claude availability confirmed" },
  job: { active: "Creating investigation…", completed: "Investigation created" },
  run: { active: "Agent investigation in progress…", completed: "Investigation complete" },
  approval: { active: "Loading approval state…", completed: "Approval state loaded" },
};

// The plain-text terminal-success announcement for the live region — reuses
// the "run" stage's own completed label rather than a second, independently
// worded string.
export const INVESTIGATION_COMPLETE_ANNOUNCEMENT = `${STAGE_LABELS.run.completed}.`;

// Appended to a terminal-success announcement when the completed run's
// approval is PENDING. Shared so the wording cannot drift between the
// submit/retry/refresh call sites that compose it.
export const APPROVAL_REQUIRED_ANNOUNCEMENT = "Human approval required.";

// ONE composition point for "investigation complete[, approval required]" —
// every submit/retry/refresh call site that settles a COMPLETED run reuses
// this rather than re-deriving the same ternary, so a future wording change
// cannot be applied to some call sites and missed on others.
export function investigationCompleteAnnouncement(approvalPending: boolean): string {
  return approvalPending
    ? `${INVESTIGATION_COMPLETE_ANNOUNCEMENT} ${APPROVAL_REQUIRED_ANNOUNCEMENT}`
    : INVESTIGATION_COMPLETE_ANNOUNCEMENT;
}

// Concise, stage-specific terminal-failure text for the live region —
// derived from the same stage metadata as the visual Failed badge, never
// from raw provider/server output (that stays in the separate ErrorBanner).
// Only for the three stages whose failure stops the whole submission
// (`availability`/`job`/`run`); an approval-load failure does not stop the
// workflow (the report/trace stay visible) and already has its own
// ErrorBanner announcement.
export function stageFailureAnnouncement(key: "availability" | "job" | "run"): string {
  switch (key) {
    case "availability":
      return "Investigation failed while checking Live Claude availability.";
    case "job":
      return "Investigation failed while creating the investigation.";
    case "run":
      return "Investigation failed while running the agent investigation.";
  }
}

export interface DeriveInvestigationProgressStagesInput {
  readonly providerMode: "FAKE" | "LIVE";
  /** The stage the CURRENT phase maps to, or null when idle/refreshing/submitting-approval. */
  readonly activeStageKey: "availability" | "job" | "run" | null;
  /** Set only at the exact request boundary that failed (an HTTP/network failure); never inferred. */
  readonly failedStage: InvestigationProgressStageKey | null;
  readonly jobCreated: boolean;
  /**
   * The agent's own outcome for the CURRENT run, or `null` before a run
   * exists. THE run stage's status is a function of this, never of
   * `run !== null` alone — a run object can exist with a non-terminal
   * (`RUNNING`) or unsuccessful (`FAILED`) outcome, and treating either as
   * "Completed" would announce success that never happened.
   */
  readonly runOutcomeType: RunOutcomeKind | null;
  readonly approvalLoadStatus: ApprovalLoadStatus;
}

function stageViewModel(key: InvestigationProgressStageKey, status: InvestigationProgressStageStatus): InvestigationProgressStageViewModel {
  const labels = STAGE_LABELS[key];
  return { key, status, label: status === "completed" ? labels.completed : labels.active };
}

function approvalStageStatus(approvalLoadStatus: ApprovalLoadStatus): InvestigationProgressStageStatus {
  switch (approvalLoadStatus) {
    case "idle":
      return "pending";
    case "loading":
      return "active";
    case "loaded":
      return "completed";
    case "failed":
      return "failed";
  }
}

/**
 * The run stage is the one row whose status is NOT a simple pending/active/
 * completed progression through request boundaries: the underlying HTTP
 * request can resolve (run !== null) while the agent's own work is still
 * `RUNNING` — Phase A has no polling (#38 is explicitly out of scope), so
 * that state can persist until the user's own Refresh click returns a
 * terminal outcome. A `RUNNING` outcome therefore reads as Active, not
 * Completed and not Pending, for as long as it remains the run's outcome.
 */
function runStageStatus(input: DeriveInvestigationProgressStagesInput): InvestigationProgressStageStatus {
  if (input.failedStage === "run" || input.runOutcomeType === "FAILED") return "failed";
  if (input.activeStageKey === "run") return "active";
  if (input.runOutcomeType === "RUNNING") return "active";
  if (input.runOutcomeType === "COMPLETED") return "completed";
  return "pending";
}

// True once execution has DEMONSTRABLY moved past the LIVE preflight — never
// inferred from elapsed time or a timer, only from real signals that can
// only be true after the preflight succeeded.
function isAvailabilityCompleted(input: DeriveInvestigationProgressStagesInput): boolean {
  return (
    input.jobCreated ||
    input.runOutcomeType !== null ||
    input.failedStage === "job" ||
    input.failedStage === "run" ||
    input.activeStageKey === "job" ||
    input.activeStageKey === "run"
  );
}

/**
 * Pure, derived from real request-lifecycle and outcome signals only — no
 * stage is ever advanced by a timer, and no stage is ever assigned a
 * percentage.
 *
 * `approval` is deliberately driven ONLY by `approvalLoadStatus`, never by
 * `activeStageKey`/`phase` — the underlying `loading-approval` phase is
 * reused by the initial submission, both retry paths, AND the unrelated
 * Refresh action, so phase alone cannot tell "this investigation's approval
 * fetch" apart from "a much later manual refresh". `approvalLoadStatus` is
 * the one signal set exclusively by an approval fetch that App.tsx has
 * chosen to track, and App.tsx never starts that fetch at all unless
 * `runOutcomeType === "COMPLETED"` — so a `RUNNING`/`FAILED` run correctly
 * leaves this row Pending without this function needing to know why.
 */
export function deriveInvestigationProgressStages(
  input: DeriveInvestigationProgressStagesInput,
): readonly InvestigationProgressStageViewModel[] {
  const keys: readonly InvestigationProgressStageKey[] =
    input.providerMode === "LIVE" ? ["availability", "job", "run", "approval"] : ["job", "run", "approval"];

  let blocked = false;
  return keys.map((key) => {
    if (key === "approval") {
      return stageViewModel(key, approvalStageStatus(input.approvalLoadStatus));
    }
    if (blocked) {
      return stageViewModel(key, "pending");
    }
    if (key === "run") {
      const status = runStageStatus(input);
      if (status !== "completed") blocked = true;
      return stageViewModel(key, status);
    }
    if (input.failedStage === key) {
      blocked = true;
      return stageViewModel(key, "failed");
    }
    if (input.activeStageKey === key) {
      blocked = true;
      return stageViewModel(key, "active");
    }
    const completed = key === "availability" ? isAvailabilityCompleted(input) : input.jobCreated;
    if (!completed) blocked = true;
    return stageViewModel(key, completed ? "completed" : "pending");
  });
}

export interface InvestigationProgressStagePresentation {
  readonly tone: BadgeTone;
  readonly glyph: string;
  readonly badgeLabel: string;
}

// Status is never color alone — every row pairs this badge (glyph + text)
// with the stage's own label text, mirroring runStatusBadge/presentApproval.
export function presentInvestigationProgressStage(status: InvestigationProgressStageStatus): InvestigationProgressStagePresentation {
  switch (status) {
    case "pending":
      return { tone: "neutral", glyph: "—", badgeLabel: "Pending" };
    case "active":
      return { tone: "info", glyph: "●", badgeLabel: "In progress" };
    case "completed":
      return { tone: "success", glyph: "✓", badgeLabel: "Done" };
    case "failed":
      return { tone: "danger", glyph: "✕", badgeLabel: "Failed" };
  }
}
