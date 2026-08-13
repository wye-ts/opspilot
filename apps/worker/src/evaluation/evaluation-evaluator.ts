import type { CheckReasonCode } from "./check-reason-codes";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseInputV1 } from "./v1-types";
import type { EvaluationCaseResult, EvaluationCheckResult, EvaluationExpectations } from "./types";

// Every evaluate* function below operates ONLY on EvaluationExpectations and
// ObservedFacts (or a narrow slice of it) — never on a raw
// AgentOrchestratorResult, trace event, or ResolutionReport, and never on
// anything but the exact nested v1 shape ObservedFacts now is (see
// observed-facts.ts, HQ final contract-shape correction). Scoring cannot
// tell whether `observed` came from the agent runtime, JSON loaded from the
// parity fixture, or a future HTTP request — that is the whole point of
// freezing this boundary.
function passCheck(name: string, expected: unknown, observed: unknown): EvaluationCheckResult {
  return { name, passed: true, expected, observed };
}

function failCheck(
  name: string,
  expected: unknown,
  observed: unknown,
  reasonCode: CheckReasonCode,
): EvaluationCheckResult {
  return { name, passed: false, expected, observed, reasonCode };
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

type RetrievalObservation = ObservedFacts["retrieval"];

export function evaluateRetrieval(
  expectations: EvaluationExpectations["retrieval"],
  observed: RetrievalObservation,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const checks: EvaluationCheckResult[] = [];
  const { completed: retrievalCompleted, chunkIds: retrievedChunkIds } = observed;

  if (expectations.expectedTop1 !== undefined) {
    const expected = expectations.expectedTop1;
    if (!retrievalCompleted) {
      checks.push(failCheck("retrieval-top1", expected, null, "RETRIEVAL_NOT_OBSERVED"));
    } else if (retrievedChunkIds[0] === expected) {
      checks.push(passCheck("retrieval-top1", expected, retrievedChunkIds[0]));
    } else {
      checks.push(
        failCheck("retrieval-top1", expected, retrievedChunkIds[0] ?? null, "RETRIEVAL_TOP1_MISMATCH"),
      );
    }
  }

  if (expectations.expectedInTopK !== undefined) {
    const expected = expectations.expectedInTopK;
    if (!retrievalCompleted) {
      checks.push(failCheck("retrieval-hit3", expected, [], "RETRIEVAL_NOT_OBSERVED"));
    } else {
      const missing = expected.filter((id) => !retrievedChunkIds.includes(id));
      checks.push(
        missing.length === 0
          ? passCheck("retrieval-hit3", expected, retrievedChunkIds)
          : failCheck("retrieval-hit3", expected, retrievedChunkIds, "RETRIEVAL_HIT3_MISMATCH"),
      );
    }
  }

  if (expectations.expectedNoResults) {
    if (!retrievalCompleted) {
      checks.push(failCheck("retrieval-no-results", "no results", null, "RETRIEVAL_NOT_OBSERVED"));
    } else if (retrievedChunkIds.length === 0) {
      checks.push(passCheck("retrieval-no-results", "no results", []));
    } else {
      checks.push(
        failCheck("retrieval-no-results", "no results", retrievedChunkIds, "RETRIEVAL_NO_RESULTS_MISMATCH"),
      );
    }
  }

  if (expectations.forbiddenChunkIds !== undefined && expectations.forbiddenChunkIds.length > 0) {
    const forbidden = expectations.forbiddenChunkIds;
    if (!retrievalCompleted) {
      checks.push(failCheck("retrieval-forbidden", forbidden, [], "RETRIEVAL_NOT_OBSERVED"));
    } else {
      const present = forbidden.filter((id) => retrievedChunkIds.includes(id));
      checks.push(
        present.length === 0
          ? passCheck("retrieval-forbidden", forbidden, retrievedChunkIds)
          : failCheck("retrieval-forbidden", forbidden, retrievedChunkIds, "RETRIEVAL_FORBIDDEN_MISMATCH"),
      );
    }
  }

  return checks;
}

type ToolObservation = ObservedFacts["tools"];

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
        !observed.requested.some(
          (req) => req.toolName === entry.toolName && req.toolCallId === entry.toolCallId,
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-requested", expected, observed.requested)
        : failCheck("tool-requested", expected, observed.requested, "TOOL_REQUESTED_MISMATCH"),
    );
  }

  if (expectations.expectedExecuted !== undefined) {
    const expected = expectations.expectedExecuted;
    const missing = expected.filter(
      (entry) =>
        !observed.executed.some(
          (exec) => exec.toolName === entry.toolName && deepEqual(exec.input, entry.input),
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-executed", expected, observed.executed)
        : failCheck("tool-executed", expected, observed.executed, "TOOL_EXECUTED_MISMATCH"),
    );
  }

  if (expectations.expectedCompleted !== undefined) {
    const expected = expectations.expectedCompleted;
    const missing = expected.filter(
      (entry) =>
        !observed.completed.some(
          (completed) => completed.toolName === entry.toolName && completed.toolCallId === entry.toolCallId,
        ),
    );
    checks.push(
      missing.length === 0
        ? passCheck("tool-completed", expected, observed.completed)
        : failCheck("tool-completed", expected, observed.completed, "TOOL_COMPLETED_MISMATCH"),
    );
  }

  if (
    expectations.forbiddenExecutedToolNames !== undefined &&
    expectations.forbiddenExecutedToolNames.length > 0
  ) {
    const forbidden = expectations.forbiddenExecutedToolNames;
    const executedNames = observed.executed.map((exec) => exec.toolName);
    const present = forbidden.filter((name) => executedNames.includes(name));
    checks.push(
      present.length === 0
        ? passCheck("tool-forbidden-executed", forbidden, executedNames)
        : failCheck("tool-forbidden-executed", forbidden, executedNames, "TOOL_FORBIDDEN_EXECUTED_MISMATCH"),
    );
  }

  if (
    expectations.forbiddenCompletedToolCallIds !== undefined &&
    expectations.forbiddenCompletedToolCallIds.length > 0
  ) {
    const forbidden = expectations.forbiddenCompletedToolCallIds;
    // Derived at point of use — a completedToolCallIds list is not stored on
    // ObservedFacts because it is fully redundant with tools.completed.
    const completedToolCallIds = observed.completed.map((entry) => entry.toolCallId);
    const present = forbidden.filter((id) => completedToolCallIds.includes(id));
    checks.push(
      present.length === 0
        ? passCheck("tool-forbidden-completed", forbidden, completedToolCallIds)
        : failCheck(
            "tool-forbidden-completed",
            forbidden,
            completedToolCallIds,
            "TOOL_FORBIDDEN_COMPLETED_MISMATCH",
          ),
    );
  }

  return checks;
}

