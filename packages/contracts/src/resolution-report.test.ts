import { describe, expect, it } from "vitest";

import { ResolutionReportSchema, StoredResolutionReportSchema } from "./resolution-report";

// A grounded, causal SUFFICIENT report — the pre-#58 "happy path" plus the new
// required evidenceState field.
const causalSufficientReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause:
    "The notification service is degraded after repeated upstream rate-limit responses.",
  customerImpact:
    "Some password-reset and account-verification emails are delayed.",
  recommendedResolution:
    "Monitor the upstream provider, reduce retry pressure, and escalate if degradation continues.",
  confidence: 0.9,
  evidence: [
    {
      evidenceId: "rag-chunk-001",
      sourceType: "RAG_CHUNK",
      finding:
        "The runbook identifies upstream rate limiting as a known cause of delayed notifications.",
    },
    {
      evidenceId: "tool-execution-001",
      sourceType: "TOOL_EXECUTION",
      finding: "The notification service currently reports DEGRADED.",
    },
  ],
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Messaging Platform",
        reason: "Sustained upstream rate limiting is affecting customers.",
        priority: "HIGH",
      },
    },
  ],
  evidenceState: "SUFFICIENT",
} as const;

describe("ResolutionReportSchema (strict new-write contract)", () => {
  it("accepts a valid grounded SUFFICIENT report with a causal rootCause", () => {
    expect(ResolutionReportSchema.safeParse(causalSufficientReport).success).toBe(true);
  });

  it("accepts SUFFICIENT + rootCause null (a grounded non-causal conclusion)", () => {
    // P1-1: the invariant is one-way — sufficient evidence may carry a null
    // rootCause for a "no fault observed / healthy" verdict.
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        rootCause: null,
      }).success,
    ).toBe(true);
  });

  it("accepts INSUFFICIENT + rootCause null + one evidence entry", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: causalSufficientReport.evidence.slice(1),
      }).success,
    ).toBe(true);
  });

  it("accepts a truthful zero-evidence INSUFFICIENT report (C0)", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: [],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-SUFFICIENT report with a non-null rootCause (P1-1)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      evidenceState: "INSUFFICIENT",
      rootCause: "A definitive root cause despite insufficient evidence.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CONFLICTING + non-null rootCause", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidenceState: "CONFLICTING",
        rootCause: "One definitive root cause while evidence conflicts.",
      }).success,
    ).toBe(false);
  });

  it("rejects SUFFICIENT with an empty evidence array (P1-3 cardinality)", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it("rejects CONFLICTING with fewer than two distinct evidence locators", () => {
    // Same (sourceType, evidenceId) twice is one distinct locator, so the
    // conflict shape guarantee (>= 2 distinct grounded locators) fails.
    const single = causalSufficientReport.evidence[1];
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidenceState: "CONFLICTING",
        rootCause: null,
        evidence: [single, { ...single, finding: "A second observation of the same call." }],
      }).success,
    ).toBe(false);
  });

  it("accepts a CONFLICTING report citing both disagreeing sides (D)", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        category: "UNKNOWN",
        evidenceState: "CONFLICTING",
        rootCause: null,
        evidence: [
          {
            evidenceId: "call-1",
            sourceType: "TOOL_EXECUTION",
            finding: "Probe reported DEGRADED.",
          },
          {
            evidenceId: "call-2",
            sourceType: "TOOL_EXECUTION",
            finding: "Probe reported OPERATIONAL for the same claim.",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a missing evidenceState key", () => {
    const { evidenceState: _evidenceState, ...withoutEvidenceState } = causalSufficientReport;
    expect(ResolutionReportSchema.safeParse(withoutEvidenceState).success).toBe(false);
  });

  it("rejects confidence outside the zero-to-one range", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      confidence: 1.5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported suggested action types", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [
        {
          type: "RESTART_PRODUCTION_SERVICE",
          payload: {
            service: "notification-service",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than three suggested actions", () => {
    const action = {
      type: "UPDATE_TICKET_STATUS",
      payload: {
        status: "IN_PROGRESS",
        reason: "Investigation is continuing.",
      },
    } as const;

    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [action, action, action, action],
    });

    expect(result.success).toBe(false);
  });
});

describe("StoredResolutionReportSchema (fail-closed legacy read compat)", () => {
  // A pre-#58 stored report had NO evidenceState and always carried a non-null
  // string rootCause with >= 1 evidence entry. It must keep reading exactly.
  const legacyReport = {
    category: "SERVICE_DEGRADATION",
    summary: "Notification delivery is delayed for some customers.",
    rootCause: "The notification service is degraded after repeated upstream rate-limit responses.",
    customerImpact: "Some password-reset and account-verification emails are delayed.",
    recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
    confidence: 0.9,
    evidence: [
      {
        evidenceId: "tool-execution-001",
        sourceType: "TOOL_EXECUTION",
        finding: "The notification service currently reports DEGRADED.",
      },
    ],
    suggestedActions: [],
  };

  it("accepts a valid pre-#58 legacy report (non-null rootCause + >= 1 evidence)", () => {
    expect(StoredResolutionReportSchema.safeParse(legacyReport).success).toBe(true);
  });

  it("rejects a corrupt legacy report with rootCause null (Stage-0 fail-closed)", () => {
    expect(
      StoredResolutionReportSchema.safeParse({ ...legacyReport, rootCause: null }).success,
    ).toBe(false);
  });

  it("rejects a corrupt legacy report with an empty evidence array (Stage-0 fail-closed)", () => {
    expect(
      StoredResolutionReportSchema.safeParse({ ...legacyReport, evidence: [] }).success,
    ).toBe(false);
  });

  it("applies the new-write #58 rules to stored reports that DO carry evidenceState", () => {
    // INSUFFICIENT + null rootCause + zero evidence round-trips on the read side.
    expect(
      StoredResolutionReportSchema.safeParse({
        ...legacyReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: [],
      }).success,
    ).toBe(true);
    // SUFFICIENT + null rootCause + >= 1 evidence round-trips on the read side.
    expect(
      StoredResolutionReportSchema.safeParse({
        ...legacyReport,
        evidenceState: "SUFFICIENT",
        rootCause: null,
      }).success,
    ).toBe(true);
  });
});
