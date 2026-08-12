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

  // Issue #41 polish §10 — a NOT_ELIGIBLE run has no actionable human decision,
  // so it must not consume an entire large card. Render a very compact
  // secondary status instead; approval semantics are unchanged (the region and
  // its badge remain, and PENDING stays prominent and actionable below).
  if (approval.status === "NOT_ELIGIBLE") {
    return (
      <section className="approval-panel approval-panel--not-eligible" aria-labelledby="approval-heading">
        <h2 id="approval-heading" tabIndex={-1}>Human approval</h2>
        <p className="approval-not-eligible">
          <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={presentation.badgeLabel} />
          <span>Not eligible: this run produced no suggested actions.</span>
        </p>
      </section>
    );
  }

  return (
    <section className="approval-panel" aria-labelledby="approval-heading">
      {/* Final UX Pilot fidelity pass — the reference's compact amber-accent
          approval header: icon + "Human approval" title + a state-accurate
          subtitle (the existing `presentation.copy`, reused rather than a
          second, PENDING-only "N proposed actions require review" string
          that would misdescribe the APPROVED/REJECTED branches). The status
          badge moves beside the title instead of its own line. */}
      <div className="approval-panel-header">
        <span className="approval-panel-icon" aria-hidden="true">✓</span>
        <div className="approval-panel-header-text">
          <h2 id="approval-heading" tabIndex={-1}>Human approval</h2>
          <p className="card-header-subtitle">{presentation.copy}</p>
        </div>
        <StatusBadge tone={presentation.tone} glyph={presentation.glyph} label={presentation.badgeLabel} />
      </div>
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
            <dd className="approval-decision-note">{approval.note ?? "No note provided"}</dd>
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
