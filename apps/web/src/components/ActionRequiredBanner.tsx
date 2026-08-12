export interface ActionRequiredBannerProps {
  /** The current run's real suggested-action count — never a placeholder. */
  readonly suggestedActionCount: number;
}

// Small inline glyph matching the amber "person-check" icon already used by
// ApprovalPanel's own header (see .approval-panel-icon) — same shape/weight,
// so the top-of-page banner and the decision panel it points at read as one
// visual language.
function UserCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="8" r="3.25" />
      <path d="M4.5 19.5c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
      <path d="M16 12.5l1.6 1.6 3-3.2" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 9l7 7 7-7" />
    </svg>
  );
}

// Rendered by App only when approval?.status === "PENDING" (a derived
// condition, no new App state). "Review actions" is a plain fragment link to
// the one, single decision panel — this component never imports or renders
// ApprovalDecisionForm, so it cannot duplicate the Approve/Reject controls no
// matter how it is triggered. The target heading (ApprovalPanel's
// `#approval-heading`) already carries `tabIndex={-1}`, so native fragment
// navigation both scrolls AND focuses it — no extra JS/state needed.
export function ActionRequiredBanner({ suggestedActionCount }: ActionRequiredBannerProps) {
  return (
    <div className="action-required-banner">
      <div className="action-required-banner-main">
        <span className="action-required-banner-icon" aria-hidden="true">
          <UserCheckIcon />
        </span>
        <div>
          <p className="action-required-banner-title">Human approval required</p>
          <p className="action-required-banner-subtitle">
            {suggestedActionCount} proposed action{suggestedActionCount === 1 ? "" : "s"}{" "}
            {suggestedActionCount === 1 ? "requires" : "require"} review before execution.
          </p>
        </div>
      </div>
      <a className="action-required-banner-cta" href="#approval-heading">
        Review actions
        <ChevronDownIcon />
      </a>
    </div>
  );
}
