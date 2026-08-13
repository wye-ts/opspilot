import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { AgentOrchestratorErrorCode, ResolutionReport } from "@opspilot/contracts";
import { resolveCheckReasonMessage } from "./check-reason-codes";
import {
  evaluateCase,
  evaluateFailure,
  evaluateReport,
  evaluateRetrieval,
  evaluateStatus,
  evaluateTool,
} from "./evaluation-evaluator";
import { toJsonValue } from "./json-value";
import { buildObservedFacts, type ObservedFacts } from "./observed-facts";
import type { RecordedToolExecution } from "./recording-tool-registry";
import type { EvaluationCase, EvaluationExpectations } from "./types";
import { buildEvaluationCaseInputV1, type EvaluationCaseInputV1 } from "./v1-types";

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

// Raw AgentOrchestratorResult builders — only used here to drive
// buildObservedFacts (via completed()/failed()/caseInputFrom() below),
// never passed directly to any evaluate* function. evaluate* only ever
// receives the normalized ObservedFacts those raw results produce (see the
// OpsPilot #61 Phase 1 HQ targeted corrections, correction 1).
function rawCompleted(report: ResolutionReport = VALID_REPORT): AgentOrchestratorResult {
  return { status: "completed", report, trace: [] };
}

function rawFailed(code: AgentOrchestratorErrorCode): AgentOrchestratorResult {
  // The evaluator does not read failedStage; AGENT_ANALYSIS is a truthful
  // default for the codes these fixtures use.
  return { status: "failed", code, message: "fixed message", trace: [], failedStage: "AGENT_ANALYSIS" };
}

function completed(report?: ResolutionReport): ObservedFacts {
  return buildObservedFacts(rawCompleted(report), []);
}

function failed(code: AgentOrchestratorErrorCode): ObservedFacts {
  return buildObservedFacts(rawFailed(code), []);
}

function caseInputFrom(
  evaluationCase: EvaluationCase,
  agentResult: AgentOrchestratorResult,
  executedTools: readonly RecordedToolExecution[] = [],
): EvaluationCaseInputV1 {
  return buildEvaluationCaseInputV1(
    evaluationCase.id,
    evaluationCase.expectations,
    buildObservedFacts(agentResult, executedTools),
  );
}

function check(result: ReturnType<typeof evaluateRetrieval>, name: string) {
  return result.find((c) => c.name === name);
}

function reasonMessage(result: ReturnType<typeof evaluateRetrieval>, name: string): string | undefined {
  const reasonCode = check(result, name)?.reasonCode;
  return reasonCode ? resolveCheckReasonMessage(reasonCode) : undefined;
}

