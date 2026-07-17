import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "../agent/agent-orchestrator";
import {
  DEMO_TICKET,
  formatDemoOutput,
  getExitCode,
  runDemoScenario,
} from "./run-agent-demo";

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
    };

    const output = formatDemoOutput(DEMO_TICKET, failedResult);

    expect(output).toContain("Code: TOOL_NOT_FOUND");
    expect(output).toContain('Unknown diagnostic tool "get_service_status".');
    expect(output).not.toContain("at ");
    expect(output).not.toContain("node_modules");
    expect(getExitCode(failedResult)).toBe(1);
  });
});
