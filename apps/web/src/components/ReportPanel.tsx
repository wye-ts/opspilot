import type { AgentRunOutcomeView, StoredResolutionReport } from "../api/types";
import { humanizeEnum } from "../format/text";

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
//
// rootCause is nullable (Issue #58, P1-1): non-sufficient evidence never
// carries a root cause, and a SUFFICIENT report may be a grounded non-causal
// conclusion. The rendered value therefore depends on evidenceState, which a
// pre-#58 stored report (evidenceState undefined) does not carry — legacy
// rows always had a non-null string rootCause, so that case renders it.
function rootCauseDisplay(report: {
  readonly rootCause: string | null;
  readonly evidenceState?: StoredResolutionReport["evidenceState"];
}): string {
  if (report.rootCause !== null) return report.rootCause;
  switch (report.evidenceState) {
    case "SUFFICIENT":
      return "No causal root cause identified.";
    case "INSUFFICIENT":
      return "Not determined — insufficient evidence.";
    case "CONFLICTING":
      return "Not determined — evidence is conflicting.";
    default:
      return "Not determined.";
  }
}
export function ReportPanel({ outcome, failedStageLabel = null }: ReportPanelProps) {
  if (outcome.type === "FAILED") {
    return (
      <section className="report-panel" aria-labelledby="report-heading">
        <div className="report-panel-header">
          <h2 id="report-heading" tabIndex={-1}>Resolution report</h2>
        </div>
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
            the actual resolution (§9). Kept as real text, never hidden.
            Final polish pass, item 5 — two compact neutral pills instead of
            raw "UNKNOWN   Confidence 0.25" debug-looking text: sentence
            case (never the raw enum), and confidence as a rounded
            percentage. The underlying `report.confidence` value is
            unchanged — only its displayed form is converted.
            Follow-up polish pass — Outcome and Confidence no longer read as
            two identical tags. Outcome (the actual result) stays the filled
            pill; Confidence steps down to plain, lighter metadata text, since
            a low confidence score is informational, not itself an error —
            no red/amber/green threshold coloring is introduced here. */}
        <p className="report-panel-meta">
          <span className="report-panel-meta-pill">Outcome · {humanizeEnum(report.category)}</span>
          <span className="report-panel-meta-confidence">Confidence · {Math.round(report.confidence * 100)}%</span>
        </p>
      </div>

      <dl className="report-panel-fields">
        <div className="report-panel-field report-panel-field--lead">
          <dt>Summary</dt>
          <dd>{report.summary}</dd>
        </div>
        <div className="report-panel-field">
          <dt>Root cause</dt>
          <dd>{rootCauseDisplay(report)}</dd>
        </div>
        <div className="report-panel-field">
          <dt>Customer impact</dt>
          <dd>{report.customerImpact}</dd>
        </div>
        <div className="report-panel-field">
          <dt>Recommended resolution</dt>
          <dd>{report.recommendedResolution}</dd>
        </div>
        {/* Final UX Pilot fidelity pass, HQ item 6 — Evidence now uses the
            same dt/dd label pattern as every other section instead of a
            standalone <h3>, so all five section labels read identically
            (small, uppercase, muted), matching the reference exactly. */}
        <div className="report-panel-field">
          <dt>Evidence</dt>
          <dd>
            {report.evidence.length === 0 ? (
              "No evidence was recorded."
            ) : (
              <ul className="report-panel-evidence">
                {report.evidence.map((item) => (
                  <li key={item.evidenceId}>
                    <span className="mono">{item.sourceType}</span> — {item.finding}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