describe("evaluateRetrieval", () => {
  it("returns no checks when no retrieval expectations are declared", () => {
    expect(evaluateRetrieval(undefined, { completed: false, chunkIds: [] })).toEqual([]);
  });

  it("fails retrieval-top1 with a missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { completed: false, chunkIds: [] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(false);
    expect(check(result, "retrieval-top1")?.reasonCode).toBe("RETRIEVAL_NOT_OBSERVED");
    expect(reasonMessage(result, "retrieval-top1")).toBe("No retrieval result was observed for this case.");
  });

  it("fails retrieval-top1 with a fixed reason (no raw chunk ids) when the top-ranked chunk mismatches, even with sentinel-valued expectations", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "SENTINEL-expected-chunk" },
      { completed: true, chunkIds: ["SENTINEL-observed-chunk"] },
    );
    const failure = check(result, "retrieval-top1");
    expect(failure?.passed).toBe(false);
    expect(failure?.reasonCode).toBe("RETRIEVAL_TOP1_MISMATCH");
    expect(reasonMessage(result, "retrieval-top1")).toBe("The expected top-ranked chunk was not observed.");
    expect(reasonMessage(result, "retrieval-top1")).not.toContain("SENTINEL");
  });

  it("passes retrieval-top1 when the top-ranked chunk matches", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { completed: true, chunkIds: ["a", "b"] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(true);
  });

  it("fails retrieval-top1 when the top-ranked chunk does not match", () => {
    const result = evaluateRetrieval(
      { expectedTop1: "a" },
      { completed: true, chunkIds: ["b", "a"] },
    );
    expect(check(result, "retrieval-top1")?.passed).toBe(false);
  });

  it("fails retrieval-hit3 with a missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { completed: false, chunkIds: [] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(false);
  });

  it("passes retrieval-hit3 when every expected id appears within the observed top-K", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { completed: true, chunkIds: ["a", "b", "c"] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(true);
  });

  it("fails retrieval-hit3 when an expected id is missing from the observed top-K", () => {
    const result = evaluateRetrieval(
      { expectedInTopK: ["a", "b"] },
      { completed: true, chunkIds: ["a"] },
    );
    expect(check(result, "retrieval-hit3")?.passed).toBe(false);
  });

  it("fails retrieval-no-results with a distinct missing-observation reason when RETRIEVAL_COMPLETED was never observed", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { completed: false, chunkIds: [] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(false);
    expect(reasonMessage(result, "retrieval-no-results")).toBe(
      "No retrieval result was observed for this case.",
    );
  });

  it("passes retrieval-no-results when RETRIEVAL_COMPLETED was observed with zero chunks", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { completed: true, chunkIds: [] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(true);
  });

  it("fails retrieval-no-results when chunks were actually retrieved", () => {
    const result = evaluateRetrieval(
      { expectedNoResults: true },
      { completed: true, chunkIds: ["a"] },
    );
    expect(check(result, "retrieval-no-results")?.passed).toBe(false);
  });

  it("passes retrieval-forbidden when no forbidden chunk id was retrieved", () => {
    const result = evaluateRetrieval(
      { forbiddenChunkIds: ["x"] },
      { completed: true, chunkIds: ["y"] },
    );
    expect(check(result, "retrieval-forbidden")?.passed).toBe(true);
  });

  it("fails retrieval-forbidden when a forbidden chunk id was retrieved", () => {
    const result = evaluateRetrieval(
      { forbiddenChunkIds: ["x"] },
      { completed: true, chunkIds: ["x"] },
    );
    expect(check(result, "retrieval-forbidden")?.passed).toBe(false);
  });
});

