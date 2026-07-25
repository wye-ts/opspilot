import { useEffect, useId, useRef, useState } from "react";

import type { RecordApprovalDecisionInput } from "../api/types";

export const REVIEWER_NAME_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 1000;

export interface ApprovalDecisionFormProps {
  // True whenever ANY workflow is in flight (App's phase !== "idle") — not
  // only the approval POST itself. Gates every control. Distinct from
  // `submitting` because a stale-enabled decision form during, e.g., the
  // automatic post-409 convergence GET would let a second click race the
  // in-flight request and abort it (see App.tsx's recordDecision).
  readonly disabled: boolean;
  // True only while the approval POST itself is in flight. Drives the
  // Approving…/Rejecting… pending label — never the disabling, since
  // `disabled` already covers this case (submitting implies disabled).
  readonly submitting: boolean;
  readonly onSubmit: (input: RecordApprovalDecisionInput) => void;
}

// Reviewer name and optional note, mirroring RecordApprovalDecisionInputSchema
// (packages/contracts/src/agent-run-approval.ts) exactly: reviewerName
// trim().min(1).max(100), note trim().min(1).max(1000).optional(). Approve and
// Reject are two named buttons, not a radio group plus one submit — the
// decision IS the clicked action, and a mis-set radio silently submitting the
// wrong irreversible terminal decision is a real hazard this form must avoid.
export function ApprovalDecisionForm({ disabled, submitting, onSubmit }: ApprovalDecisionFormProps) {
  const [reviewerName, setReviewerName] = useState("");
  const [note, setNote] = useState("");
  const [pendingDecision, setPendingDecision] = useState<"APPROVED" | "REJECTED" | null>(null);
  const reviewerNameId = useId();
  const noteId = useId();

  // A ref, not state, for the same reason InvestigationForm uses one: it must
  // take effect synchronously on the very next click, before React re-renders
  // with the parent's `disabled=true`. This is what stops a rapid
  // double-click from calling onSubmit twice.
  const submittingRef = useRef(false);

  const canSubmit = !disabled && reviewerName.trim().length > 0;

  function handleDecision(decision: "APPROVED" | "REJECTED") {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setPendingDecision(decision);

    const trimmedNote = note.trim();
    onSubmit({
      decision,
      reviewerName: reviewerName.trim(),
      ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
    });
  }

  // Unlocks once the WHOLE workflow returns to idle, not merely once the
  // approval POST itself settles — `disabled` stays true through the
  // automatic post-409 convergence GET, and the double-click guard must stay
  // armed for that entire window, not just the POST portion of it.
  useEffect(() => {
    if (!disabled) {
      submittingRef.current = false;
    }
  }, [disabled]);

  useEffect(() => {
    if (!submitting) {
      setPendingDecision(null);
    }
  }, [submitting]);

  return (
    // Enter submission is deliberately not wired to either decision: with two
    // irreversible terminal outcomes, an implicit key press must never pick
    // one on the reviewer's behalf.
    <form className="approval-decision-form" onSubmit={(event) => event.preventDefault()} aria-busy={disabled}>
      <div className="form-field">
        <label htmlFor={reviewerNameId}>Reviewer name</label>
        <input
          id={reviewerNameId}
          type="text"
          value={reviewerName}
          onChange={(event) => setReviewerName(event.target.value)}
          disabled={disabled}
          required
          maxLength={REVIEWER_NAME_MAX_LENGTH}
        />
      </div>

      <div className="form-field">
        <label htmlFor={noteId}>Note (optional)</label>
        <textarea
          id={noteId}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={disabled}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
        />
      </div>

      <div className="approval-decision-actions">
        <button type="button" onClick={() => handleDecision("APPROVED")} disabled={!canSubmit}>
          {submitting && pendingDecision === "APPROVED" ? "Approving…" : "Approve"}
        </button>
        <button type="button" onClick={() => handleDecision("REJECTED")} disabled={!canSubmit}>
          {submitting && pendingDecision === "REJECTED" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </form>
  );
}
