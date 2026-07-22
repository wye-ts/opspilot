import { describe, expect, it } from "vitest";

import type { AgentOrchestratorErrorCode, ResolutionReport } from "@opspilot/contracts";

import type { AgentOrchestratorResult } from "../agent/agent-orchestrator";
import {
  evaluateCase,
  evaluateFailure,
  evaluateReport,
  evaluateRetrieval,
  evaluateStatus,
  evaluateTool,
} from "./evaluation-evaluator";
import type { RecordedToolExecution } from "./recording-tool-registry";
import type { EvaluationCase, EvaluationExpectations } from "./types";

const VALID_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "summary",
  rootCause: "root cause",
  customerImpact: "impact",
  recommendedResolution: "resolution",
  confidence: 0.5,
  evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "finding" }],
  suggestedActions: [
    { type: "UPDATE_TICKET_STATUS", payload: { status: "IN_PROGRESS", reason: "reason" } },
  ],
};

function completed(report: ResolutionReport = VALID_REPORT): AgentOrchestratorResult {
  return { status: "completed", report, trace: [] };
}

function failed(code: AgentOrchestratorErrorCode): AgentOrchestratorResult {
  return { status: "failed", code, message: "fixed message", trace: [] };
}

function check(result: ReturnType<typeof evaluateRetrieval>, name: string) {
  return result.find((c) => c.name === name);
}

describe("evaluateRetrieval", () => {
  it("returns no checks when no retrieval expectations are declared", () => {
    expect(evaluateRetrieval(undefined, { retrievalCompletedObserved: false, retrievedChunkIds: [] })).toEqual([]);
  });

  it("fails retrieval-top1 with a missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { retrievalCompletedObserved: false, retrievedChunkIds: [] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(false);
    expect(check(result, "retrieval-top1")?.reason).toBe("No retrieval result was observed for this case.");
  });

  it("fails retrieval-top1 with a fixed reason (no raw chunk ids) when the top-ranked chunk mismatches, even with sentinel-valued expectations", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "SENTINEL-expected-chunk" },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["SENTINEL-observed-chunk"] },
    );
    const failure = check(result, "retrieval-top1");
    expect(failure?.passed).toBe(false);
    expect(failure?.reason).toBe("The expected top-ranked chunk was not observed.");
    expect(failure?.reason).not.toContain("SENTINEL");
  });

  it("passes retrieval-top1 when the top-ranked chunk matches", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["a", "b"] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(true);
  });

  it("fails retrieval-top1 when the top-ranked chunk does not match", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["b", "a"] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(false);
  });

  it("fails retrieval-hit3 with a missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { retrievalCompletedObserved: false, retrievedChunkIds: [] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(false);
  });

  it("passes retrieval-hit3 when every expected id appears within the observed top-K", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["a", "b", "c"] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(true);
  });

  it("fails retrieval-hit3 when an expected id is missing from the observed top-K", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["a"] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(false);
  });

  it("fails retrieval-no-results with a distinct missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { retrievalCompletedObserved: false, retrievedChunkIds: [] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(false);
    expect(check(result, "retrieval-no-results")?.reason).toBe(
      "No retrieval result was observed for this case.",
    );
  });

  it("passes retrieval-no-results when RETRIEVAL_COMPLETED was observed with zero chunks", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { retrievalCompletedObserved: true, retrievedChunkIds: [] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(true);
  });

  it("fails retrieval-no-results when chunks were actually retrieved", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["a"] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(false);
  });

  it("passes retrieval-forbidden when no forbidden chunk id was retrieved", () => {
    const result = evaluateRetrieval(
      { forbiddenChunkIds: ["x"] },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["y"] },
    );
    expect(check(result, "retrieval-forbidden")?.passed).toBe(true);
  });

  it("fails retrieval-forbidden when a forbidden chunk id was retrieved", () => {
    const result = evaluateRetrieval(
      { forbiddenChunkIds: ["x"] },
      { retrievalCompletedObserved: true, retrievedChunkIds: ["x"] },
    );
    expect(check(result, "retrieval-forbidden")?.passed).toBe(false);
  });
});

