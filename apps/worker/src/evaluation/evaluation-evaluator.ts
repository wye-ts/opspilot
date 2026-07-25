import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { RecordedToolExecution } from "./recording-tool-registry";
import type {
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationCheckResult,
  EvaluationExpectations,
} from "./types";

// Every reason string below is a fixed, application-authored template. None
// ever interpolates a chunk id, tool name, toolCallId, evidence id, or error
// code from expectations/observations — those richer values are kept only in
// EvaluationCheckResult.expected/observed for programmatic inspection, never
// copied into printable text (see docs/07-evaluation-plan.md).
const RETRIEVAL_NOT_OBSERVED_REASON = "No retrieval result was observed for this case.";
const RETRIEVAL_TOP1_MISMATCH_REASON = "The expected top-ranked chunk was not observed.";
const RETRIEVAL_HIT3_MISMATCH_REASON = "One or more expected chunks were absent from the top three results.";
const RETRIEVAL_NO_RESULTS_MISMATCH_REASON = "Retrieval returned results when none were expected.";
const RETRIEVAL_FORBIDDEN_MISMATCH_REASON = "A forbidden chunk id was observed in the retrieval results.";

const TOOL_REQUESTED_MISMATCH_REASON = "The expected tool request was not observed.";
const TOOL_EXECUTED_MISMATCH_REASON = "The expected tool execution attempt was not observed.";
const TOOL_COMPLETED_MISMATCH_REASON = "The expected tool execution did not complete.";
const TOOL_FORBIDDEN_EXECUTED_MISMATCH_REASON = "A forbidden tool was executed in this run.";
const TOOL_FORBIDDEN_COMPLETED_MISMATCH_REASON = "A forbidden tool call was observed as completed.";

const SCHEMA_HANDLING_MISMATCH_REASON =
  "The report's schema-validation outcome did not match the expected outcome.";
const EVIDENCE_GROUNDING_MISMATCH_REASON =
  "The report's evidence-grounding outcome did not match the expected outcome.";

const PAYLOAD_NOT_AVAILABLE_REASON = "The run did not complete, so no report was available to check.";
const EVIDENCE_TYPES_MISMATCH_REASON = "The submitted report did not contain all required evidence types.";
const EVIDENCE_IDS_MISMATCH_REASON =
  "The submitted report did not satisfy the required or forbidden evidence id expectations.";
const ACTION_TYPES_MISMATCH_REASON =
  "The submitted report did not contain all required suggested-action types.";

const FAILURE_CODE_RUN_COMPLETED_REASON = "The run completed, but a failure was expected.";
const FAILURE_CODE_MISMATCH_REASON = "The observed failure code did not match the expected failure code.";

const STATUS_MISMATCH_REASON = "The observed run status did not match the expected run status.";

function passCheck(name: string, expected: unknown, observed: unknown): EvaluationCheckResult {
  return { name, passed: true, expected, observed };
}

function failCheck(
  name: string,
  expected: unknown,
  observed: unknown,
  reason: string,
): EvaluationCheckResult {
  return { name, passed: false, expected, observed, reason };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]),
    )
  );
}

interface RetrievalObservation {
  readonly retrievalCompletedObserved: boolean;
  readonly retrievedChunkIds: readonly string[];
}

