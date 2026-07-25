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
// approval-presentation.test.ts). The NOT_ELIGIBLE hint names the "Approval
// workflow demo" checkbox — never a ticket ID — since typing a ticket ID is
// not something the UI exposes anywhere.
export function presentApproval(status: ApprovalStatus, suggestedActionCount: number): ApprovalPresentation {
  switch (status) {
    case "NOT_ELIGIBLE":
      return {
        tone: "neutral",
        glyph: "—",
        badgeLabel: "Not eligible",
        copy: "This run has no suggested actions to approve.",
        hint:
          "A run is approvable only when it completed and produced at least one suggested action. " +
          'Tick "Approval workflow demo" and run again to see an approvable investigation.',
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
