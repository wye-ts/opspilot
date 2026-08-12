import { describe, expect, it } from "vitest";

import { presentApproval } from "./approval-presentation";

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
    expect(result.hint).toBeNull();
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
