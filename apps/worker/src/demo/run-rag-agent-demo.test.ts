import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { EvidenceState, ResolutionReport } from "@opspilot/contracts";
import {
  DEMO_TICKET,
  formatDemoOutput,
  getExitCode,
  runRagDemoScenario,
  type RagDemoScenarioResult,
} from "./run-rag-agent-demo";

// A minimal, otherwise-valid report used only to isolate rootCause/evidenceState
// rendering — the specific category/summary/evidence values are irrelevant here.
function buildReport(
  rootCause: string | null,
  evidenceState: EvidenceState,
): ResolutionReport {
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

function completedResult(report: ResolutionReport): RagDemoScenarioResult {
  const agentResult: AgentOrchestratorResult = {
    status: "completed",
    report,
    trace: [],
  };
  return { agentResult, corpusLoad: { chunks: [], sourceFileCount: 0 } };
}

describe("runRagDemoScenario", () => {
  it("loads the real Markdown corpus and completes successfully", async () => {
    const result = await runRagDemoScenario();

    expect(result.corpusLoad.sourceFileCount).toBe(5);
    expect(result.corpusLoad.chunks).toHaveLength(7);
    expect(result.agentResult.status).toBe("completed");
  });

  it("records trace events in order RETRIEVAL_COMPLETED -> TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_GENERATED", async () => {
    const result = await runRagDemoScenario();

    expect(result.agentResult.trace[0]?.type).toBe("RETRIEVAL_COMPLETED");
    expect(result.agentResult.trace.slice(1)).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("retrieves the notification-degradation chunk ranked first, via the real deterministic retriever", async () => {
    const result = await runRagDemoScenario();

    const retrieval = result.agentResult.trace[0];
    if (retrieval?.type !== "RETRIEVAL_COMPLETED") throw new Error("unreachable");
    expect(retrieval.chunks[0]?.chunkId).toBe("runbook-notification-degradation-001");
    expect(retrieval.chunks[0]?.rank).toBe(1);
    expect(retrieval.chunks.length).toBeLessThanOrEqual(2);
  });

  it("produces a report citing both TOOL_EXECUTION and RAG_CHUNK evidence, and validation passes", async () => {
    const result = await runRagDemoScenario();

    expect(result.agentResult.status).toBe("completed");
    if (result.agentResult.status !== "completed") throw new Error("unreachable");
    const sourceTypes = result.agentResult.report.evidence.map((entry) => entry.sourceType);
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

  it("prints a corpus-load summary derived from the actual load result, not hardcoded", async () => {
    const result = await runRagDemoScenario();

    const output = formatDemoOutput(DEMO_TICKET, result);
    const summaryLine = output.split("\n").find((line) => line.startsWith("Loaded "));

    expect(summaryLine).toMatch(/^Loaded \d+ chunks? from \d+ Markdown runbooks?\.$/);
    expect(summaryLine).toContain(`Loaded ${result.corpusLoad.chunks.length} chunks`);
    expect(summaryLine).toContain(`from ${result.corpusLoad.sourceFileCount} Markdown runbooks.`);
  });

  it("reports a failure without exposing internal error details", () => {
    const failedAgentResult: AgentOrchestratorResult = {
      status: "failed",
      code: "RETRIEVAL_FAILED",
      message: "Runbook retrieval failed (TIMEOUT).",
      trace: [],
      failedStage: "AGENT_ANALYSIS",
    };
    const failedResult: RagDemoScenarioResult = {
      agentResult: failedAgentResult,
      corpusLoad: { chunks: [], sourceFileCount: 0 },
    };

    const output = formatDemoOutput(DEMO_TICKET, failedResult);

    expect(output).toContain("Code: RETRIEVAL_FAILED");
    expect(output).not.toContain("at ");
    expect(output).not.toContain("node_modules");
    expect(getExitCode(failedResult.agentResult)).toBe(1);
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
