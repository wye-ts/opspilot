import type { SuggestedAction } from "../api/types";
import { SuggestedActionCard } from "./SuggestedActionCard";

export interface SuggestedActionsPanelProps {
  readonly actions: readonly SuggestedAction[];
}

// A standalone section, independently gated by the caller (App.tsx) on
// `outcome.type === "COMPLETED" && actions.length > 0` — this component is
// never mounted for an empty array, so it never has to render an empty-state
// placeholder. A top-level `<h2>` in its own required-order position
// (Generated report → Suggested actions → Approval), not nested inside
// ReportPanel.
export function SuggestedActionsPanel({ actions }: SuggestedActionsPanelProps) {
  return (
    <section className="report-panel" aria-labelledby="suggested-actions-heading">
      <h2 id="suggested-actions-heading" tabIndex={-1}>Suggested actions</h2>
      <ul className="report-panel-actions">
        {actions.map((action, index) => (
          <li key={index}>
            <SuggestedActionCard action={action} />
          </li>
        ))}
      </ul>
    </section>
  );
}
