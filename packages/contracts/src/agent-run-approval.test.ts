import { describe, expect, it } from "vitest";

import { ApprovalDecisionSchema, RecordApprovalDecisionInputSchema } from "./agent-run-approval";

describe("ApprovalDecisionSchema", () => {
  it("accepts APPROVED", () => {
    expect(ApprovalDecisionSchema.safeParse("APPROVED").success).toBe(true);
  });

  it("accepts REJECTED", () => {
    expect(ApprovalDecisionSchema.safeParse("REJECTED").success).toBe(true);
  });

  it("rejects any other value", () => {
    expect(ApprovalDecisionSchema.safeParse("MAYBE").success).toBe(false);
  });
});

describe("RecordApprovalDecisionInputSchema", () => {
  it("accepts a well-formed input with note absent", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBeUndefined();
    }
  });

  it("accepts a well-formed input with note present", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "REJECTED",
      reviewerName: "jacky",
      note: "Not enough evidence.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBe("Not enough evidence.");
    }
  });

  it("trims reviewerName", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "  jacky  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reviewerName).toBe("jacky");
    }
  });

  it("trims note", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "  looks good  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBe("looks good");
    }
  });

  it("rejects a whitespace-only reviewerName", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only note", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects reviewerName exceeding 100 characters (post-trim)", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "a".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("accepts reviewerName at exactly 100 characters", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "a".repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it("rejects note exceeding 1000 characters (post-trim)", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "a".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts note at exactly 1000 characters", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "a".repeat(1000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid decision", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "MAYBE",
      reviewerName: "jacky",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
      reviewerName: "jacky",
      extra: "not allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing reviewerName", () => {
    const result = RecordApprovalDecisionInputSchema.safeParse({
      decision: "APPROVED",
    });
    expect(result.success).toBe(false);
  });
});
