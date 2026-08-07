import { useEffect, useState } from "react";
import type { InvestigationProgressStageViewModel } from "../investigation-progress/investigation-progress-stages";
import { presentInvestigationProgressStage } from "../investigation-progress/investigation-progress-stages";
import { StatusBadge } from "./StatusBadge";

export interface InvestigationProgressTimelineProps {
  readonly stages: readonly InvestigationProgressStageViewModel[];
  readonly elapsedLabel: string;
  /**
   * A stable identity for the CURRENT run attempt — `${jobId}:${runId}:
   * ${attemptNumber}` — or `null` when no run exists yet. Its only job is to
   * tell this component's local collapse state when the underlying run has
   * genuinely changed, so a user's manual collapse choice resets exactly
   * once per run/attempt/job and never leaks onto the next one, and never
   * resets on an ordinary poll tick or re-render for the SAME run.
   */
  readonly runExpansionKey: string | null;
  /**
   * Rendered as one `<p>` directly under the `<ol>`, only when non-null.
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
export function InvestigationProgressTimeline({
  stages,
  elapsedLabel,
  runExpansionKey,
  executionDetailNote,
}: InvestigationProgressTimelineProps) {
  // Collapse state scoped to the stable run identity — reset only when the
  // run/job/attempt genuinely changes, never on a poll tick or re-render
  // for the same run.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(false), [runExpansionKey]);

  // The run row is the one that may carry children. Derive "is this run
  // live" from the run row's own status, which is already computed by
  // runStageStatus in investigation-progress-stages.ts.
  const runRow = stages.find((s) => s.key === "run");
  const isRunning = runRow?.status === "active";
  const hasChildren = runRow?.children !== undefined && runRow.children.length > 0;

  return (
    <section className="investigation-progress" aria-labelledby="investigation-progress-heading">
      <h2 id="investigation-progress-heading" tabIndex={-1}>
        Investigation progress
      </h2>
      <p className="investigation-progress-elapsed">Elapsed: {elapsedLabel}</p>
      <ol className="investigation-progress-list">
        {stages.map((stage) => {
          const presentation = presentInvestigationProgressStage(stage.status);
          const isRunRow = stage.key === "run";
          const showChildren = isRunRow && hasChildren && (isRunning || !collapsed);
          const showToggle = isRunRow && hasChildren && !isRunning;

          return (
            <li key={stage.key} className={`investigation-progress-item investigation-progress-item--${stage.status}`}>
              <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={presentation.badgeLabel} />
              <span className="investigation-progress-label">{stage.label}</span>
              {showToggle && (
                <button
                  type="button"
                  className="investigation-progress-collapse-toggle"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed((c) => !c)}
                >
                  {collapsed ? "Show steps" : "Hide steps"}
                </button>
              )}
              {showChildren && (
                <ol className="investigation-progress-children-list">
                  {runRow!.children!.map((child) => {
                    const childPresentation = presentInvestigationProgressStage(child.status as any);
                    return (
                      <li
                        key={child.key}
                        className={`investigation-progress-item investigation-progress-item--child investigation-progress-item--${child.status}`}
                      >
                        <StatusBadge
                          tone={childPresentation.tone}
                          glyph={childPresentation.glyph}
                          label={childPresentation.badgeLabel}
                        />
                        <span className="investigation-progress-label">{child.label}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
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