describe("evaluateTool", () => {
  it("returns no checks when no tool expectations are declared", () => {
    expect(
      evaluateTool(undefined, {
        requested: [],
        executed: [],
        completed: [],
      }),
    ).toEqual([]);
  });

  it("fails tool-requested when the expected TOOL_REQUESTED entry was never observed", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "t", toolCallId: "c1" }] },
      { requested: [], executed: [], completed: [] },
    );
    expect(check(result, "tool-requested")?.passed).toBe(false);
  });

  it("fails tool-requested with a fixed reason that never echoes a sentinel-valued tool name or toolCallId", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "SENTINEL_tool", toolCallId: "SENTINEL-call-id" }] },
      { requested: [], executed: [], completed: [] },
    );
    const failure = check(result, "tool-requested");
    expect(failure?.reasonCode).toBe("TOOL_REQUESTED_MISMATCH");
    expect(reasonMessage(result, "tool-requested")).toBe("The expected tool request was not observed.");
    expect(reasonMessage(result, "tool-requested")).not.toContain("SENTINEL");
  });

  it("passes tool-requested when the expected entry is observed", () => {
    const result = evaluateTool(
      { expectedRequested: [{ toolName: "t", toolCallId: "c1" }] },
      {
        requested: [{ toolName: "t", toolCallId: "c1" }],
        executed: [],
        completed: [],
      },
    );
    expect(check(result, "tool-requested")?.passed).toBe(true);
  });

  it("fails tool-executed when the recorder never captured the expected execution attempt", () => {
    const result = evaluateTool(
      { expectedExecuted: [{ toolName: "t", input: { a: 1 } }] },
      { requested: [], executed: [], completed: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(false);
  });

  it("passes tool-executed when the recorder captured the exact input", () => {
    const executedTools = [{ toolName: "t", input: { a: 1 } }];
    const result = evaluateTool(
      { expectedExecuted: [{ toolName: "t", input: { a: 1 } }] },
      { requested: [], executed: executedTools, completed: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(true);
  });

  it("passes tool-executed when a normalized observed input containing an own __proto__ key matches the same expected input", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"enabled":true},"service":"api"}');
    const normalizedInput = toJsonValue(parsed);
    const executedTools = [{ toolName: "t", input: normalizedInput }];
    const result = evaluateTool(
      { expectedExecuted: [{ toolName: "t", input: normalizedInput }] },
      { requested: [], executed: executedTools, completed: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(true);
  });

  it("fails tool-completed when an execution was attempted but no TOOL_COMPLETED id was observed (mirrors case 13)", () => {
    const executedTools = [{ toolName: "always_fails", input: {} }];
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "always_fails", toolCallId: "c1" }] },
      { requested: [], executed: executedTools, completed: [] },
    );
    expect(check(result, "tool-completed")?.passed).toBe(false);
  });

  it("fails tool-completed with a fixed reason that never echoes a sentinel-valued toolCallId", () => {
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "SENTINEL_tool", toolCallId: "SENTINEL-call-id" }] },
      { requested: [], executed: [], completed: [] },
    );
    const failure = check(result, "tool-completed");
    expect(failure?.reasonCode).toBe("TOOL_COMPLETED_MISMATCH");
    expect(reasonMessage(result, "tool-completed")).toBe("The expected tool execution did not complete.");
    expect(reasonMessage(result, "tool-completed")).not.toContain("SENTINEL");
  });

  it("passes tool-completed when the TOOL_COMPLETED trace entry matches", () => {
    const result = evaluateTool(
      { expectedCompleted: [{ toolName: "t", toolCallId: "c1" }] },
      {
        requested: [],
        executed: [],
        completed: [{ toolName: "t", toolCallId: "c1" }],
      },
    );
    expect(check(result, "tool-completed")?.passed).toBe(true);
  });

  it("passes tool-forbidden-executed when the forbidden tool name never executed", () => {
    const result = evaluateTool(
      { forbiddenExecutedToolNames: ["t"] },
      { requested: [], executed: [], completed: [] },
    );
    expect(check(result, "tool-forbidden-executed")?.passed).toBe(true);
  });

  it("fails tool-forbidden-executed when the forbidden tool name did execute", () => {
    const executedTools = [{ toolName: "t", input: {} }];
    const result = evaluateTool(
      { forbiddenExecutedToolNames: ["t"] },
      { requested: [], executed: executedTools, completed: [] },
    );
    expect(check(result, "tool-forbidden-executed")?.passed).toBe(false);
  });

  it("case 13's exact shape passes forbiddenCompletedToolCallIds (executed, never completed)", () => {
    const executedTools = [{ toolName: "always_fails", input: {} }];
    const result = evaluateTool(
      {
        expectedExecuted: [{ toolName: "always_fails", input: {} }],
        forbiddenCompletedToolCallIds: ["c1"],
      },
      { requested: [], executed: executedTools, completed: [] },
    );
    expect(check(result, "tool-executed")?.passed).toBe(true);
    expect(check(result, "tool-forbidden-completed")?.passed).toBe(true);
  });

  it("fails tool-forbidden-completed when the forbidden toolCallId did complete", () => {
    const result = evaluateTool(
      { forbiddenCompletedToolCallIds: ["c1"] },
      {
        requested: [],
        executed: [],
        completed: [{ toolName: "t", toolCallId: "c1" }],
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
    expect(reasonMessage(result, "evidence-types")).toMatch(/did not complete/);
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
    expect(reasonMessage(result, "evidence-ids")).toMatch(/did not complete/);
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
    expect(failure?.reasonCode).toBe("EVIDENCE_IDS_MISMATCH");
    expect(reasonMessage(result, "evidence-ids")).toBe(
      "The submitted report did not satisfy the required or forbidden evidence id expectations.",
    );
    expect(reasonMessage(result, "evidence-ids")).not.toContain("SENTINEL");
  });

  it("fails action-types with the payload missing-observation reason when the run did not complete", () => {
    const result = evaluateReport({ requiredActionTypes: ["UPDATE_TICKET_STATUS"] }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "action-types")?.passed).toBe(false);
    expect(reasonMessage(result, "action-types")).toMatch(/did not complete/);
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
    expect(check(result, "failure-code")?.reasonCode).toBe("FAILURE_CODE_RUN_COMPLETED");
    expect(reasonMessage(result, "failure-code")).toBe("The run completed, but a failure was expected.");
  });

  it("passes failure-code when the observed code matches", () => {
    const result = evaluateFailure({ expectedCode: "TOOL_NOT_FOUND" }, failed("TOOL_NOT_FOUND"));
    expect(check(result, "failure-code")?.passed).toBe(true);
  });

  it("fails failure-code with a fixed reason when the observed code does not match", () => {
    const result = evaluateFailure({ expectedCode: "TOOL_NOT_FOUND" }, failed("TOOL_INPUT_INVALID"));
    expect(check(result, "failure-code")?.passed).toBe(false);
    expect(reasonMessage(result, "failure-code")).toBe(
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
    expect(reasonMessage(result, "status")).toBe("The observed run status did not match the expected run status.");
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
    const result = evaluateCase(caseInputFrom(evaluationCase, rawCompleted()));
    expect(result.passed).toBe(true);
    expect(result.caseId).toBe("synthetic-case");
  });

  it("fails overall when any single check fails", () => {
    const evaluationCase = buildCase({
      expectations: { runStatus: "completed", report: { schemaExpectation: "INVALID" } },
    });
    const result = evaluateCase(caseInputFrom(evaluationCase, rawCompleted()));
    expect(result.passed).toBe(false);
  });

  it("derives observed.errorCode only on a failed result", () => {
    const evaluationCase = buildCase({
      expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } },
    });
    const result = evaluateCase(caseInputFrom(evaluationCase, rawFailed("TOOL_NOT_FOUND")));
    expect(result.observed.errorCode).toBe("TOOL_NOT_FOUND");
    expect(result.observed.runStatus).toBe("failed");
  });

  it("sets observed.errorCode to null (never undefined) on a completed result", () => {
    const evaluationCase = buildCase();
    const result = evaluateCase(caseInputFrom(evaluationCase, rawCompleted()));
    expect(result.observed.errorCode).toBeNull();
    expect("errorCode" in result.observed).toBe(true);
  });

  it("operates only on caseInput.expectations/.observed — evaluateCase's own parameter list makes any other input structurally unreachable", () => {
    // Structural proof for correction 1: EvaluationCaseInputV1 has exactly
    // caseId/expectations/observed. There is no AgentOrchestratorResult,
    // trace, or tool-recorder parameter for a caller to (mis)use.
    const evaluationCase = buildCase();
    const caseInput = caseInputFrom(evaluationCase, rawCompleted());
    expect(Object.keys(caseInput).sort()).toEqual(["caseId", "expectations", "observed"]);
    expect(evaluateCase).toHaveLength(1);
  });
});

