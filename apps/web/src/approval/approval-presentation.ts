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
/**
 * The execution boundary, stated in the reader's own terms.
 *
 * WORDING IS LOAD-BEARING (issue #131). Three documents agree the mechanism
 * records a decision and nothing else — docs/13-approval-workflow.md §1,
 * docs/12-agent-run-api.md §30, README.md's capability matrix. The UI used to
 * promise an execution anyway ("requires review before execution"), which the
 * repo had already adjudicated as an overclaim once against a draft resume
 * bullet (docs/01-prd.md:530).
 *
 * Constraints this sentence satisfies, each a real mechanism limit:
 *   - never claims an execution, scheduling, dispatch, notification or
 *     escalation — none exists; schema.prisma has no entity to act on;
 *   - never claims a *simulated* execution, which would imply a downstream
 *     system was affected and is strictly weaker than the truth;
 *   - never claims database-enforced immutability (docs/13 §5: the no-edit
 *     guarantee is application-layer only);
 *   - PLURAL / set-wide, because one decision covers the whole
 *     suggestedActions array — "the action" would leave the boundary
 *     ambiguous for the rest of a multi-action run.
 *
 * approval-presentation.test.ts pins it and guards the claim families that
 * must never return.
 */
const NO_EXECUTION_PENDING = "OpsPilot records your decision; it does not carry out any suggested actions.";
const NO_EXECUTION_DECIDED = "OpsPilot recorded this decision; it does not carry out any suggested actions.";

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
        // BEFORE the decision, not only after it: ApprovalPanel renders hint
        // above ApprovalDecisionForm, so the reviewer reads the boundary while
        // deciding. Placing it only on the terminal states would leave them
        // pressing an irreversible button still believing approval causes the
        // actions to occur — the exact misconception #131 exists to remove.
        hint: NO_EXECUTION_PENDING,
        showsDecisionForm: true,
      };
    case "APPROVED":
      return {
        tone: "success",
        glyph: "✓",
        badgeLabel: "Approved",
        copy: "A reviewer approved this run's suggested actions. This decision is final.",
        hint: NO_EXECUTION_DECIDED,
        showsDecisionForm: false,
      };
    case "REJECTED":
      return {
        tone: "danger",
        glyph: "✕",
        badgeLabel: "Rejected",
        copy: "A reviewer rejected this run's suggested actions. This decision is final.",
        hint: NO_EXECUTION_DECIDED,
        showsDecisionForm: false,
      };
  }
}
