import type { BadgeTone } from "../components/StatusBadge";
import type { ApprovalStatus } from "../api/types";

export interface ApprovalPresentation {
  readonly tone: BadgeTone;
  readonly glyph: string;
  readonly badgeLabel: string;
  readonly copy: string;
  readonly hint: string | null;
  readonly showsDecisionForm: boolean;
}

// Pure status -> presentation mapping, tested independently of React (see
// approval-presentation.test.ts). The NOT_ELIGIBLE hint names the deep link
// that still reaches the deterministic approvable Demo — never a ticket ID
// (nothing in the UI exposes one) and never the removed "Approval workflow
// demo" checkbox (Milestone 10 / plan F2).
export function presentApproval(status: ApprovalStatus, suggestedActionCount: number): ApprovalPresentation {
  switch (status) {
    case "NOT_ELIGIBLE":
      return {
        tone: "neutral",
        glyph: "—",
        badgeLabel: "Not eligible",
        copy: "This run has no suggested actions to approve.",
        // The ?approval-demo=1 query parameter remains a deterministic
        // hidden/test entry point, but it is NEVER a user-facing product
        // instruction (Issue #41 polish §10) — so no hint is rendered here.
        hint: null,
        showsDecisionForm: false,
      };
    case "PENDING":
      return {
        tone: "info",
        glyph: "●",
        badgeLabel: "Pending",
        copy: `This run has ${suggestedActionCount} suggested action${suggestedActionCount === 1 ? "" : "s"} awaiting a decision.`,
        hint: null,
        showsDecisionForm: true,
      };
    case "APPROVED":
      return {
        tone: "success",
        glyph: "✓",
        badgeLabel: "Approved",
        copy: "A reviewer approved this run's suggested actions. This decision is final.",
        hint: null,
        showsDecisionForm: false,
      };
    case "REJECTED":
      return {
        tone: "danger",
        glyph: "✕",
        badgeLabel: "Rejected",
        copy: "A reviewer rejected this run's suggested actions. This decision is final.",
        hint: null,
        showsDecisionForm: false,
      };
  }
}
