import type { InvestigationProgressStageViewModel } from "../investigation-progress/investigation-progress-stages";
import { presentInvestigationProgressStage } from "../investigation-progress/investigation-progress-stages";
import { StatusBadge } from "./StatusBadge";

export interface InvestigationProgressTimelineProps {
  readonly stages: readonly InvestigationProgressStageViewModel[];
  readonly elapsedLabel: string;
}

// Frontend-known request-lifecycle stages only — never backend diagnostic
// events (that is TraceTimeline/"Agent activity", a separate data source).
// Every stage is Pending/Active/Completed/Failed; never a percentage, never
// advanced by a timer. Elapsed time is plain visible text, deliberately
// outside the app's one aria-live region (docs/14-web-ui.md §9) — a ticking
// value re-announced every second would be unusable with a screen reader.
export function InvestigationProgressTimeline({ stages, elapsedLabel }: InvestigationProgressTimelineProps) {
  return (
    <section className="investigation-progress" aria-labelledby="investigation-progress-heading">
      <h2 id="investigation-progress-heading" tabIndex={-1}>
        Investigation progress
      </h2>
      <p className="investigation-progress-elapsed">Elapsed: {elapsedLabel}</p>
      <ol className="investigation-progress-list">
        {stages.map((stage) => {
          const presentation = presentInvestigationProgressStage(stage.status);
          return (
            <li key={stage.key} className={`investigation-progress-item investigation-progress-item--${stage.status}`}>
              <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={presentation.badgeLabel} />
              <span className="investigation-progress-label">{stage.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