export function evaluateRetrieval(
  expectations: EvaluationExpectations["retrieval"],
  observed: RetrievalObservation,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const checks: EvaluationCheckResult[] = [];
  const { retrievalCompletedObserved, retrievedChunkIds } = observed;

  if (expectations.expectedTop1 !== undefined) {
    const expected = expectations.expectedTop1;
    if (!retrievalCompletedObserved) {
      checks.push(failCheck("retrieval-top1", expected, null, RETRIEVAL_NOT_OBSERVED_REASON));
    } else if (retrievedChunkIds[0] === expected) {
      checks.push(passCheck("retrieval-top1", expected, retrievedChunkIds[0]));
    } else {
      checks.push(
        failCheck("retrieval-top1", expected, retrievedChunkIds[0] ?? null, RETRIEVAL_TOP1_MISMATCH_REASON),
      );
    }
  }

  if (expectations.expectedInTopK !== undefined) {
    const expected = expectations.expectedInTopK;
    if (!retrievalCompletedObserved) {
      checks.push(failCheck("retrieval-hit3", expected, [], RETRIEVAL_NOT_OBSERVED_REASON));
    } else {
      const missing = expected.filter((id) => !retrievedChunkIds.includes(id));
      checks.push(
        missing.length === 0
          ? passCheck("retrieval-hit3", expected, retrievedChunkIds)
          : failCheck("retrieval-hit3", expected, retrievedChunkIds, RETRIEVAL_HIT3_MISMATCH_REASON),
      );
    }
  }

  if (expectations.expectedNoResults) {
    if (!retrievalCompletedObserved) {
      checks.push(failCheck("retrieval-no-results", "no results", null, RETRIEVAL_NOT_OBSERVED_REASON));
    } else if (retrievedChunkIds.length === 0) {
      checks.push(passCheck("retrieval-no-results", "no results", []));
    } else {
      checks.push(
        failCheck("retrieval-no-results", "no results", retrievedChunkIds, RETRIEVAL_NO_RESULTS_MISMATCH_REASON),
      );
    }
  }

  if (expectations.forbiddenChunkIds !== undefined && expectations.forbiddenChunkIds.length > 0) {
    const forbidden = expectations.forbiddenChunkIds;
    if (!retrievalCompletedObserved) {
      checks.push(failCheck("retrieval-forbidden", forbidden, [], RETRIEVAL_NOT_OBSERVED_REASON));
    } else {
      const present = forbidden.filter((id) => retrievedChunkIds.includes(id));
      checks.push(
        present.length === 0
          ? passCheck("retrieval-forbidden", forbidden, retrievedChunkIds)
          : failCheck("retrieval-forbidden", forbidden, retrievedChunkIds, RETRIEVAL_FORBIDDEN_MISMATCH_REASON),
      );
    }
  }

  return checks;
}

interface ToolObservation {
  readonly requestedTools: readonly { readonly toolName: string; readonly toolCallId: string }[];
  readonly executedTools: readonly RecordedToolExecution[];
  readonly completedToolCallIds: readonly string[];
  readonly completedTools: readonly { readonly toolName: string; readonly toolCallId: string }[];
}

