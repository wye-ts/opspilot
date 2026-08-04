import type { AgentRunOutcomeView } from "../api/types";

// RUNNING is excluded at the type level, not just gated at the call site —
// App.tsx never passes it, and this makes that invariant checked rather than
// merely conventional.
export type ReportableOutcome = Exclude<AgentRunOutcomeView, { readonly type: "RUNNING" }>;

export interface ReportPanelProps {
  readonly outcome: ReportableOutcome;
}

// Renders the COMPLETED and FAILED outcome shapes only. RUNNING is handled
// by the caller (App.tsx): a RUNNING outcome must never render an empty
// "Generated report" panel at all, not even a placeholder — Phase A has no
// polling, so the report may legitimately not exist yet. (A RUNNING run can
// still be refreshed via InvestigationSummary's always-present Refresh
// button, so no affordance is lost.)
//
// Suggested actions are a SEPARATE component (SuggestedActionsPanel) with
// its own gating — this panel never renders them.
export function ReportPanel({ outcome }: ReportPanelProps) {
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
    </section>
  );
}
