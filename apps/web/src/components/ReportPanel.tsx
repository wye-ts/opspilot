import type { AgentRunOutcomeView } from "../api/types";

// RUNNING is excluded at the type level, not just gated at the call site —
// App.tsx never passes it, and this makes that invariant checked rather than
// merely conventional.
export type ReportableOutcome = Exclude<AgentRunOutcomeView, { readonly type: "RUNNING" }>;

export interface ReportPanelProps {
  readonly outcome: ReportableOutcome;
  /**
   * The lowercase-first-letter label of the canonical execution stage that
   * failed (e.g. "agent analysis"), or `null` when that fact isn't grounded
   * (a legacy run, or no canonical stage reached `failed`). Only ever read
   * when `outcome.type === "FAILED"`; App.tsx derives it from the same
   * canonical stage rows the Progress Timeline renders — never invented here
   * (HQ review §3).
   */
  readonly failedStageLabel?: string | null;
}

// Renders the COMPLETED and FAILED outcome shapes only. RUNNING is handled
// by the caller (App.tsx): a RUNNING outcome must never render an empty
// "Resolution report" panel at all, not even a placeholder — Phase A has no
// polling, so the report may legitimately not exist yet. (A RUNNING run can
// still be refreshed via InvestigationSummary's always-present Refresh
// button, so no affordance is lost.)
//
// Suggested actions are a SEPARATE component (SuggestedActionsPanel) with
// its own gating — this panel never renders them.
export function ReportPanel({ outcome, failedStageLabel = null }: ReportPanelProps) {
  if (outcome.type === "FAILED") {
    return (
      <section className="report-panel" aria-labelledby="report-heading">
        <h2 id="report-heading" tabIndex={-1}>Resolution report</h2>
        <p>
          {failedStageLabel !== null
            ? `Investigation failed during ${failedStageLabel}.`
            : "The run failed before producing a report."}
        </p>
        <dl className="report-panel-failure-fields">
          <div>
            <dt>Failure code</dt>
            <dd className="mono report-panel-failure-code">{outcome.code}</dd>
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
      <div className="report-panel-header">
        <h2 id="report-heading" tabIndex={-1}>Resolution report</h2>
        {/* Secondary metadata — Category/Confidence must not visually precede
            the actual resolution (§9). Kept as real text, never hidden. */}
        <p className="report-panel-meta">
          <span>{report.category}</span>
          <span>
            Confidence{" "}
            <span className="report-panel-confidence">{report.confidence.toFixed(2)}</span>
          </span>
        </p>
      </div>

      <dl className="report-panel-fields">
        <div className="report-panel-field report-panel-field--lead">
          <dt>Summary</dt>
          <dd>{report.summary}</dd>
        </div>
        <div className="report-panel-field">
          <dt>Root cause</dt>
          <dd>{report.rootCause}</dd>
        </div>
        <div className="report-panel-field">
          <dt>Customer impact</dt>
          <dd>{report.customerImpact}</dd>
        </div>
        <div className="report-panel-field">
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
