// Stateless, prop-less top-of-page prompt. Rendered by App only when
// approval?.status === "PENDING" (a derived condition, no new App state).
// Native fragment navigation to the one, single decision panel — this
// component never imports or renders ApprovalDecisionForm, so it cannot
// duplicate the Approve/Reject controls no matter how it is triggered.
export function ActionRequiredBanner() {
  return (
    <a className="action-required-banner" href="#approval-heading">
      Investigation completed. Human action required — review the proposed action.
    </a>
  );
}
