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
    },
  ],
  suggestedActions: [],
} as const;

function parseInvalid(overrides: Record<string, unknown>) {
  const result = ResolutionReportSchema.safeParse(
    { ...validReport, ...overrides },
    { reportInput: true },
  );
  if (result.success) throw new Error("expected validation to fail");
  return summarizeReportValidationIssues(result.error);
}

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
    const action = {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
    } as const;
    const issues = parseInvalid({ suggestedActions: [action, action, action, action] });

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
});
