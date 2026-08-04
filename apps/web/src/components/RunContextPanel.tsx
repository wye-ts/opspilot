import type { AgentRunRecordView, AgentTraceEvent, ApprovalView, RecordApprovalDecisionInput } from "../api/types";
import { presentApproval } from "../approval/approval-presentation";
import { ApprovalPanel } from "./ApprovalPanel";
import { RunOverviewPanel } from "./RunOverviewPanel";

export interface RunContextPanelProps {
  readonly run: AgentRunRecordView;
  readonly trace: readonly AgentTraceEvent[];
  readonly approval: ApprovalView | null;
  readonly suggestedActionCount: number;
  /** Whether ReportPanel is actually mounted for this run — see RunOverviewPanel. */
  readonly showReportLink: boolean;
  readonly decisionDisabled: boolean;
  readonly submittingDecision: boolean;
  readonly onDecide: (input: RecordApprovalDecisionInput) => void;
}

// The one place the run-detail page switches between the Run Context Panel's
// three states. approval === null is never presented as NOT_ELIGIBLE: null
// means "no approval data yet" (still loading, or the last fetch failed) —
// a materially different, transient fact from a permanent, backend-computed
// ineligibility, and conflating the two would misinform a reviewer.
export function RunContextPanel({
  run,
  trace,
  approval,
  suggestedActionCount,
  showReportLink,
  decisionDisabled,
  submittingDecision,
  onDecide,
}: RunContextPanelProps) {
  if (approval === null) {
    return (
      <RunOverviewPanel
        run={run}
        trace={trace}
        suggestedActionCount={suggestedActionCount}
        showReportLink={showReportLink}
        eligibilityNote={null}
      />
    );
  }

  if (approval.status === "NOT_ELIGIBLE") {
    return (
      <RunOverviewPanel
        run={run}
        trace={trace}
        suggestedActionCount={suggestedActionCount}
        showReportLink={showReportLink}
        // Reuses the existing presentation seam rather than duplicating its
        // copy/hint into a second hand-written string.
        eligibilityNote={presentApproval("NOT_ELIGIBLE", suggestedActionCount)}
      />
    );
  }

  return (
    <ApprovalPanel
      approval={approval}
      suggestedActionCount={suggestedActionCount}
      decisionDisabled={decisionDisabled}
      submittingDecision={submittingDecision}
      onDecide={onDecide}
    />
  );
}
