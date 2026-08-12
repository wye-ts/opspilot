import type { AgentRunOutcomeView, AgentRunRecordView } from "../api/types";
import { runStatusBadge } from "../run/run-overview-presentation";
import { StatusBadge } from "./StatusBadge";

// Small decorative mark for the Live provider pill — a restrained sparkle,
// distinguishing it at a glance from the blue Running/In progress status
// dot it used to be confusable with (final polish pass, item 4).
function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
    </svg>
  );
}

export interface CurrentInvestigationProps {
  readonly summary: string;
  /** The persisted provider mode of the run/job — never the form's selection. */
  readonly providerMode: "FAKE" | "LIVE";
  /** The current run's record, or `null` before any run exists for this job. */
  readonly run: AgentRunRecordView | null;
  readonly outcome: AgentRunOutcomeView | null;
}

// The compact post-job card that replaces the old "Submitted issue" emphasis
// (§12). Only grounded truth: issue summary, Demo/Live, current run status.
// Provider/status badges live here, never in the product header. Issue #41
// polish §7 makes it a tight two-column summary strip (title left, badges
// right). §8 REMOVED the terminal "New investigation" action from this card —
// the card is run metadata, not a navigation toolbar; the page-level terminal
// CTA lives after Run Details, above the footer (see App.tsx).
export function CurrentInvestigation({
  summary,
  providerMode,
  run,
  outcome,
}: CurrentInvestigationProps) {
  const statusPresentation =
    run !== null && outcome !== null ? runStatusBadge(run.status) : null;
  const providerLabel = providerMode === "LIVE" ? "Live" : "Demo";
  const providerToneClass = providerMode === "LIVE" ? " current-investigation-provider--live" : "";

  return (
    <section className="current-investigation" aria-labelledby="current-investigation-heading">
      <p className="current-investigation-eyebrow">Current investigation</p>
      <div className="current-investigation-body">
        <h2 id="current-investigation-heading" className="current-investigation-title">
          {summary}
        </h2>
        <div className="current-investigation-actions">
          <span className={`current-investigation-provider${providerToneClass}`}>
            {providerMode === "LIVE" ? <SparkleIcon /> : null}
            {providerLabel}
          </span>
          {statusPresentation !== null ? (
            <StatusBadge
              tone={statusPresentation.tone}
              glyph={statusPresentation.glyph}
              label={statusPresentation.label}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
