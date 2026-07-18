import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "../agent/agent-orchestrator";
import {
  DEMO_TICKET,
  formatDemoOutput,
  getExitCode,
  runRagDemoScenario,
} from "./run-rag-agent-demo";

describe("runRagDemoScenario", () => {
  it("completes successfully", async () => {
    const result = await runRagDemoScenario();

    expect(result.status).toBe("completed");
  });

  it("records trace events in order RETRIEVAL_COMPLETED -> TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_GENERATED", async () => {
    const result = await runRagDemoScenario();

    expect(result.trace[0]?.type).toBe("RETRIEVAL_COMPLETED");
    expect(result.trace.slice(1)).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("retrieves the notification-degradation chunk ranked first, via the real deterministic retriever", async () => {
    const result = await runRagDemoScenario();

    const retrieval = result.trace[0];
    if (retrieval?.type !== "RETRIEVAL_COMPLETED") throw new Error("unreachable");
    expect(retrieval.chunks[0]?.chunkId).toBe("runbook-notification-degradation-001");
    expect(retrieval.chunks[0]?.rank).toBe(1);
    expect(retrieval.chunks.length).toBeLessThanOrEqual(2);
  });

  it("produces a report citing both TOOL_EXECUTION and RAG_CHUNK evidence, and validation passes", async () => {
    const result = await runRagDemoScenario();

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    const sourceTypes = result.report.evidence.map((entry) => entry.sourceType);
    expect(sourceTypes).toContain("TOOL_EXECUTION");
    expect(sourceTypes).toContain("RAG_CHUNK");
  });
});

describe("formatDemoOutput", () => {
  it("prints the retrieval query, retrieved chunk IDs/rank/score, and evidence validation result", async () => {
    const result = await runRagDemoScenario();

    const output = formatDemoOutput(DEMO_TICKET, result);

    expect(output).toContain("Retrieval query:");
    expect(output).toContain("RETRIEVAL_COMPLETED");
    expect(output).toContain("runbook-notification-degradation-001");
    expect(output).toContain("rank 1");
    expect(output).toContain("RAG_CHUNK runbook-notification-degradation-001:");
    expect(output).toContain("Evidence Validation");
    expect(output).toContain("PASSED");
  });

  it("reports a failure without exposing internal error details", () => {
    const failedResult: AgentOrchestratorResult = {
      status: "failed",
      code: "RETRIEVAL_FAILED",
      message: "Runbook retrieval failed (TIMEOUT).",
      trace: [],
    };

    const output = formatDemoOutput(DEMO_TICKET, failedResult);

    expect(output).toContain("Code: RETRIEVAL_FAILED");
    expect(output).not.toContain("at ");
    expect(output).not.toContain("node_modules");
    expect(getExitCode(failedResult)).toBe(1);
  });
});