export function evaluateReport(
  expectations: EvaluationExpectations["report"],
  observed: ObservedFacts,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const checks: EvaluationCheckResult[] = [];
  const observedStatusAndCode =
    observed.report !== null ? "completed" : `failed:${observed.errorCode}`;

  if (expectations.schemaExpectation !== undefined) {
    const expected = expectations.schemaExpectation;
    const passed =
      expected === "INVALID"
        ? observed.runStatus === "failed" && observed.errorCode === "REPORT_SCHEMA_INVALID"
        : observed.runStatus === "completed" ||
          (observed.runStatus === "failed" && observed.errorCode === "REPORT_EVIDENCE_INVALID");
    checks.push(
      passed
        ? passCheck("schema-handling", expected, observedStatusAndCode)
        : failCheck("schema-handling", expected, observedStatusAndCode, "SCHEMA_HANDLING_MISMATCH"),
    );
  }

  if (expectations.groundingExpectation !== undefined) {
    const expected = expectations.groundingExpectation;
    const passed =
      expected === "INVALID"
        ? observed.runStatus === "failed" && observed.errorCode === "REPORT_EVIDENCE_INVALID"
        : observed.runStatus === "completed";
    checks.push(
      passed
        ? passCheck("evidence-grounding", expected, observedStatusAndCode)
        : failCheck("evidence-grounding", expected, observedStatusAndCode, "EVIDENCE_GROUNDING_MISMATCH"),
    );
  }

  if (expectations.requiredEvidenceTypes !== undefined) {
    const expected = expectations.requiredEvidenceTypes;
    if (observed.report === null) {
      checks.push(failCheck("evidence-types", expected, observedStatusAndCode, "PAYLOAD_NOT_AVAILABLE"));
    } else {
      const observedTypes = observed.report.evidence.map((entry) => entry.sourceType);
      const missing = expected.filter((type) => !observedTypes.includes(type));
      checks.push(
        missing.length === 0
          ? passCheck("evidence-types", expected, observedTypes)
          : failCheck("evidence-types", expected, observedTypes, "EVIDENCE_TYPES_MISMATCH"),
      );
    }
  }

  if (
    expectations.requiredEvidenceIds !== undefined ||
    expectations.forbiddenEvidenceIds !== undefined
  ) {
    const requiredIds = expectations.requiredEvidenceIds ?? [];
    const forbiddenIds = expectations.forbiddenEvidenceIds ?? [];
    if (observed.report === null) {
      checks.push(
        failCheck(
          "evidence-ids",
          { requiredIds, forbiddenIds },
          observedStatusAndCode,
          "PAYLOAD_NOT_AVAILABLE",
        ),
      );
    } else {
      const observedIds = observed.report.evidence.map((entry) => entry.evidenceId);
      const missing = requiredIds.filter((id) => !observedIds.includes(id));
      const forbiddenPresent = forbiddenIds.filter((id) => observedIds.includes(id));
      checks.push(
        missing.length === 0 && forbiddenPresent.length === 0
          ? passCheck("evidence-ids", { requiredIds, forbiddenIds }, observedIds)
          : failCheck(
              "evidence-ids",
              { requiredIds, forbiddenIds },
              observedIds,
              "EVIDENCE_IDS_MISMATCH",
            ),
      );
    }
  }

  if (expectations.requiredActionTypes !== undefined) {
    const expected = expectations.requiredActionTypes;
    if (observed.report === null) {
      checks.push(failCheck("action-types", expected, observedStatusAndCode, "PAYLOAD_NOT_AVAILABLE"));
    } else {
      const observedTypes = observed.report.suggestedActionTypes;
      const missing = expected.filter((type) => !observedTypes.includes(type));
      checks.push(
        missing.length === 0
          ? passCheck("action-types", expected, observedTypes)
          : failCheck("action-types", expected, observedTypes, "ACTION_TYPES_MISMATCH"),
      );
    }
  }

  return checks;
}

