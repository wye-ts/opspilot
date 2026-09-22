import { describe, expect, it } from "vitest";

import { presentApproval } from "./approval-presentation";
import { OVERCLAIM_FORMS } from "./overclaim-forms";

describe("presentApproval", () => {
  it("NOT_ELIGIBLE renders the neutral badge, explanatory copy, and NO query-param hint (§10)", () => {
    const result = presentApproval("NOT_ELIGIBLE", 0);
    expect(result.tone).toBe("neutral");
    expect(result.glyph).toBe("—");
    expect(result.badgeLabel).toBe("Not eligible");
    expect(result.copy).toBe("This run has no suggested actions to approve.");
    // §10: the ?approval-demo=1 path stays a deterministic hidden/test entry
    // point but is NEVER a user-facing instruction, so no hint is rendered.
    expect(result.hint).toBeNull();
    expect(result.showsDecisionForm).toBe(false);
  });

  it("PENDING renders the info badge and singular copy for one suggested action", () => {
    const result = presentApproval("PENDING", 1);
    expect(result.tone).toBe("info");
    expect(result.glyph).toBe("●");
    expect(result.badgeLabel).toBe("Pending");
    expect(result.copy).toBe("This run has 1 suggested action awaiting a decision.");
    // Issue #131: the boundary is disclosed BEFORE the decision, so this is
    // deliberately no longer null. ApprovalPanel renders hint above
    // ApprovalDecisionForm.
    expect(result.hint).toBe("OpsPilot records your decision; it does not carry out any suggested actions.");
    expect(result.showsDecisionForm).toBe(true);
  });

  it("PENDING renders plural copy for more than one suggested action", () => {
    const result = presentApproval("PENDING", 3);
    expect(result.copy).toBe("This run has 3 suggested actions awaiting a decision.");
    expect(result.showsDecisionForm).toBe(true);
  });

  it("APPROVED renders the success badge, terminal copy, and shows no decision form", () => {
    const result = presentApproval("APPROVED", 0);
    expect(result.tone).toBe("success");
    expect(result.glyph).toBe("✓");
    expect(result.badgeLabel).toBe("Approved");
    expect(result.copy).toContain("approved");
    expect(result.showsDecisionForm).toBe(false);
  });

  it("REJECTED renders the danger badge, terminal copy, and shows no decision form", () => {
    const result = presentApproval("REJECTED", 0);
    expect(result.tone).toBe("danger");
    expect(result.glyph).toBe("✕");
    expect(result.badgeLabel).toBe("Rejected");
    expect(result.copy).toContain("rejected");
    expect(result.showsDecisionForm).toBe(false);
  });
});


/**
 * Issue #131 — the approval surface must not promise an execution.
 *
 * Three documents agree the mechanism records a decision and nothing else
 * (docs/13-approval-workflow.md §1, docs/12-agent-run-api.md §30, README's
 * capability matrix). The UI promised one anyway.
 *
 * Plan: docs/reviews/51-issue-131-approval-copy-execution-overclaim-plan.md
 */
describe("presentApproval — issue #131 execution boundary", () => {
  const DISCLOSURE = "does not carry out any suggested actions";

  it("discloses the boundary on PENDING, i.e. BEFORE the decision is made", () => {
    // The load-bearing case. A disclosure that appears only after an
    // irreversible click preserves the misconception it exists to remove:
    // the reviewer approves still believing the actions will occur.
    // ApprovalPanel renders hint above ApprovalDecisionForm, so a non-null
    // hint here IS "before the controls" (position pinned in its own suite).
    const pending = presentApproval("PENDING", 1);
    expect(pending.showsDecisionForm).toBe(true);
    expect(pending.hint).not.toBeNull();
    expect(pending.hint).toContain(DISCLOSURE);
  });

  it("discloses the boundary on both terminal states", () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const result = presentApproval(status, 1);
      expect(result.hint, status).not.toBeNull();
      expect(result.hint, status).toContain(DISCLOSURE);
    }
  });

  it("states the boundary set-wide, so it is unambiguous for a multi-action run", () => {
    // One decision covers the whole suggestedActions array. Singular wording
    // ("the action") would leave the rest of a multi-action run ambiguous on
    // the very screen being corrected to describe that boundary.
    for (const status of ["PENDING", "APPROVED", "REJECTED"] as const) {
      const hint = presentApproval(status, 3).hint;
      expect(hint, status).toContain("any suggested actions");
      expect(hint, status).not.toMatch(/\bthe action\b/i);
    }
  });

  it("never claims execution, scheduling, dispatch, simulation, notification or escalation", () => {
    // Guards the CLAIM FAMILY, not a list of phrasings — see overclaim-forms.ts
    // for why, and why the term list is shared with the banner's guard.
    const pattern = new RegExp(`\\b(${OVERCLAIM_FORMS.join("|")})\\b`, "i");

    // Read from the module's own output, never from a copy of the literals —
    // a guard reading a duplicate of the text it guards proves nothing.
    const strings = (["NOT_ELIGIBLE", "PENDING", "APPROVED", "REJECTED"] as const).flatMap(
      (status) => {
        const r = presentApproval(status, 2);
        return [r.copy, r.badgeLabel, r.hint].filter((s): s is string => s !== null);
      },
    );
    expect(strings.length).toBeGreaterThan(0);

    for (const s of strings) {
      expect(s, `user-visible string claims an action OpsPilot never performs: "${s}"`).not.toMatch(pattern);
    }

    // The guard must actually fire on the claims it exists to catch,
    // including every variant that defeated an earlier draft.
    for (const claim of [
      "requires review before execution",
      "A reviewer approved this run; its actions are executed.",
      "Approved actions execute after approval",
      "Execution follows approval",
      "OpsPilot schedules the actions",
      "The action was dispatched",
      "The reviewer is notified",
      "A notification is sent after approval",
      "This action is simulated",
      "The incident escalates to on-call",
    ]) {
      expect(claim, `guard missed a forbidden claim: "${claim}"`).toMatch(pattern);
    }

    // ...and must stay silent on innocent words that CONTAIN a guarded token.
    for (const innocent of ["dispatcher queue", "scheduler thread", "executive summary"]) {
      expect(innocent, `guard false-positived on: "${innocent}"`).not.toMatch(pattern);
    }
  });
});
