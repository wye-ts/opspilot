import { presentApproval } from "../approval/approval-presentation";
import { formatDateTime } from "../format/datetime";
import type { ApprovalView, RecordApprovalDecisionInput } from "../api/types";
import { ApprovalDecisionForm } from "./ApprovalDecisionForm";
import { StatusBadge } from "./StatusBadge";

export interface ApprovalPanelProps {
  readonly approval: ApprovalView;
  readonly suggestedActionCount: number;
  // True whenever ANY App workflow is in flight — disables the decision form
  // for the full duration, including the automatic post-409 convergence GET,
  // not only the approval POST itself (see ApprovalDecisionForm's `disabled`).
  readonly decisionDisabled: boolean;
  // True only while the approval POST itself is in flight — drives the
  // Approving…/Rejecting… pending label.
  readonly submittingDecision: boolean;
  readonly onDecide: (input: RecordApprovalDecisionInput) => void;
}

// Four-branch status panel. APPROVED and REJECTED render zero buttons — there
// is no edit, revoke, or resubmit affordance, because no endpoint backs one
// (docs/13-approval-workflow.md §5: decisions are terminal).
export function ApprovalPanel({ approval, suggestedActionCount, decisionDisabled, submittingDecision, onDecide }: ApprovalPanelProps) {
  const presentation = presentApproval(approval.status, suggestedActionCount);
  const isTerminal = approval.status === "APPROVED" || approval.status === "REJECTED";

  return (
    <section className="approval-panel" aria-labelledby="approval-heading">
      <h2 id="approval-heading">Approval</h2>
      <p className="approval-panel-status">
        <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={presentation.badgeLabel} />
      </p>
      <p>{presentation.copy}</p>
      {presentation.hint !== null ? <p className="approval-panel-hint">{presentation.hint}</p> : null}
      {presentation.showsDecisionForm ? (
        <ApprovalDecisionForm disabled={decisionDisabled} submitting={submittingDecision} onSubmit={onDecide} />
      ) : null}
      {isTerminal ? (
        <dl className="approval-panel-record">
          <div>
            <dt>Reviewer</dt>
            <dd>{approval.reviewerName ?? "—"}</dd>
          </div>
          <div>
            <dt>Note</dt>
            <dd>{approval.note ?? "No note provided"}</dd>
          </div>
          <div>
            <dt>Decided at</dt>
            <dd>{formatDateTime(approval.decidedAt)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