describe("evaluateTool", () => {
  it("returns no checks when no tool expectations are declared", () => {
    expect(
      evaluateTool(undefined, {
        requestedTools: [],
        executedTools: [],
        completedToolCallIds: [],
        completedTools: [],
      }),
    ).toEqual([]);
  });

  it("fails tool-requested when the expected TOOL_REQUESTED entry was never observed", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "t", toolCallId: "c1" }] },
      { requestedTools: [], executedTools: [], completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-requested")?.passed).toBe(false);
  });

  it("fails tool-requested with a fixed reason that never echoes a sentinel-valued tool name or toolCallId", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "SENTINEL_tool", toolCallId: "SENTINEL-call-id" }] },
      { requestedTools: [], executedTools: [], completedToolCallIds: [], completedTools: [] },
    );
    const failure = check(result, "tool-requested");
    expect(failure?.reason).toBe("The expected tool request was not observed.");
    expect(failure?.reason).not.toContain("SENTINEL");
  });

  it("passes tool-requested when the expected entry is observed", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "t", toolCallId: "c1" }] },
      {
        requestedTools: [{ toolName: "t", toolCallId: "c1" }],
        executedTools: [],
        completedToolCallIds: [],
        completedTools: [],
      },
    );
    expect(check(result, "tool-requested")?.passed).toBe(true);
  });

  it("fails tool-executed when the recorder never captured the expected execution attempt", () => {
    const result = evaluateTool(
      { expectedExecuted: [{ toolName: "t", input: { a: 1 } }] },
      { requestedTools: [], executedTools: [], completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(false);
  });

  it("passes tool-executed when the recorder captured the exact input", () => {
    const executedTools: readonly RecordedToolExecution[] = [{ toolName: "t", input: { a: 1 } }];
    const result = evaluateTool(
      { expectedExecuted: [{ toolName: "t", input: { a: 1 } }] },
      { requestedTools: [], executedTools, completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(true);
  });

  it("fails tool-completed when an execution was attempted but no TOOL_COMPLETED id was observed (mirrors case 13)", () => {
    const executedTools: readonly RecordedToolExecution[] = [{ toolName: "always_fails", input: {} }];
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "always_fails", toolCallId: "c1" }] },
      { requestedTools: [], executedTools, completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-completed")?.passed).toBe(false);
  });

  it("fails tool-completed with a fixed reason that never echoes a sentinel-valued toolCallId", () => {
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "SENTINEL_tool", toolCallId: "SENTINEL-call-id" }] },
      { requestedTools: [], executedTools: [], completedToolCallIds: [], completedTools: [] },
    );
    const failure = check(result, "tool-completed");
    expect(failure?.reason).toBe("The expected tool execution did not complete.");
    expect(failure?.reason).not.toContain("SENTINEL");
  });

  it("passes tool-completed when the TOOL_COMPLETED trace entry matches", () => {
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "t", toolCallId: "c1" }] },
      {
        requestedTools: [],
        executedTools: [],
        completedToolCallIds: ["c1"],
        completedTools: [{ toolName: "t", toolCallId: "c1" }],
      },
    );
    expect(check(result, "tool-completed")?.passed).toBe(true);
  });

  it("passes tool-forbidden-executed when the forbidden tool name never executed", () => {
    const result = evaluateTool(
      { forbiddenExecutedToolNames: ["t"] },
      { requestedTools: [], executedTools: [], completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-forbidden-executed")?.passed).toBe(true);
  });

  it("fails tool-forbidden-executed when the forbidden tool name did execute", () => {
    const executedTools: readonly RecordedToolExecution[] = [{ toolName: "t", input: {} }];
    const result = evaluateTool(
      { forbiddenExecutedToolNames: ["t"] },
      { requestedTools: [], executedTools, completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-forbidden-executed")?.passed).toBe(false);
  });

  it("case 13's exact shape passes forbiddenCompletedToolCallIds (executed, never completed)", () => {
    const executedTools: readonly RecordedToolExecution[] = [{ toolName: "always_fails", input: {} }];
    const result = evaluateTool(
      {
        expectedExecuted: [{ toolName: "always_fails", input: {} }],
        forbiddenCompletedToolCallIds: ["c1"],
      },
      { requestedTools: [], executedTools, completedToolCallIds: [], completedTools: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(true);
    expect(check(result, "tool-forbidden-completed")?.passed).toBe(true);
  });

  it("fails tool-forbidden-completed when the forbidden toolCallId did complete", () => {
    const result = evaluateTool(
      { forbiddenCompletedToolCallIds: ["c1"] },
      {
        requestedTools: [],
        executedTools: [],
        completedToolCallIds: ["c1"],
        completedTools: [{ toolName: "t", toolCallId: "c1" }],
      },
    );
    expect(check(result, "tool-forbidden-completed")?.passed).toBe(false);
  });
});

describe("evaluateReport — stage expectations", () => {
  it("passes schema-handling for schemaExpectation VALID on a completed run", () => {
    const result = evaluateReport({ schemaExpectation: "VALID" }, completed());
    expect(check(result, "schema-handling")?.passed).toBe(true);
  });

  it("passes schema-handling for schemaExpectation VALID when the run failed with REPORT_EVIDENCE_INVALID", () => {
    const result = evaluateReport({ schemaExpectation: "VALID" }, failed("REPORT_EVIDENCE_INVALID"));
    expect(check(result, "schema-handling")?.passed).toBe(true);
  });

  it("fails schema-handling for schemaExpectation VALID when the run failed with an unrelated code", () => {
    const result = evaluateReport({ schemaExpectation: "VALID" }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "schema-handling")?.passed).toBe(false);
  });

  it("passes schema-handling for schemaExpectation INVALID when the run failed with REPORT_SCHEMA_INVALID", () => {
    const result = evaluateReport({ schemaExpectation: "INVALID" }, failed("REPORT_SCHEMA_INVALID"));
    expect(check(result, "schema-handling")?.passed).toBe(true);
  });

  it("fails schema-handling for schemaExpectation INVALID when the run actually completed", () => {
    const result = evaluateReport({ schemaExpectation: "INVALID" }, completed());
    expect(check(result, "schema-handling")?.passed).toBe(false);
  });

  it("passes evidence-grounding for groundingExpectation VALID on a completed run", () => {
    const result = evaluateReport({ groundingExpectation: "VALID" }, completed());
    expect(check(result, "evidence-grounding")?.passed).toBe(true);
  });

  it("fails evidence-grounding for groundingExpectation VALID when the run failed with an unrelated, non-grounding code", () => {
    const result = evaluateReport({ groundingExpectation: "VALID" }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "evidence-grounding")?.passed).toBe(false);
  });

  it("passes evidence-grounding for groundingExpectation INVALID when the run failed with REPORT_EVIDENCE_INVALID", () => {
    const result = evaluateReport({ groundingExpectation: "INVALID" }, failed("REPORT_EVIDENCE_INVALID"));
    expect(check(result, "evidence-grounding")?.passed).toBe(true);
  });

  it("fails evidence-grounding for groundingExpectation INVALID when the run failed with an unrelated code", () => {
    const result = evaluateReport({ groundingExpectation: "INVALID" }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "evidence-grounding")?.passed).toBe(false);
  });
});

describe("evaluateReport — payload expectations", () => {
  it("fails evidence-types with the payload missing-observation reason when the run did not complete", () => {
    const result = evaluateReport({ requiredEvidenceTypes: ["TOOL_EXECUTION"] }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "evidence-types")?.passed).toBe(false);
    expect(check(result, "evidence-types")?.reason).toMatch(/did not complete/);
  });

  it("passes evidence-types when the completed report contains the required type", () => {
    const result = evaluateReport({ requiredEvidenceTypes: ["TOOL_EXECUTION"] }, completed());
    expect(check(result, "evidence-types")?.passed).toBe(true);
  });

  it("fails evidence-types when the completed report is missing the required type", () => {
    const result = evaluateReport({ requiredEvidenceTypes: ["RAG_CHUNK"] }, completed());
    expect(check(result, "evidence-types")?.passed).toBe(false);
  });

  it("fails evidence-ids with the payload missing-observation reason when the run did not complete", () => {
    const result = evaluateReport({ requiredEvidenceIds: ["e1"] }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "evidence-ids")?.passed).toBe(false);
    expect(check(result, "evidence-ids")?.reason).toMatch(/did not complete/);
  });

  it("passes evidence-ids when required ids are present and forbidden ids are absent", () => {
    const result = evaluateReport({ requiredEvidenceIds: ["e1"], forbiddenEvidenceIds: ["e2"] }, completed());
    expect(check(result, "evidence-ids")?.passed).toBe(true);
  });

  it("fails evidence-ids when a required id is missing", () => {
    const result = evaluateReport({ requiredEvidenceIds: ["missing-id"] }, completed());
    expect(check(result, "evidence-ids")?.passed).toBe(false);
  });

  it("fails evidence-ids when a forbidden id is present", () => {
    const result = evaluateReport({ forbiddenEvidenceIds: ["e1"] }, completed());
    expect(check(result, "evidence-ids")?.passed).toBe(false);
  });

  it("fails evidence-ids with a fixed reason that never echoes a sentinel-valued evidence id", () => {
    const result = evaluateReport({ requiredEvidenceIds: ["SENTINEL-evidence-id"] }, completed());
    const failure = check(result, "evidence-ids");
    expect(failure?.passed).toBe(false);
    expect(failure?.reason).toBe(
      "The submitted report did not satisfy the required or forbidden evidence id expectations.",
    );
    expect(failure?.reason).not.toContain("SENTINEL");
  });

  it("fails action-types with the payload missing-observation reason when the run did not complete", () => {
    const result = evaluateReport({ requiredActionTypes: ["UPDATE_TICKET_STATUS"] }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "action-types")?.passed).toBe(false);
    expect(check(result, "action-types")?.reason).toMatch(/did not complete/);
  });

  it("passes action-types when the completed report contains the required action type", () => {
    const result = evaluateReport({ requiredActionTypes: ["UPDATE_TICKET_STATUS"] }, completed());
    expect(check(result, "action-types")?.passed).toBe(true);
  });

  it("fails action-types when the completed report is missing the required action type", () => {
    const result = evaluateReport({ requiredActionTypes: ["CREATE_ESCALATION"] }, completed());
    expect(check(result, "action-types")?.passed).toBe(false);
  });
});

