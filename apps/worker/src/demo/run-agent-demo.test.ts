import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { EvidenceState, ResolutionReport } from "@opspilot/contracts";
import {
  DEMO_TICKET,
  formatDemoOutput,
  getExitCode,
  runDemoScenario,
} from "./run-agent-demo";

// A minimal, otherwise-valid report used only to isolate rootCause/evidenceState
// rendering — the specific category/summary/evidence values are irrelevant here.
function buildReport(rootCause: string | null, evidenceState: EvidenceState): ResolutionReport {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "Summary.",
    rootCause,
    customerImpact: "Impact.",
    recommendedResolution: "Resolution.",
    confidence: 0.5,
    evidence: [],
    suggestedActions: [],
    recommendationDisposition: "ADVISORY",
    evidenceState,
  };
}

function completedResult(report: ResolutionReport): AgentOrchestratorResult {
  return { status: "completed", report, trace: [] };
}

describe("runDemoScenario", () => {
  it("completes successfully", async () => {
    const result = await runDemoScenario();

    expect(result.status).toBe("completed");
  });

  it("records trace events in order TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_GENERATED", async () => {
    const result = await runDemoScenario();

    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });
});

describe("formatDemoOutput", () => {
  it("includes category, confidence, evidence, and suggested action for a completed result", async () => {
    const result = await runDemoScenario();

    const output = formatDemoOutput(DEMO_TICKET, result);

    expect(output).toContain("Category: SERVICE_DEGRADATION");
    expect(output).toContain("Confidence: 0.90");
    expect(output).toContain("TOOL_EXECUTION call-1:");
    expect(output).toContain("CREATE_ESCALATION: Messaging Platform / HIGH");
  });

  it("reports a failure without exposing internal error details", () => {
    const failedResult: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_NOT_FOUND",
      message: 'Unknown diagnostic tool "get_service_status".',
      trace: [],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };

    const output = formatDemoOutput(DEMO_TICKET, failedResult);

    expect(output).toContain("Code: TOOL_NOT_FOUND");
    expect(output).toContain('Unknown diagnostic tool "get_service_status".');
    expect(output).not.toContain("at ");
    expect(output).not.toContain("node_modules");
    expect(getExitCode(failedResult)).toBe(1);
  });

  it("prints the exact rootCause when non-null", () => {
    const output = formatDemoOutput(
      DEMO_TICKET,
      completedResult(buildReport("notification-service is degraded.", "SUFFICIENT")),
    );

    expect(output).toContain("Root Cause: notification-service is degraded.");
    expect(output).not.toContain("Root Cause: null");
  });

  it("renders SUFFICIENT + null rootCause as a non-causal conclusion, never the literal null", () => {
    const output = formatDemoOutput(DEMO_TICKET, completedResult(buildReport(null, "SUFFICIENT")));

    expect(output).toContain("Root Cause: No causal root cause identified.");
    expect(output).not.toContain("Root Cause: null");
  });

  it("renders INSUFFICIENT + null rootCause as insufficient evidence, never the literal null", () => {
    const output = formatDemoOutput(
      DEMO_TICKET,
      completedResult(buildReport(null, "INSUFFICIENT")),
    );

    expect(output).toContain("Root Cause: Not determined — insufficient evidence.");
    expect(output).not.toContain("Root Cause: null");
  });

  it("renders CONFLICTING + null rootCause as conflicting evidence, never the literal null", () => {
    const output = formatDemoOutput(
      DEMO_TICKET,
      completedResult(buildReport(null, "CONFLICTING")),
    );

    expect(output).toContain("Root Cause: Not determined — evidence is conflicting.");
    expect(output).not.toContain("Root Cause: null");
  });
});
