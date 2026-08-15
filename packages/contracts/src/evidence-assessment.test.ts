import { describe, expect, it } from "vitest";

import {
  EvidenceAssessmentSchema,
  deriveInvestigationStopReason,
} from "./evidence-assessment";

// A grounded status-unresolved assessment (INSUFFICIENT + one observation).
const statusUnresolvedAssessment = {
  evidenceState: "INSUFFICIENT",
  continuationReason: "STATUS_UNRESOLVED",
  supportedBy: [
    { evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" },
  ],
} as const;

describe("EvidenceAssessmentSchema", () => {
  it("accepts a valid grounded INSUFFICIENT assessment", () => {
    expect(EvidenceAssessmentSchema.safeParse(statusUnresolvedAssessment).success).toBe(true);
  });

  it("accepts NO_EVIDENCE_YET with an empty supportedBy", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        evidenceState: "INSUFFICIENT",
        continuationReason: "NO_EVIDENCE_YET",
        supportedBy: [],
      }).success,
    ).toBe(true);
  });

  it("accepts a positive CONFLICT_UNRESOLVED assessment with two distinct locators", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        evidenceState: "CONFLICTING",
        continuationReason: "CONFLICT_UNRESOLVED",
        supportedBy: [
          { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects SUFFICIENT evidence accompanying a request for another diagnostic", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        evidenceState: "SUFFICIENT",
      }).success,
    ).toBe(false);
  });

  it("rejects a repeated (sourceType, evidenceId) locator in supportedBy", () => {
    const single = statusUnresolvedAssessment.supportedBy[0];
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        supportedBy: [single, single],
      }).success,
    ).toBe(false);
  });

  it("counts the same raw id under different source types as distinct (P1-3)", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        evidenceState: "CONFLICTING",
        continuationReason: "CONFLICT_UNRESOLVED",
        supportedBy: [
          { evidenceId: "chunk-001", sourceType: "RAG_CHUNK" },
          { evidenceId: "chunk-001", sourceType: "TOOL_EXECUTION" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects CONFLICTING with fewer than two distinct locators", () => {
    const single = statusUnresolvedAssessment.supportedBy[0];
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        evidenceState: "CONFLICTING",
        supportedBy: [single],
      }).success,
    ).toBe(false);
  });

  it("rejects CONFLICT_UNRESOLVED accompanying a non-CONFLICTING state", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        continuationReason: "CONFLICT_UNRESOLVED",
      }).success,
    ).toBe(false);
  });

  it("rejects NO_EVIDENCE_YET that cites any locator", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        continuationReason: "NO_EVIDENCE_YET",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown evidenceState value", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        evidenceState: "DEFINITIVE",
      }).success,
    ).toBe(false);
  });

  it("rejects an extra key (strict)", () => {
    expect(
      EvidenceAssessmentSchema.safeParse({
        ...statusUnresolvedAssessment,
        rationale: "free-form hypothesis prose must not ride on the assessment",
      }).success,
    ).toBe(false);
  });
});

describe("deriveInvestigationStopReason", () => {
  it("returns BOUND_EXHAUSTED whenever forced finalization occurred (harness-owned)", () => {
    expect(
      deriveInvestigationStopReason({ evidenceState: "SUFFICIENT", forcedFinalization: true }),
    ).toBe("BOUND_EXHAUSTED");
    expect(
      deriveInvestigationStopReason({ evidenceState: undefined, forcedFinalization: true }),
    ).toBe("BOUND_EXHAUSTED");
  });

  it("returns SUFFICIENT_EVIDENCE for a declared SUFFICIENT voluntary report", () => {
    expect(
      deriveInvestigationStopReason({ evidenceState: "SUFFICIENT", forcedFinalization: false }),
    ).toBe("SUFFICIENT_EVIDENCE");
  });

  it("returns NO_JUSTIFIED_DIAGNOSTIC for INSUFFICIENT and CONFLICTING voluntary reports", () => {
    expect(
      deriveInvestigationStopReason({ evidenceState: "INSUFFICIENT", forcedFinalization: false }),
    ).toBe("NO_JUSTIFIED_DIAGNOSTIC");
    expect(
      deriveInvestigationStopReason({ evidenceState: "CONFLICTING", forcedFinalization: false }),
    ).toBe("NO_JUSTIFIED_DIAGNOSTIC");
  });

  it("returns null for a pre-#58 legacy report (no evidenceState, no forced finalization)", () => {
    expect(
      deriveInvestigationStopReason({ evidenceState: undefined, forcedFinalization: false }),
    ).toBeNull();
  });
});