describe("evaluateFailure", () => {
  it("returns no checks when no failure expectation is declared", () => {
    expect(evaluateFailure(undefined, completed())).toEqual([]);
  });

  it("fails failure-code with a fixed reason when the run actually completed", () => {
    const result = evaluateFailure({ expectedCode: "TOOL_NOT_FOUND" }, completed());
    expect(check(result, "failure-code")?.passed).toBe(false);
    expect(check(result, "failure-code")?.reason).toBe("The run completed, but a failure was expected.");
  });

  it("passes failure-code when the observed code matches", () => {
    const result = evaluateFailure({ expectedCode: "TOOL_NOT_FOUND" }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "failure-code")?.passed).toBe(true);
  });

  it("fails failure-code with a fixed reason when the observed code does not match", () => {
    const result = evaluateFailure({ expectedCode: "TOOL_NOT_FOUND" }, failed("TOOL_INPUT_INVALID"));
    expect(check(result, "failure-code")?.passed).toBe(false);
    expect(check(result, "failure-code")?.reason).toBe(
      "The observed failure code did not match the expected failure code.",
    );
  });
});

describe("evaluateStatus", () => {
  const expectations = (runStatus: EvaluationExpectations["runStatus"]): EvaluationExpectations => ({
    runStatus,
  });

  it("passes when the observed status matches", () => {
    const result = evaluateStatus(expectations("completed"), completed());
    expect(check(result, "status")?.passed).toBe(true);
  });

  it("fails with a fixed reason when the observed status does not match", () => {
    const result = evaluateStatus(expectations("completed"), failed("TOOL_NOT_FOUND"));
    expect(check(result, "status")?.passed).toBe(false);
    expect(check(result, "status")?.reason).toBe("The observed run status did not match the expected run status.");
  });
});

