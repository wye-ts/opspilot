import { describe, expect, it } from "vitest";

import { ResolutionReportSchema } from "./resolution-report";
import { summarizeReportValidationIssues } from "./resolution-report-validation";

const validReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause: "notification-service is degraded.",
  customerImpact: "Some customers are receiving delayed notifications.",
  recommendedResolution: "Monitor notification-service until it recovers.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
      supports: ["ROOT_CAUSE"],
    },
  ],
  suggestedActions: [],
  evidenceState: "SUFFICIENT",
  // Issue #60: the write contract now requires the model-declared disposition.
  // This fixture's empty suggestedActions is consistent only with ADVISORY.
  recommendationDisposition: "ADVISORY",
} as const;

function parseInvalid(overrides: Record<string, unknown>) {
  const result = ResolutionReportSchema.safeParse(
    { ...validReport, ...overrides },
    { reportInput: true },
  );
  if (result.success) throw new Error("expected validation to fail");
  return summarizeReportValidationIssues(result.error);
}

describe("suggestedActions contract", () => {
  // The premise every other case in this file builds on, asserted rather than
  // assumed: an empty suggestedActions is a fully VALID report, which is why
  // supplying [] for an omitted field at the provider boundary invents nothing
  // (see normalizeSubmittedReportInput in @opspilot/provider-claude).
  it("accepts an empty suggestedActions array", () => {
    const result = ResolutionReportSchema.safeParse(validReport, { reportInput: true });

    expect(result.success).toBe(true);
  });

  // The EXACT diagnostic the production LIVE run emitted (runId 179848c0…).
  // Locked here so the boundary normalization can never be mistaken for a
  // change to the canonical contract: unrepaired input still fails this way.
  it("reports the production invalid_type diagnostic for an omitted suggestedActions", () => {
    const { suggestedActions: _suggestedActions, ...withoutSuggestedActions } = validReport;
    const result = ResolutionReportSchema.safeParse(withoutSuggestedActions, { reportInput: true });
    if (result.success) throw new Error("expected validation to fail");

    expect(summarizeReportValidationIssues(result.error)).toEqual([
      {
        path: ["suggestedActions"],
        code: "invalid_type",
        expectedType: "array",
        receivedType: "undefined",
      },
    ]);
  });

  // The canonical schema stays strict: only a genuinely ABSENT field is
  // repaired upstream, so these asserted values must still be rejected here.
  it("rejects a null suggestedActions rather than treating it as absent", () => {
    expect(parseInvalid({ suggestedActions: null })).toEqual([
      { path: ["suggestedActions"], code: "invalid_type", expectedType: "array", receivedType: "null" },
    ]);
  });

  // "no" rather than a longer word on purpose: the array's own .max(3) also
  // runs against a string input's length, so a 4+ character value would add an
  // unrelated too_big issue and obscure the type mismatch under test.
  it.each([
    ["a string", "no", "string"],
    ["an object", { first: "UPDATE_TICKET_STATUS" }, "object"],
  ])("rejects a suggestedActions given as %s", (_label, suggestedActions, receivedType) => {
    expect(parseInvalid({ suggestedActions })).toEqual([
      { path: ["suggestedActions"], code: "invalid_type", expectedType: "array", receivedType },
    ]);
  });
});

