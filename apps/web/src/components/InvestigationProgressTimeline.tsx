import type { InvestigationProgressStageViewModel } from "../investigation-progress/investigation-progress-stages";
import { presentInvestigationProgressStage } from "../investigation-progress/investigation-progress-stages";

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
// what the four rows already show. "Live availability" never renders as a
// stepper row at all — it is lightweight preflight metadata, a single line
// above the stepper. A legacy run (no canonical breakdown) falls back to the
// plain job/run/approval system-row stepper, unchanged.
export function InvestigationProgressTimeline({
  stages,
  elapsedLabel,
  executionDetailNote,
}: InvestigationProgressTimelineProps) {
  // The run row is the one that may carry the four canonical children.
  const runRow = stages.find((s) => s.key === "run");
  const canonicalStages = runRow?.children !== undefined && runRow.children.length > 0 ? runRow.children : null;

  const availabilityStage = stages.find((s) => s.key === "availability") ?? null;
  // The job/run rows only render as system rows in the legacy fallback —
  // once the four canonical stages exist, they would just restate row 1
  // ("Investigation created") and the run's own status.
  const systemStages = stages.filter(
    (s) => s.key !== "availability" && (canonicalStages === null || (s.key !== "job" && s.key !== "run")),
  );

  return (
    <section className="investigation-progress" aria-labelledby="investigation-progress-heading">
      <h2 id="investigation-progress-heading" tabIndex={-1}>
        Investigation progress
      </h2>
      <p className="investigation-progress-elapsed">Elapsed: {elapsedLabel}</p>
      {availabilityStage !== null ? (
        <p className="investigation-progress-preflight">
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
                    <span className="investigation-progress-status">{badgeLabel}</span>
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
              className={`investigation-progress-item investigation-progress-item--system investigation-progress-item--${stage.status}`}
            >
              <span className="investigation-progress-marker" aria-hidden="true">
                <span className={`investigation-progress-node investigation-progress-node--${stage.status}`}>
                  {presentation.glyph}
                </span>
              </span>
              <div className="investigation-progress-content">
                <div className="investigation-progress-title">
                  <span className="investigation-progress-label">{stage.label}</span>
                  <span className="investigation-progress-status">{presentation.badgeLabel}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {executionDetailNote !== null && (
        <p className="investigation-progress-note">{executionDetailNote}</p>
      )}
    </section>
  );
}
