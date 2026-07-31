import type { ApprovalPresentation } from "../approval/approval-presentation";
import type { AgentRunRecordView, AgentTraceEvent } from "../api/types";
import { formatDateTime, formatDuration } from "../format/datetime";
import { runStatusBadge } from "../run/run-overview-presentation";
import { StatusBadge } from "./StatusBadge";

export interface RunOverviewPanelProps {
  readonly run: AgentRunRecordView;
  readonly trace: readonly AgentTraceEvent[];
  readonly suggestedActionCount: number;
  // Only ever non-null for NOT_ELIGIBLE (RunContextPanel guarantees null when
  // approval === null) — approval === null means "no approval data yet"
  // (still loading, or the last fetch failed), never "not eligible", so this
  // panel must never invent an eligibility statement for that case.
  readonly eligibilityNote: ApprovalPresentation | null;
}

// Reusable "useful context" card for the Run Context Panel whenever there is
// no active or terminal decision to show (approval === null, or NOT_ELIGIBLE).
// Shows only run facts the API already returns — nothing invented.
export function RunOverviewPanel({ run, trace, suggestedActionCount, eligibilityNote }: RunOverviewPanelProps) {
  const statusPresentation = runStatusBadge(run.status);

  return (
    <section className="run-overview-panel" aria-labelledby="run-overview-heading">
      <h2 id="run-overview-heading">Run overview</h2>
      <p className="run-overview-status">
        <StatusBadge tone={statusPresentation.tone} glyph={statusPresentation.glyph} label={run.status} />
      </p>

      <dl className="run-overview-details">
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatDateTime(run.finishedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
        </div>
        {/*
          Rendered VERBATIM from the persisted run, never from whichever mode the
          form happened to request. A run that was requested as LIVE but persisted
          as FAKE must read FAKE — the badge states what actually executed.
        */}
        <div>
          <dt>Provider mode</dt>
          <dd>{run.providerMode}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{run.modelIdentifier ?? "—"}</dd>
        </div>
        {/*
          Hidden ENTIRELY when the cost is unknown. Rendering "$0.00" would assert
          a measured free run, which is a different claim from "we did not
          measure this" — and for a FAKE run there was never a provider call to
          measure.
        */}
        {run.estimatedCostUsd !== null ? (
          <div>
            <dt>Estimated cost</dt>
            <dd>${run.estimatedCostUsd}</dd>
          </div>
        ) : null}
        <div>
          <dt>Trace events</dt>
          <dd>{trace.length}</dd>
        </div>
        <div>
          <dt>Suggested action count</dt>
          <dd>{suggestedActionCount}</dd>
        </div>
      </dl>

      {eligibilityNote !== null ? (
        <div className="run-overview-eligibility">
          <p className="approval-panel-status">
            <StatusBadge tone={eligibilityNote.tone} glyph={eligibilityNote.glyph} label={eligibilityNote.badgeLabel} />
          </p>
          <p>{eligibilityNote.copy}</p>
          {eligibilityNote.hint !== null ? <p className="approval-panel-hint">{eligibilityNote.hint}</p> : null}
        </div>
      ) : null}

      <nav className="run-overview-nav" aria-label="Run sections">
        <a href="#timeline-heading">Jump to timeline</a>
        <a href="#report-heading">Jump to report</a>
      </nav>
    </section>
  );
}