describe("summarizeReportValidationIssues", () => {
  it("reports a too_big issue with the schema's own bound, not the received value, for a percentage-scale confidence", () => {
    // The exact contract-drift class behind the LIVE REPORT_SCHEMA_INVALID
    // incident: Claude's tool schema strips `minimum`/`maximum`, so nothing
    // tells it confidence must be a 0-1 fraction rather than a percentage.
    const issues = parseInvalid({ confidence: 70 });

    expect(issues).toEqual([{ path: ["confidence"], code: "too_big", origin: "number", bound: 1 }]);
    expect(JSON.stringify(issues)).not.toContain("70");
  });

  it("reports a too_big issue for an evidence array beyond the stripped maxItems bound", () => {
    const entry = validReport.evidence[0];
    const issues = parseInvalid({ evidence: Array.from({ length: 11 }, () => entry) });

    expect(issues).toEqual([{ path: ["evidence"], code: "too_big", origin: "array", bound: 10 }]);
  });

  it("reports a too_big issue for suggestedActions beyond the stripped maxItems bound", () => {
    // Each action carries a groundedBy locator (Issue #60), and the disposition
    // is flipped to ACTIONABLE, so the ONLY failure is the count bound — the
    // array's own .max(3) — not an unrelated min(1) grounding issue on every
    // element or an ADVISORY cardinality issue (superRefine still runs on a
    // "dirty" over-count array and would otherwise see a non-empty action list).
    const action = {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
      groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
    } as const;
    const issues = parseInvalid({
      recommendationDisposition: "ACTIONABLE",
      suggestedActions: [action, action, action, action],
    });

    expect(issues).toEqual([{ path: ["suggestedActions"], code: "too_big", origin: "array", bound: 3 }]);
  });

  it("reports a too_small issue, not the empty value, for a blank required string", () => {
    const issues = parseInvalid({ summary: "" });

    expect(issues).toEqual([{ path: ["summary"], code: "too_small", origin: "string", bound: 1 }]);
  });

  it("reports invalid_type with only type names, not the actual value, for a missing required field", () => {
    const { summary: _summary, ...withoutSummary } = validReport;
    const result = ResolutionReportSchema.safeParse(withoutSummary, { reportInput: true });
    if (result.success) throw new Error("expected validation to fail");
    const issues = summarizeReportValidationIssues(result.error);

    expect(issues).toEqual([
      { path: ["summary"], code: "invalid_type", expectedType: "string", receivedType: "undefined" },
    ]);
  });

  it("reports invalid_value for an unsupported enum, with a derived type name but never the offending string", () => {
    const issues = parseInvalid({ category: "hunter2-not-a-real-category" });

    expect(issues).toEqual([
      { path: ["category"], code: "invalid_value", expectedType: "enum", receivedType: "string" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("reports invalid_type with the actual received type name for a present-but-wrong-typed field", () => {
    const issues = parseInvalid({ confidence: "high" });

    expect(issues).toEqual([
      { path: ["confidence"], code: "invalid_type", expectedType: "number", receivedType: "string" },
    ]);
  });

  it("reports unrecognized_keys as a count, never the extra key's own name or value", () => {
    const issues = parseInvalid({ secretDebugField: "hunter2-leaked-value" });

    expect(issues).toEqual([{ path: [], code: "unrecognized_keys", count: 1 }]);
    expect(JSON.stringify(issues)).not.toContain("hunter2");
    expect(JSON.stringify(issues)).not.toContain("secretDebugField");
  });

  it("never touches the raw input across every issue kind, for a report combining several violations", () => {
    const issues = parseInvalid({
      confidence: 95,
      customerImpact: "hunter2-marker-value".repeat(60),
    });

    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain("95");
    expect(serialized).not.toContain("hunter2");
  });

  // Issue #80: a real LIVE run failed REPORT_SCHEMA_INVALID with the
  // production log line collapsed to { path, code: "custom" } for every one
  // of this schema's superRefine invariants, giving an operator no way to
  // tell WHICH of several structurally-distinct "custom" checks at a given
  // path actually tripped (see docs/reviews/*-issue-80-*.md). Every addIssue
  // call site in resolution-report.ts carries a fixed, hand-written message
  // literal with no interpolated report data, so surfacing it is safe.
  it("reports a custom issue's fixed message, never a value, for the groundedBy-not-in-evidence invariant (Issue #80's real failure)", () => {
    const action = {
      type: "CREATE_ESCALATION",
      payload: { team: "Messaging Platform", reason: "Needs manual investigation.", priority: "MEDIUM" },
      groundedBy: [{ evidenceId: "toolu_not_in_evidence", sourceType: "TOOL_EXECUTION" }],
    } as const;
    const issues = parseInvalid({
      evidence: [],
      evidenceState: "INSUFFICIENT",
      rootCause: null,
      recommendationDisposition: "ACTIONABLE",
      suggestedActions: [action],
    });

    expect(issues).toEqual([
      {
        path: ["suggestedActions", 0, "groundedBy", 0],
        code: "custom",
        message: "suggestedActions[].groundedBy entries must each appear in report.evidence.",
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain("toolu_not_in_evidence");
  });

  it("never emits a message field for any non-custom issue code", () => {
    for (const issues of [
      parseInvalid({ confidence: 70 }),
      parseInvalid({ evidence: Array.from({ length: 11 }, () => validReport.evidence[0]) }),
      parseInvalid({ summary: "" }),
      parseInvalid({ category: "hunter2-not-a-real-category" }),
      parseInvalid({ confidence: "high" }),
      parseInvalid({ secretDebugField: "x" }),
    ]) {
      for (const issue of issues) {
        expect(issue).not.toHaveProperty("message");
      }
    }
  });
});
