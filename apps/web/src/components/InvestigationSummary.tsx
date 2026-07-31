import type { AgentJobResponse, AgentRunRecordView } from "../api/types";
import { formatDateTime, formatDuration } from "../format/datetime";
import { runStatusBadge } from "../run/run-overview-presentation";
import { StatusBadge } from "./StatusBadge";

export interface InvestigationSummaryProps {
  readonly ticketId: string;
  readonly job: AgentJobResponse;
  readonly run: AgentRunRecordView | null;
  readonly showRetryRun: boolean;
  /**
   * Shown INSTEAD of the Retry Run button when the failed run was LIVE.
   *
   * The app does not retain the live demo access token past the request it
   * authorized, so there is nothing to retry with. Saying so is better than
   * offering a button that would come back 401, and better than silently
   * omitting the affordance with no explanation.
   */
  readonly showLiveRetryTokenNotice: boolean;
  readonly retryDisabled: boolean;
  readonly onRetryRun: () => void;
  readonly refreshDisabled: boolean;
  readonly onRefresh: () => void;
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
  showLiveRetryTokenNotice,
  retryDisabled,
  onRetryRun,
  refreshDisabled,
  onRefresh,
}: InvestigationSummaryProps) {
  const presentation = run !== null ? runStatusBadge(run.status) : null;

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

        {showLiveRetryTokenNotice ? (
          <p className="investigation-summary-retry-note">
            Use the <strong>Retry Live Run</strong> form above to retry this same investigation —
            re-enter the live demo access token to continue.
          </p>
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
