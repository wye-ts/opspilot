import type { AgentRunOutcomeView } from "../api/types";
import { SuggestedActionCard } from "./SuggestedActionCard";

export interface ReportPanelProps {
  readonly outcome: AgentRunOutcomeView;
  readonly onRefresh: () => void;
  readonly refreshDisabled: boolean;
}

// Renders all three outcome shapes. COMPLETED renders every ResolutionReport
// field the contract defines — nothing invented, nothing omitted.
export function ReportPanel({ outcome, onRefresh, refreshDisabled }: ReportPanelProps) {
  if (outcome.type === "RUNNING") {
    return (
      <section className="report-panel" aria-labelledby="report-heading">
        <h2 id="report-heading" tabIndex={-1}>Generated report</h2>
        <p>This run has not produced a report yet.</p>
        <button type="button" onClick={onRefresh} disabled={refreshDisabled}>
          Refresh
        </button>
      </section>
    );
  }

  if (outcome.type === "FAILED") {
    return (
      <section className="report-panel" aria-labelledby="report-heading">
        <h2 id="report-heading" tabIndex={-1}>Generated report</h2>
        <p>The run failed before producing a report.</p>
        <dl>
          <div>
            <dt>Failure code</dt>
            <dd className="mono">{outcome.code}</dd>
          </div>
          <div>
            <dt>Message</dt>
            <dd>{outcome.message}</dd>
          </div>
        </dl>
      </section>
    );
  }

  const { report } = outcome;

  return (
    <section className="report-panel" aria-labelledby="report-heading">
      <h2 id="report-heading" tabIndex={-1}>Generated report</h2>

      <dl className="report-panel-fields">
        <div>
          <dt>Category</dt>
          <dd>{report.category}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{report.confidence.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Summary</dt>
          <dd>{report.summary}</dd>
        </div>
        <div>
          <dt>Root cause</dt>
          <dd>{report.rootCause}</dd>
        </div>
        <div>
          <dt>Customer impact</dt>
          <dd>{report.customerImpact}</dd>
        </div>
        <div>
          <dt>Recommended resolution</dt>
          <dd>{report.recommendedResolution}</dd>
        </div>
      </dl>

      <h3>Evidence</h3>
      {report.evidence.length === 0 ? (
        <p>No evidence was recorded.</p>
      ) : (
        <ul className="report-panel-evidence">
          {report.evidence.map((item) => (
            <li key={item.evidenceId}>
              <span className="mono">{item.sourceType}</span> — {item.finding}
            </li>
          ))}
        </ul>
      )}

      <h3>Suggested actions</h3>
      {report.suggestedActions.length === 0 ? (
        <p>This run produced no suggested actions.</p>
      ) : (
        <ul className="report-panel-actions">
          {report.suggestedActions.map((action, index) => (
            <li key={index}>
              <SuggestedActionCard action={action} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
