import type { AgentJobResponse, AgentRunRecordView } from "../api/types";
import { formatDateTime, formatDuration } from "../format/datetime";
import { StatusBadge, type BadgeTone } from "./StatusBadge";

export interface InvestigationSummaryProps {
  readonly ticketId: string;
  readonly job: AgentJobResponse;
  readonly run: AgentRunRecordView | null;
  readonly showRetryRun: boolean;
  readonly retryDisabled: boolean;
  readonly onRetryRun: () => void;
  readonly refreshDisabled: boolean;
  readonly onRefresh: () => void;
}

function runStatusPresentation(status: string): { tone: BadgeTone; glyph: string } {
  switch (status) {
    case "COMPLETED":
      return { tone: "success", glyph: "✓" };
    case "FAILED":
      return { tone: "danger", glyph: "✕" };
    case "RUNNING":
      return { tone: "info", glyph: "●" };
    default:
      return { tone: "neutral", glyph: "—" };
  }
}

// Secondary detail — the timeline and report are the primary surfaces (§6 of
// the plan). Renders whenever a job exists, even if run creation failed.
// Identifiers use <dl>, never disabled <input> elements, which would be
// announced as form fields the user cannot edit.
export function InvestigationSummary({
  ticketId,
  job,
  run,
  showRetryRun,
  retryDisabled,
  onRetryRun,
  refreshDisabled,
  onRefresh,
}: InvestigationSummaryProps) {
  const presentation = run !== null ? runStatusPresentation(run.status) : null;

  return (
    <section className="investigation-summary" aria-labelledby="investigation-summary-heading">
      <h2 id="investigation-summary-heading">Investigation</h2>

      <div className="investigation-summary-status">
        {presentation !== null && run !== null ? (
          <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={run.status} />
        ) : (
          <StatusBadge tone="danger" glyph="✕" label="Run not started" />
        )}

        {run !== null ? (
          <button type="button" onClick={onRefresh} disabled={refreshDisabled}>
            Refresh
          </button>
        ) : null}

        {showRetryRun ? (
          <button type="button" onClick={onRetryRun} disabled={retryDisabled}>
            Retry Run
          </button>
        ) : null}
      </div>

      {run !== null ? (
        <dl className="investigation-summary-details">
          <div>
            <dt>Attempt</dt>
            <dd>{run.attemptNumber}</dd>
          </div>
          <div>
            <dt>Provider mode</dt>
            <dd>{run.providerMode}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{run.modelIdentifier ?? "—"}</dd>
          </div>
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
        </dl>
      ) : null}

      <dl className="investigation-summary-ids">
        <div>
          <dt>Ticket ID</dt>
          <dd className="mono">{ticketId}</dd>
        </div>
        <div>
          <dt>Job ID</dt>
          <dd className="mono">{job.id}</dd>
        </div>
        {run !== null ? (
          <div>
            <dt>Run ID</dt>
            <dd className="mono">{run.id}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