export function evaluateFailure(
  expectations: EvaluationExpectations["failure"],
  observed: ObservedFacts,
): EvaluationCheckResult[] {
  if (!expectations) return [];

  const expected = expectations.expectedCode;
  if (observed.runStatus !== "failed") {
    return [failCheck("failure-code", expected, "completed", "FAILURE_CODE_RUN_COMPLETED")];
  }

  return [
    observed.errorCode === expected
      ? passCheck("failure-code", expected, observed.errorCode)
      : failCheck("failure-code", expected, observed.errorCode, "FAILURE_CODE_MISMATCH"),
  ];
}

export function evaluateStatus(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult[] {
  const expected = expectations.runStatus;
  return [
    observed.runStatus === expected
      ? passCheck("status", expected, observed.runStatus)
      : failCheck("status", expected, observed.runStatus, "STATUS_MISMATCH"),
  ];
}

// The v1-native scorer entry point: operates only on the normalized
// EvaluationCaseInputV1 (expectations + ObservedFacts) — no raw
// AgentOrchestratorResult, executedTools recorder, or trace ever reaches
// this function or anything it calls.
export function evaluateCase(caseInput: EvaluationCaseInputV1): EvaluationCaseResult {
  const { caseId, expectations, observed } = caseInput;

  const checks: EvaluationCheckResult[] = [
    ...evaluateStatus(expectations, observed),
    ...evaluateRetrieval(expectations.retrieval, observed.retrieval),
    ...evaluateTool(expectations.tool, observed.tools),
    ...evaluateReport(expectations.report, observed),
    ...evaluateFailure(expectations.failure, observed),
  ];

  return {
    caseId,
    passed: checks.every((check) => check.passed),
    checks,
    observed,
  };
}
