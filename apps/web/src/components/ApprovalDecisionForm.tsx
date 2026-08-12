import { useEffect, useId, useRef, useState } from "react";

import type { RecordApprovalDecisionInput } from "../api/types";

export const REVIEWER_NAME_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 1000;

// Leading glyphs for the Reject/Approve CTAs — the reference's Font Awesome
// `fa-xmark` / `fa-check`, redrawn as inline stroke SVGs matching the
// ActionRequiredBanner icon treatment rather than pulling in an icon font.
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

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
      {/* Final UX Pilot fidelity pass — side-by-side on desktop (the
          reference's `sm:grid-cols-2`), stacked on mobile. */}
      <div className="approval-decision-fields">
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
          {/* Follow-up polish pass — rows=1 and no resize handle so this
              field renders as the exact same height/shape as the Reviewer
              name input beside it (the reference's two identical-looking
              `<input>` fields); still a textarea, so a pasted multi-line
              note is not silently collapsed to one line. */}
          <textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={disabled}
            maxLength={NOTE_MAX_LENGTH}
            rows={1}
          />
        </div>
      </div>

      {/* Reject then Approve in DOM order — right-aligned on desktop reads
          left-to-right as Reject/Approve (the reference's row order);
          `column-reverse` on mobile puts Approve, the primary action, on
          top when the pair stacks (the reference's mobile order-first). */}
      <div className="approval-decision-actions">
        <button type="button" data-kind="reject" onClick={() => handleDecision("REJECTED")} disabled={!canSubmit}>
          <XIcon />
          {submitting && pendingDecision === "REJECTED" ? "Rejecting…" : "Reject"}
        </button>
        <button type="button" data-kind="approve" onClick={() => handleDecision("APPROVED")} disabled={!canSubmit}>
          <CheckIcon />
          {submitting && pendingDecision === "APPROVED" ? "Approving…" : "Approve"}
        </button>
      </div>
    </form>
  );
}