describe("evaluateCase", () => {
  function buildCase(overrides: Partial<EvaluationCase> = {}): EvaluationCase {
    return {
      id: "synthetic-case",
      description: "synthetic",
      ticketContext: { ticketId: "T-1", summary: "summary" },
      retrievalQuery: "query",
      corpusProfile: "default",
      toolProfile: "default",
      scenario: { id: "synthetic-case", turns: [] },
      expectations: { runStatus: "completed" },
      ...overrides,
    };
  }

  it("passes overall only when every produced check passes", () => {
    const evaluationCase = buildCase({
      expectations: { runStatus: "completed", report: { schemaExpectation: "VALID" } },
    });
    const result = evaluateCase(evaluationCase, completed(), []);
    expect(result.passed).toBe(true);
    expect(result.caseId).toBe("synthetic-case");
  });

  it("fails overall when any single check fails", () => {
    const evaluationCase = buildCase({
      expectations: { runStatus: "completed", report: { schemaExpectation: "INVALID" } },
    });
    const result = evaluateCase(evaluationCase, completed(), []);
    expect(result.passed).toBe(false);
  });

  it("derives observed.errorCode only on a failed result", () => {
    const evaluationCase = buildCase({
      expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } },
    });
    const result = evaluateCase(evaluationCase, failed("TOOL_NOT_FOUND"), []);
    expect(result.observed.errorCode).toBe("TOOL_NOT_FOUND");
    expect(result.observed.runStatus).toBe("failed");
  });

  it("omits observed.errorCode on a completed result", () => {
    const evaluationCase = buildCase();
    const result = evaluateCase(evaluationCase, completed(), []);
    expect(result.observed.errorCode).toBeUndefined();
  });
});