// Independent-review finding F ("verification gaps"): the ten-approved-traps
// mapping in parity-vectors.test.ts overstated coverage for these specific
// wire-level edge cases. These are unit-level tests against evaluateRetrieval/
// evaluateTool/evaluateReport directly — deliberately NOT new cases in the
// frozen 15-case dataset (Phase 1 requires "current 15-case semantics only";
// no new check may be added, no existing check may disappear, no
// denominator may change) — so they lock down behavior without touching the
// committed dataset or parity fixture.
describe("wire-level edge cases (independent-review finding F)", () => {
  describe("expectedNoResults truthiness: absent vs. explicit false vs. true", () => {
    it("emits no retrieval-no-results check when expectedNoResults is absent", () => {
      const result = evaluateRetrieval({}, { completed: true, chunkIds: ["a"] });
      expect(check(result, "retrieval-no-results")).toBeUndefined();
    });

    it("emits no retrieval-no-results check when expectedNoResults is explicitly false (a wire-level value the narrow `true`-only TS type never allows a case author to declare)", () => {
      const wireExpectations = JSON.parse('{"expectedNoResults": false}') as EvaluationExpectations["retrieval"];
      const result = evaluateRetrieval(wireExpectations, { completed: true, chunkIds: ["a"] });
      expect(check(result, "retrieval-no-results")).toBeUndefined();
    });

    it("emits and evaluates a retrieval-no-results check when expectedNoResults is true (already covered elsewhere; included here for the truthiness table)", () => {
      const result = evaluateRetrieval({ expectedNoResults: true }, { completed: true, chunkIds: [] });
      expect(check(result, "retrieval-no-results")?.passed).toBe(true);
    });
  });

  describe("present-but-empty forbidden lists behave identically to absent (no check emitted)", () => {
    it("retrieval.forbiddenChunkIds: [] emits no retrieval-forbidden check", () => {
      const result = evaluateRetrieval({ forbiddenChunkIds: [] }, { completed: true, chunkIds: ["a"] });
      expect(check(result, "retrieval-forbidden")).toBeUndefined();
    });

    it("tool.forbiddenExecutedToolNames: [] emits no tool-forbidden-executed check", () => {
      const result = evaluateTool(
        { forbiddenExecutedToolNames: [] },
        { requested: [], executed: [], completed: [] },
      );
      expect(check(result, "tool-forbidden-executed")).toBeUndefined();
    });

    it("tool.forbiddenCompletedToolCallIds: [] emits no tool-forbidden-completed check", () => {
      const result = evaluateTool(
        { forbiddenCompletedToolCallIds: [] },
        { requested: [], executed: [], completed: [] },
      );
      expect(check(result, "tool-forbidden-completed")).toBeUndefined();
    });
  });

  describe("present-but-empty required/expected lists vacuously pass (current, intentional behavior — locked down explicitly)", () => {
    it("retrieval.expectedInTopK: [] vacuously passes retrieval-hit3 once retrieval has completed", () => {
      const result = evaluateRetrieval({ expectedInTopK: [] }, { completed: true, chunkIds: [] });
      expect(check(result, "retrieval-hit3")?.passed).toBe(true);
    });

    it("tool.expectedRequested: [] vacuously passes tool-requested", () => {
      const result = evaluateTool({ expectedRequested: [] }, { requested: [], executed: [], completed: [] });
      expect(check(result, "tool-requested")?.passed).toBe(true);
    });

    it("tool.expectedExecuted: [] vacuously passes tool-executed", () => {
      const result = evaluateTool({ expectedExecuted: [] }, { requested: [], executed: [], completed: [] });
      expect(check(result, "tool-executed")?.passed).toBe(true);
    });

    it("tool.expectedCompleted: [] vacuously passes tool-completed", () => {
      const result = evaluateTool({ expectedCompleted: [] }, { requested: [], executed: [], completed: [] });
      expect(check(result, "tool-completed")?.passed).toBe(true);
    });

    it("report.requiredEvidenceTypes: [] vacuously passes evidence-types on a completed run", () => {
      const result = evaluateReport({ requiredEvidenceTypes: [] }, completed());
      expect(check(result, "evidence-types")?.passed).toBe(true);
    });

    it("report.requiredActionTypes: [] vacuously passes action-types on a completed run", () => {
      const result = evaluateReport({ requiredActionTypes: [] }, completed());
      expect(check(result, "action-types")?.passed).toBe(true);
    });
  });
});
