import { useEffect, useId, useRef, useState } from "react";

export interface InvestigationFormSubmission {
  readonly summary: string;
  readonly approvalDemo: boolean;
}

export interface InvestigationFormProps {
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly onSubmit: (submission: InvestigationFormSubmission) => void;
}

// Owns only `summary` and `approvalDemo` — no ticket-ID field exists here or
// anywhere in the app. The internal ticket ID is derived by App at submit
// time (see App.tsx): approvalDemo ? "TICKET-APPROVAL-DEMO" :
// `DEMO-${crypto.randomUUID()}`.
export function InvestigationForm({ disabled, submitLabel, onSubmit }: InvestigationFormProps) {
  const [summary, setSummary] = useState("");
  const [approvalDemo, setApprovalDemo] = useState(false);
  const summaryId = useId();
  const approvalDemoId = useId();

  // A ref, not state: it must take effect synchronously on the very next
  // click, before React has had a chance to re-render with `disabled=true`
  // from the parent. This is what stops a rapid double-click from calling
  // onSubmit twice — the `disabled` prop alone cannot, since it only updates
  // after a render.
  const submittingRef = useRef(false);

  const trimmedSummary = summary.trim();
  const canSubmit = !disabled && trimmedSummary.length > 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    onSubmit({ summary: trimmedSummary, approvalDemo });
  }

  // Unlocks once the parent signals the workflow is no longer active, so the
  // form is submittable again for the next investigation.
  useEffect(() => {
    if (!disabled) submittingRef.current = false;
  }, [disabled]);

  return (
    <form className="investigation-form" onSubmit={handleSubmit} aria-busy={disabled}>
      <div className="form-field">
        <label htmlFor={summaryId}>Issue Summary</label>
        <textarea
          id={summaryId}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          disabled={disabled}
          rows={4}
          placeholder="Describe the issue — e.g. Elevated API error rate on billing-service"
        />
      </div>

      <div className="form-field form-field-checkbox">
        <input
          id={approvalDemoId}
          type="checkbox"
          checked={approvalDemo}
          onChange={(event) => setApprovalDemo(event.target.checked)}
          disabled={disabled}
        />
        <label htmlFor={approvalDemoId}>Approval workflow demo</label>
      </div>

      <button type="submit" disabled={!canSubmit}>
        {submitLabel}
      </button>
    </form>
  );
}
