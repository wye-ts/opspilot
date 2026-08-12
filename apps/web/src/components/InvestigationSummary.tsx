import type { AgentJobResponse, AgentRunRecordView } from "../api/types";
import { formatDateTime, formatDuration } from "../format/datetime";
import { TechnicalDetails } from "./TechnicalDetails";

export interface InvestigationSummaryProps {
  readonly ticketId: string;
  readonly job: AgentJobResponse;
  readonly run: AgentRunRecordView | null;
  /** Count of trace events recorded for the current run (0 before a run exists). */
  readonly traceEventCount: number;
  /** Count of suggested actions on the current run's completed report (0 otherwise). */
  readonly suggestedActionCount: number;
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

// Item 7 of the flat flow — Run Details (§12). The approved compact reference
// is four primary fields (Provider / Model / Duration / Attempt) plus a
// `Technical details` disclosure for everything long/internal (start/finish
// timestamps, counts, cost, and all IDs). The old "Jump to activity" /
// "Jump to report" links are gone: the flat flow is already in reading order,
// so in-page jumps just duplicated the DOM order (Issue #41 polish §12).
export function InvestigationSummary({
  ticketId,
  job,
  run,
  traceEventCount,
  suggestedActionCount,
  showRetryRun,
  showLiveRetryTokenNotice,
  retryDisabled,
  onRetryRun,
  refreshDisabled,
  onRefresh,
}: InvestigationSummaryProps) {
  // User-facing provider labels: `Demo` for FAKE, `Live` for LIVE (§12) —
  // raw enum values never appear as primary copy.
  const providerLabel = run !== null ? (run.providerMode === "LIVE" ? "Live" : "Demo") : null;

  // Everything long or internal goes behind the disclosure. Only grounded
  // identifiers reach here — never secrets, tokens, prompts, or payloads.
  const technicalRows: { readonly label: string; readonly value: string }[] = [];
  if (run !== null) {
    technicalRows.push({ label: "Started", value: formatDateTime(run.startedAt) });
    technicalRows.push({ label: "Finished", value: formatDateTime(run.finishedAt) });
    technicalRows.push({ label: "Trace events", value: String(traceEventCount) });
    technicalRows.push({ label: "Suggested action count", value: String(suggestedActionCount) });
    // Hidden ENTIRELY when the cost is unknown. Rendering "$0.00" would
    // assert a measured free run, which is a different claim from "we did
    // not measure this" — and for a FAKE run there was never a provider
    // call to measure. (Relocated from RunOverviewPanel.)
    if (run.estimatedCostUsd !== null) {
      technicalRows.push({ label: "Estimated cost", value: `$${run.estimatedCostUsd}` });
    }
  }
  technicalRows.push({ label: "Ticket ID", value: ticketId });
  technicalRows.push({ label: "Job ID", value: job.id });
  if (run !== null) {
    technicalRows.push({ label: "Run ID", value: run.id });
  }

  // Refresh is now `sr-only` (see below) and no longer counts as visible
  // content for this row's own spacing — an otherwise-empty row (a
  // COMPLETED run with no retry affordance) must not leave a blank gap
  // above the Provider/Model/Duration/Attempt grid.
  const hasVisibleStatusRow = showRetryRun || showLiveRetryTokenNotice;

  return (
    <section className="investigation-summary" aria-labelledby="investigation-summary-heading">
      <div className="card-header">
        <h2 id="investigation-summary-heading">Run details</h2>
      </div>

      <div className={`investigation-summary-status${hasVisibleStatusRow ? "" : " investigation-summary-status--empty"}`}>
        {/* Final UX Pilot fidelity pass, HQ item 8 — the overall
            Completed/Running/Failed status is already shown in Current
            Investigation and Investigation Progress; a third copy of the
            same badge here was redundant, so it's removed. Refresh/Retry
            are secondary actions that must not compete with the
            status/result (§12) — quiet text buttons on the right edge. */}
        <div className="investigation-summary-actions">
          {/* Final polish pass — the reference's default Run Details card
              shows no Refresh control at all. The refresh/reload request
              itself is unchanged (still real, still callable) — only its
              always-visible button is removed from the default view; the
              control stays in the DOM as `sr-only` rather than deleted, so
              existing recovery-flow coverage (App.refresh-terminal-canonical
              and friends) keeps exercising the real request, and keyboard/
              screen-reader users retain the affordance even though sighted
              users no longer see it as a primary control (§12). */}
          {run !== null ? (
            <button type="button" className="form-secondary-action sr-only" onClick={onRefresh} disabled={refreshDisabled}>
              Refresh
            </button>
          ) : null}

          {showRetryRun ? (
            <button type="button" className="form-secondary-action" onClick={onRetryRun} disabled={retryDisabled}>
              Retry Run
            </button>
          ) : null}
        </div>

        {showLiveRetryTokenNotice ? (
          <p className="investigation-summary-retry-note">
            Use the <strong>Recover Live Run</strong> form above to recover this same
            investigation — re-enter the live demo access token to continue.
          </p>
        ) : null}
      </div>

      {run !== null ? (
        <dl className="investigation-summary-primary">
          <div>
            <dt>Provider</dt>
            <dd>{providerLabel}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{run.modelIdentifier ?? "—"}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>{run.attemptNumber}</dd>
          </div>
        </dl>
      ) : null}

      <TechnicalDetails rows={technicalRows} />
    </section>
  );
}
