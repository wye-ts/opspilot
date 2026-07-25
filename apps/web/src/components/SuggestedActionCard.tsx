import type { SuggestedAction } from "../api/types";

export interface SuggestedActionCardProps {
  readonly action: SuggestedAction;
}

// Renders every SuggestedAction variant exhaustively — a new contract
// variant would be caught by the exhaustive switch failing to compile.
export function SuggestedActionCard({ action }: SuggestedActionCardProps) {
  switch (action.type) {
    case "UPDATE_TICKET_STATUS":
      return (
        <article className="suggested-action-card">
          <h4>Update ticket status</h4>
          <dl>
            <div>
              <dt>New status</dt>
              <dd>{action.payload.status}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{action.payload.reason}</dd>
            </div>
          </dl>
        </article>
      );
    case "CREATE_ESCALATION":
      return (
        <article className="suggested-action-card">
          <h4>Create escalation</h4>
          <dl>
            <div>
              <dt>Team</dt>
              <dd>{action.payload.team}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>{action.payload.priority}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{action.payload.reason}</dd>
            </div>
          </dl>
        </article>
      );
    case "DRAFT_CUSTOMER_REPLY":
      return (
        <article className="suggested-action-card">
          <h4>Draft customer reply</h4>
          <dl>
            <div>
              <dt>Subject</dt>
              <dd>{action.payload.subject}</dd>
            </div>
          </dl>
          {/* Bounded rendering, not truncation — the full body (up to 4000
              chars per ResolutionReportSchema) stays readable so a reviewer
              can see exactly what they would be approving. */}
          <div className="suggested-action-body">{action.payload.body}</div>
        </article>
      );
  }
}
