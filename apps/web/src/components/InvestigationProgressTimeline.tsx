import type { InvestigationProgressStageViewModel } from "../investigation-progress/investigation-progress-stages";
import { presentInvestigationProgressStage } from "../investigation-progress/investigation-progress-stages";
import type { RunStatusBadgePresentation } from "../run/run-overview-presentation";

export interface InvestigationProgressTimelineProps {
  readonly stages: readonly InvestigationProgressStageViewModel[];
  readonly elapsedLabel: string;
  /**
   * Rendered as one `<p>` directly under the stepper, only when non-null.
   * This is Timeline-adjacent context (e.g. "Detailed step-by-step progress
   * isn't available…"), not a stage fact — it must not be folded into any
   * one row's label.
   */
  readonly executionDetailNote: string | null;
  /**
   * The overall investigation lifecycle state (Running/Completed/Failed),
   * `null` before any run exists yet. Rendered in the card header, top-right
   * — this is the OVERALL state, never a fifth timeline stage (HQ item 4).
   */
  readonly overallStatus: RunStatusBadgePresentation | null;
}

// Frontend-known request-lifecycle stages only — never backend diagnostic
// events (that is TraceTimeline/"Agent activity", a separate data source).
// Every stage is Pending/Active/Completed/Failed/Omitted; never a percentage,
// never advanced by a timer. Elapsed time is plain visible text, deliberately
// outside the app's one aria-live region (docs/14-web-ui.md §9) — a ticking
// value re-announced every second would be unusable with a screen reader.
//
// Rendered as a compact vertical lifecycle stepper (Issue #41 HQ polish §1):
// the four authoritative execution stages (Investigation created / Agent
// analysis / Diagnostic execution / Report generation) are the ONLY visually
// dominant stepper rows, and are NEVER collapsed. When they are available
// (a canonical run), the request-lifecycle "job" and "run" rows are omitted
// entirely rather than merely de-emphasized — "job"'s own "Investigation
// created" would duplicate the first canonical stage, and "run"'s own
// "Agent investigation in progress…"/"Investigation complete" would restate
// what the four rows already show. Final UX Pilot fidelity pass, HQ review —
// the reference's Progress card shows nothing about Live availability or
// approval loading at all, so both are rendered `sr-only`: present in the
// accessibility tree (screen-reader users still get the fact, and every
// existing test keeps working unchanged), but never visible on screen. A
// legacy run (no canonical breakdown) falls back to the plain job/run
// system-row stepper, with approval still sr-only.
export function InvestigationProgressTimeline({
  stages,
  elapsedLabel,
  executionDetailNote,
  overallStatus,
}: InvestigationProgressTimelineProps) {
  // The run row is the one that may carry the four canonical children.
  const runRow = stages.find((s) => s.key === "run");
  const canonicalStages = runRow?.children !== undefined && runRow.children.length > 0 ? runRow.children : null;

  const availabilityStage = stages.find((s) => s.key === "availability") ?? null;
  // The job/run rows only render as system rows in the legacy fallback —
  // once the four canonical stages exist, they would just restate row 1
  // ("Investigation created") and the run's own status. Approval renders in
  // every case (below), but always `sr-only` — see the module comment above.
  const systemStages = stages.filter(
    (s) => s.key !== "availability" && (canonicalStages === null || (s.key !== "job" && s.key !== "run")),
  );

  return (
    <section className="investigation-progress" aria-labelledby="investigation-progress-heading">
      <div className="investigation-progress-header">
        <h2 id="investigation-progress-heading" tabIndex={-1}>
          Investigation progress
        </h2>
        {overallStatus !== null ? (
          <span className={`investigation-progress-overall-status investigation-progress-overall-status--${overallStatus.tone}`}>
            {overallStatus.label}
          </span>
        ) : null}
      </div>
      {availabilityStage !== null ? (
        <p className="investigation-progress-preflight sr-only">
          <span
            className={`investigation-progress-preflight-glyph investigation-progress-preflight-glyph--${availabilityStage.status}`}
            aria-hidden="true"
          >
            {presentInvestigationProgressStage(availabilityStage.status).glyph}
          </span>
          <span className="investigation-progress-preflight-label">{availabilityStage.label}</span>
          <span className="investigation-progress-preflight-status">
            {presentInvestigationProgressStage(availabilityStage.status).badgeLabel}
          </span>
        </p>
      ) : null}
      {canonicalStages !== null ? (
        <ol className="investigation-progress-children-list">
          {canonicalStages.map((child) => {
            const childPresentation = presentInvestigationProgressStage(child.status);
            const badgeLabel = child.notReached === true ? "Not reached" : childPresentation.badgeLabel;
            const hasNestedEvents =
              child.events !== undefined &&
              child.events.length > 0 &&
              // A stage that provably never ran renders no nested activity —
              // nothing was observed for it to show.
              child.status !== "omitted";
            return (
              <li
                key={child.key}
                className={`investigation-progress-item investigation-progress-item--primary investigation-progress-item--${child.status}`}
              >
                <span className="investigation-progress-marker" aria-hidden="true">
                  <span className={`investigation-progress-node investigation-progress-node--${child.status}`}>
                    {childPresentation.glyph}
                  </span>
                </span>
                <div className="investigation-progress-content">
                  <div className="investigation-progress-title">
                    <span className="investigation-progress-label">{child.label}</span>
                    {/* Visually suppressed (HQ item 4 — no repeated "Done"
                        etc. per row) but kept for screen readers, which get
                        no other status signal for this row: the icon carries
                        color+shape only, and it's the sole marker of state. */}
                    <span className="investigation-progress-status sr-only">{badgeLabel}</span>
                  </div>
                  {hasNestedEvents && (
                    <ol className="investigation-progress-event-list">
                      {child.events!.map((event) => (
                        <li key={event.sequence} className="investigation-progress-event-item">
                          {event.label}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      <ol className="investigation-progress-list">
        {systemStages.map((stage) => {
          const presentation = presentInvestigationProgressStage(stage.status);
          return (
            <li
              key={stage.key}
              className={`investigation-progress-item investigation-progress-item--system investigation-progress-item--${stage.status}${stage.key === "approval" ? " investigation-progress-item--approval sr-only" : ""}`}
            >
              <span className="investigation-progress-marker" aria-hidden="true">
                <span className={`investigation-progress-node investigation-progress-node--${stage.status}`}>
                  {presentation.glyph}
                </span>
              </span>
              <div className="investigation-progress-content">
                <div className="investigation-progress-title">
                  <span className="investigation-progress-label">{stage.label}</span>
                  {/* Same sr-only treatment as the canonical rows above —
                      restyled, not removed, per HQ item 4's legacy-fallback
                      preservation (this row set only renders for a run with
                      no canonical event breakdown, a real degraded-data
                      state, not mock-covered content). */}
                  <span className="investigation-progress-status sr-only">{presentation.badgeLabel}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {executionDetailNote !== null && (
        <p className="investigation-progress-note">{executionDetailNote}</p>
      )}
      {/* Final UX Pilot fidelity pass, HQ item 4 — moved from the top (under
          the heading) to the bottom-right, small/muted/low-emphasis, not a
          badge. Logic (`useElapsedTime`/`formatElapsed`) is untouched; this
          is a pure position change. Still outside the app's aria-live
          region (see the module comment above) — a per-second ticking value
          is never re-announced. */}
      <p className="investigation-progress-elapsed">Elapsed: {elapsedLabel}</p>
    </section>
  );
}