export function evaluateTool(
  expectations: EvaluationExpectations["tool"],
  observed: ToolObservation,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const checks: EvaluationCheckResult[] = [];

  if (expectations.expectedRequested !== undefined) {
    const expected = expectations.expectedRequested;
    const missing = expected.filter(
      (entry) =>
        !observed.requestedTools.some(
          (req) => req.toolName === entry.toolName && req.toolCallId === entry.toolCallId,
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-requested", expected, observed.requestedTools)
        : failCheck("tool-requested", expected, observed.requestedTools, TOOL_REQUESTED_MISMATCH_REASON),
    );
  }

  if (expectations.expectedExecuted !== undefined) {
    const expected = expectations.expectedExecuted;
    const missing = expected.filter(
      (entry) =>
        !observed.executedTools.some(
          (exec) => exec.toolName === entry.toolName && deepEqual(exec.input, entry.input),
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-executed", expected, observed.executedTools)
        : failCheck("tool-executed", expected, observed.executedTools, TOOL_EXECUTED_MISMATCH_REASON),
    );
  }

  if (expectations.expectedCompleted !== undefined) {
    const expected = expectations.expectedCompleted;
    const missing = expected.filter(
      (entry) =>
        !observed.completedTools.some(
          (completed) => completed.toolName === entry.toolName && completed.toolCallId === entry.toolCallId,
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-completed", expected, observed.completedTools)
        : failCheck("tool-completed", expected, observed.completedTools, TOOL_COMPLETED_MISMATCH_REASON),
    );
  }

  if (
    expectations.forbiddenExecutedToolNames !== undefined &&
    expectations.forbiddenExecutedToolNames.length > 0
  ) {
    const forbidden = expectations.forbiddenExecutedToolNames;
    const executedNames = observed.executedTools.map((exec) => exec.toolName);
    const present = forbidden.filter((name) => executedNames.includes(name));
    checks.push(
      present.length === 0
        ? passCheck("tool-forbidden-executed", forbidden, executedNames)
        : failCheck("tool-forbidden-executed", forbidden, executedNames, TOOL_FORBIDDEN_EXECUTED_MISMATCH_REASON),
    );
  }

  if (
    expectations.forbiddenCompletedToolCallIds !== undefined &&
    expectations.forbiddenCompletedToolCallIds.length > 0
  ) {
    const forbidden = expectations.forbiddenCompletedToolCallIds;
    const present = forbidden.filter((id) => observed.completedToolCallIds.includes(id));
    checks.push(
      present.length === 0
        ? passCheck("tool-forbidden-completed", forbidden, observed.completedToolCallIds)
        : failCheck(
            "tool-forbidden-completed",
            forbidden,
            observed.completedToolCallIds,
            TOOL_FORBIDDEN_COMPLETED_MISMATCH_REASON,
          ),
    );
  }

  return checks;
}

export function evaluateReport(
  expectations: EvaluationExpectations["report"],
  agentResult: AgentOrchestratorResult,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const checks: EvaluationCheckResult[] = [];
  const observedStatusAndCode =
    agentResult.status === "completed" ? "completed" : `failed:${agentResult.code}`;

  if (expectations.schemaExpectation !== undefined) {
    const expected = expectations.schemaExpectation;
    const passed =
      expected === "INVALID"
        ? agentResult.status === "failed" && agentResult.code === "REPORT_SCHEMA_INVALID"
        : agentResult.status === "completed" ||
          (agentResult.status === "failed" && agentResult.code === "REPORT_EVIDENCE_INVALID");
    checks.push(
      passed
        ? passCheck("schema-handling", expected, observedStatusAndCode)
        : failCheck("schema-handling", expected, observedStatusAndCode, SCHEMA_HANDLING_MISMATCH_REASON),
    );
  }

  if (expectations.groundingExpectation !== undefined) {
    const expected = expectations.groundingExpectation;
    const passed =
      expected === "INVALID"
        ? agentResult.status === "failed" && agentResult.code === "REPORT_EVIDENCE_INVALID"
        : agentResult.status === "completed";
    checks.push(
      passed
        ? passCheck("evidence-grounding", expected, observedStatusAndCode)
        : failCheck("evidence-grounding", expected, observedStatusAndCode, EVIDENCE_GROUNDING_MISMATCH_REASON),
    );
  }

  if (expectations.requiredEvidenceTypes !== undefined) {
    const expected = expectations.requiredEvidenceTypes;
    if (agentResult.status !== "completed") {
      checks.push(failCheck("evidence-types", expected, observedStatusAndCode, PAYLOAD_NOT_AVAILABLE_REASON));
    } else {
      const observedTypes = agentResult.report.evidence.map((entry) => entry.sourceType);
      const missing = expected.filter((type) => !observedTypes.includes(type));
      checks.push(
        missing.length === 0
          ? passCheck("evidence-types", expected, observedTypes)
          : failCheck("evidence-types", expected, observedTypes, EVIDENCE_TYPES_MISMATCH_REASON),
      );
    }
  }

  if (
    expectations.requiredEvidenceIds !== undefined ||
    expectations.forbiddenEvidenceIds !== undefined
  ) {
    const requiredIds = expectations.requiredEvidenceIds ?? [];
    const forbiddenIds = expectations.forbiddenEvidenceIds ?? [];
    if (agentResult.status !== "completed") {
      checks.push(
        failCheck(
          "evidence-ids",
          { requiredIds, forbiddenIds },
          observedStatusAndCode,
          PAYLOAD_NOT_AVAILABLE_REASON,
        ),
      );
    } else {
      const observedIds = agentResult.report.evidence.map((entry) => entry.evidenceId);
      const missing = requiredIds.filter((id) => !observedIds.includes(id));
      const forbiddenPresent = forbiddenIds.filter((id) => observedIds.includes(id));
      checks.push(
        missing.length === 0 && forbiddenPresent.length === 0
          ? passCheck("evidence-ids", { requiredIds, forbiddenIds }, observedIds)
          : failCheck(
              "evidence-ids",
              { requiredIds, forbiddenIds },
              observedIds,
              EVIDENCE_IDS_MISMATCH_REASON,
            ),
      );
    }
  }

  if (expectations.requiredActionTypes !== undefined) {
    const expected = expectations.requiredActionTypes;
    if (agentResult.status !== "completed") {
      checks.push(failCheck("action-types", expected, observedStatusAndCode, PAYLOAD_NOT_AVAILABLE_REASON));
    } else {
      const observedTypes = agentResult.report.suggestedActions.map((action) => action.type);
      const missing = expected.filter((type) => !observedTypes.includes(type));
      checks.push(
        missing.length === 0
          ? passCheck("action-types", expected, observedTypes)
          : failCheck("action-types", expected, observedTypes, ACTION_TYPES_MISMATCH_REASON),
      );
    }
  }

  return checks;
}

export function evaluateFailure(
  expectations: EvaluationExpectations["failure"],
  agentResult: AgentOrchestratorResult,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const expected = expectations.expectedCode;
  if (agentResult.status !== "failed") {
    return [failCheck("failure-code", expected, "completed", FAILURE_CODE_RUN_COMPLETED_REASON)];
  }

  return [
    agentResult.code === expected
      ? passCheck("failure-code", expected, agentResult.code)
      : failCheck("failure-code", expected, agentResult.code, FAILURE_CODE_MISMATCH_REASON),
  ];
}

export function evaluateStatus(
  expectations: EvaluationExpectations,
  agentResult: AgentOrchestratorResult,
): EvaluationCheckResult[] {
  const expected = expectations.runStatus;
  return [
    agentResult.status === expected
      ? passCheck("status", expected, agentResult.status)
      : failCheck("status", expected, agentResult.status, STATUS_MISMATCH_REASON),
  ];
}

export function evaluateCase(
  evaluationCase: EvaluationCase,
  agentResult: AgentOrchestratorResult,
  executedTools: readonly RecordedToolExecution[],
): EvaluationCaseResult {
  const retrievalEvent = agentResult.trace.find((event) => event.type === "RETRIEVAL_COMPLETED");
  const retrievalCompletedObserved = retrievalEvent !== undefined;
  const retrievedChunkIds =
    retrievalEvent?.type === "RETRIEVAL_COMPLETED" ? retrievalEvent.chunks.map((chunk) => chunk.chunkId) : [];

  const requestedTools = agentResult.trace
    .filter((event): event is Extract<typeof event, { type: "TOOL_REQUESTED" }> => event.type === "TOOL_REQUESTED")
    .map((event) => ({ toolName: event.toolName, toolCallId: event.toolCallId }));

  const completedTools = agentResult.trace
    .filter((event): event is Extract<typeof event, { type: "TOOL_COMPLETED" }> => event.type === "TOOL_COMPLETED")
    .map((event) => ({ toolName: event.toolName, toolCallId: event.toolCallId }));

  const completedToolCallIds = completedTools.map((entry) => entry.toolCallId);

  const evidenceIds = agentResult.status === "completed" ? agentResult.report.evidence.map((e) => e.evidenceId) : [];

  const checks: EvaluationCheckResult[] = [
    ...evaluateStatus(evaluationCase.expectations, agentResult),
    ...evaluateRetrieval(evaluationCase.expectations.retrieval, {
      retrievalCompletedObserved,
      retrievedChunkIds,
    }),
    ...evaluateTool(evaluationCase.expectations.tool, {
      requestedTools,
      executedTools,
      completedToolCallIds,
      completedTools,
    }),
    ...evaluateReport(evaluationCase.expectations.report, agentResult),
    ...evaluateFailure(evaluationCase.expectations.failure, agentResult),
  ];

  return {
    caseId: evaluationCase.id,
    passed: checks.every((check) => check.passed),
    checks,
    observed: {
      runStatus: agentResult.status,
      retrievalCompletedObserved,
      retrievedChunkIds,
      requestedTools,
      executedTools,
      completedToolCallIds,
      evidenceIds,
      ...(agentResult.status === "failed" ? { errorCode: agentResult.code } : {}),
    },
  };
}
