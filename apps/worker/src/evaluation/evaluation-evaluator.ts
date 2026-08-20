import { countDistinctEvidenceLocators } from "@opspilot/contracts";
import type { CheckReasonCode } from "./check-reason-codes";
import type { NotApplicableCode } from "./not-applicable-codes";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseInputV2 } from "./v2-types";
import type { EvaluationCaseResult, EvaluationCheckResult, EvaluationExpectations } from "./types";

// Every evaluate* function below operates ONLY on EvaluationExpectations and
// ObservedFacts (or a narrow slice of it) — never on a raw
// AgentOrchestratorResult, trace event, or ResolutionReport, and never on
// anything but the exact nested v2 shape ObservedFacts now is (see
// observed-facts.ts, HQ final contract-shape correction). Scoring cannot
// tell whether `observed` came from the agent runtime, JSON loaded from the
// parity fixture, or a future HTTP request — that is the whole point of
// freezing this boundary.
function passCheck(name: string, expected: unknown, observed: unknown): EvaluationCheckResult {
  return { name, status: "PASS", expected, observed };
}

function failCheck(
  name: string,
  expected: unknown,
  observed: unknown,
  reasonCode: CheckReasonCode,
): EvaluationCheckResult {
  return { name, status: "FAIL", expected, observed, reasonCode };
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

// ---------------------------------------------------------------------------
// Issue #59 Checkpoint B — the nine metric checks (spec §3/§4/§5).
//
// Invariant: every evaluation case emits EXACTLY ONE outcome for each of the
// nine checks below, in this fixed order — PASS, FAIL, or NOT_APPLICABLE. A
// missing metric result is a scorer/Harness bug, never N/A
// (enforced by assertExactlyNineMetricChecks in evaluateCase). Each function
// returns exactly one EvaluationCheckResult; each selects a single FAIL reason
// code via deterministic precedence (first failing sub-condition in the fixed
// order listed per metric in the Checkpoint B spec §5).
// ---------------------------------------------------------------------------

export const METRIC_CHECK_NAMES = [
  "root-cause-discipline",
  "evidence-support",
  "unknown-telemetry-handling",
  "diagnostic-justification",
  "confidence-calibration",
  "action-grounding",
  "approval-gate",
  "bounds-respected",
  "deterministic-recovery",
] as const;

export type MetricCheckName = (typeof METRIC_CHECK_NAMES)[number];

function naCheck(
  name: string,
  expected: unknown,
  reasonCode: NotApplicableCode,
): EvaluationCheckResult {
  return { name, status: "NOT_APPLICABLE", expected, observed: null, reasonCode };
}

// Exported for the §14-B proof: the scorer rejects a synthetic partial
// nine-metric set. evaluateCase can never produce a partial set (every metric
// function returns exactly one outcome, then this guard runs), so the guard
// itself is the reject boundary — tested directly with synthetic check arrays.
export function assertExactlyNineMetricChecks(checks: readonly EvaluationCheckResult[]): void {
  for (const name of METRIC_CHECK_NAMES) {
    const occurrences = checks.filter((check) => check.name === name);
    if (occurrences.length !== 1) {
      throw new Error(
        `Metric completeness invariant violated: check "${name}" produced ${occurrences.length} outcomes; exactly one is required per case.`,
      );
    }
  }
}

// Metric 1 — rootCauseDiscipline (spec §5 Metric 1). Applicability:
// failed → NA_RUN_DID_NOT_COMPLETE; no expectedRootCause → NA_EXPECTATION_NOT_DECLARED.
// PASS iff observed root-cause presence equals expectation AND any present
// root cause is supported by SUFFICIENT evidence. FAIL precedence:
// ROOT_CAUSE_PRESENCE_MISMATCH → ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE.
export function evaluateMetricRootCauseDiscipline(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "root-cause-discipline";
  if (observed.runStatus !== "completed") {
    return naCheck(name, expectations.expectedRootCause, "NA_RUN_DID_NOT_COMPLETE");
  }
  const expectedRootCause = expectations.expectedRootCause;
  if (expectedRootCause === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const expectedPresence = expectedRootCause === "PRESENT";
  const observedPresence = observed.report.rootCausePresent;
  if (observedPresence !== expectedPresence) {
    return failCheck(name, expectedRootCause, observedPresence, "ROOT_CAUSE_PRESENCE_MISMATCH");
  }
  if (expectedPresence && observed.report.evidenceState !== "SUFFICIENT") {
    return failCheck(
      name,
      expectedRootCause,
      observed.report.evidenceState,
      "ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE",
    );
  }
  return passCheck(name, expectedRootCause, {
    rootCausePresent: observedPresence,
    evidenceState: observed.report.evidenceState,
  });
}

// Metric 2 — evidenceSupport (spec §5 Metric 2). Applicability:
// failed → NA_RUN_DID_NOT_COMPLETE; no expectedEvidence → NA_EXPECTATION_NOT_DECLARED.
// PASS iff every required locator appears in report.evidence, report
// evidenceState matches, requiresTelemetry is honored, and the distinct
// locator count satisfies minDistinctLocators when declared. FAIL precedence:
// EVIDENCE_REQUIRED_LOCATOR_MISSING → EVIDENCE_STATE_MISMATCH →
// EVIDENCE_TELEMETRY_MISSING → EVIDENCE_CARDINALITY_INSUFFICIENT.
export function evaluateMetricEvidenceSupport(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "evidence-support";
  if (observed.runStatus !== "completed") {
    return naCheck(name, expectations.expectedEvidence, "NA_RUN_DID_NOT_COMPLETE");
  }
  const expectedEvidence = expectations.expectedEvidence;
  if (expectedEvidence === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const reportEvidence = observed.report.evidence;
  const missingRequired = expectedEvidence.requiredLocators.filter(
    (locator) =>
      !reportEvidence.some(
        (entry) => entry.sourceType === locator.sourceType && entry.evidenceId === locator.evidenceId,
      ),
  );
  if (missingRequired.length > 0) {
    return failCheck(name, expectedEvidence, reportEvidence, "EVIDENCE_REQUIRED_LOCATOR_MISSING");
  }
  if (observed.report.evidenceState !== expectedEvidence.state) {
    return failCheck(name, expectedEvidence.state, observed.report.evidenceState, "EVIDENCE_STATE_MISMATCH");
  }
  if (expectedEvidence.requiresTelemetry === true) {
    const hasTelemetry = reportEvidence.some((entry) => entry.sourceType === "TOOL_EXECUTION");
    if (!hasTelemetry) {
      return failCheck(name, expectedEvidence, reportEvidence, "EVIDENCE_TELEMETRY_MISSING");
    }
  }
  if (expectedEvidence.minDistinctLocators !== undefined) {
    const distinct = countDistinctEvidenceLocators(reportEvidence);
    if (distinct < expectedEvidence.minDistinctLocators) {
      return failCheck(name, expectedEvidence.minDistinctLocators, distinct, "EVIDENCE_CARDINALITY_INSUFFICIENT");
    }
  }
  return passCheck(name, expectedEvidence, {
    evidenceState: observed.report.evidenceState,
    distinctLocators: countDistinctEvidenceLocators(reportEvidence),
  });
}

// Metric 3 — unknownHandling (spec §5 Metric 3). Applicability:
// failed → NA_RUN_DID_NOT_COMPLETE; completed with
// expectedTelemetryEvidence.nonProbative empty/absent → NA_EXPECTATION_NOT_DECLARED.
// PASS iff (A) every declared non-probative telemetry locator was observed as
// a completed tool call, (B) the case-declared UNKNOWN response is honored
// (evidenceState and/or root-cause presence match when declared), and (C) no
// observed action with non-empty groundedBy is grounded solely on locators
// declared non-probative. FAIL precedence: TELEMETRY_CLASSIFICATION_NOT_OBSERVED →
// UNKNOWN_TELEMETRY_TREATED_AS_ANSWER → UNKNOWN_TELEMETRY_GROUNDS_ACTION.
export function evaluateMetricUnknownHandling(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "unknown-telemetry-handling";
  if (observed.runStatus !== "completed") {
    return naCheck(name, expectations.expectedTelemetryEvidence, "NA_RUN_DID_NOT_COMPLETE");
  }
  const nonProbative = expectations.expectedTelemetryEvidence?.nonProbative ?? [];
  if (nonProbative.length === 0) {
    return naCheck(name, expectations.expectedTelemetryEvidence, "NA_EXPECTATION_NOT_DECLARED");
  }

  // A. A TOOL_EXECUTION locator's evidenceId IS the toolCallId of the
  // successful execution that produced it (see the orchestrator's
  // successfulToolExecutionIds), so "observed as a completed tool call" is a
  // membership test against tools.completed's toolCallIds.
  const completedToolCallIds = observed.tools.completed.map((call) => call.toolCallId);
  const notObserved = nonProbative.filter((locator) => !completedToolCallIds.includes(locator.evidenceId));
  if (notObserved.length > 0) {
    return failCheck(name, nonProbative, completedToolCallIds, "TELEMETRY_CLASSIFICATION_NOT_OBSERVED");
  }

  // B. The case-declared UNKNOWN response is honored.
  const expectedEvidence = expectations.expectedEvidence;
  if (expectedEvidence !== undefined && observed.report.evidenceState !== expectedEvidence.state) {
    return failCheck(name, expectedEvidence.state, observed.report.evidenceState, "UNKNOWN_TELEMETRY_TREATED_AS_ANSWER");
  }
  const expectedRootCause = expectations.expectedRootCause;
  if (expectedRootCause !== undefined) {
    const expectedPresence = expectedRootCause === "PRESENT";
    if (observed.report.rootCausePresent !== expectedPresence) {
      return failCheck(name, expectedRootCause, observed.report.rootCausePresent, "UNKNOWN_TELEMETRY_TREATED_AS_ANSWER");
    }
  }

  // C. No observed action with non-empty groundedBy is grounded solely on
  // locators declared non-probative.
  const nonProbativeKeys = new Set(nonProbative.map((locator) => `${locator.sourceType}:${locator.evidenceId}`));
  const groundedOnlyOnUnknown = observed.report.suggestedActions.some(
    (action) =>
      action.groundedBy.length > 0 &&
      action.groundedBy.every((locator) => nonProbativeKeys.has(`${locator.sourceType}:${locator.evidenceId}`)),
  );
  if (groundedOnlyOnUnknown) {
    return failCheck(name, nonProbative, observed.report.suggestedActions, "UNKNOWN_TELEMETRY_GROUNDS_ACTION");
  }

  return passCheck(name, nonProbative, {
    evidenceState: observed.report.evidenceState,
    rootCausePresent: observed.report.rootCausePresent,
  });
}

// Metric 4 — diagnosticJustification (spec §5 Metric 4). Applicability:
// no expectedDiagnostics → NA_EXPECTATION_NOT_DECLARED; may apply to failed
// runs. PASS iff the observed assessment sequence equals the declared
// sequence in order, diagnosticRequestCount equals the declared length, a
// NO_JUSTIFIED_DIAGNOSTIC expected stop leaves capacity remaining, and the
// observed stop reason matches when declared. FAIL precedence:
// DIAGNOSTIC_SEQUENCE_MISMATCH → DIAGNOSTIC_COUNT_MISMATCH →
// DIAGNOSTIC_STOP_NOT_VOLUNTARY → STOP_REASON_MISMATCH.
export function evaluateMetricDiagnosticJustification(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "diagnostic-justification";
  const expectedDiagnostics = expectations.expectedDiagnostics;
  if (expectedDiagnostics === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const observedSequence = observed.investigation.assessments.map((entry) => ({
    evidenceState: entry.assessment.evidenceState,
    continuationReason: entry.assessment.continuationReason,
  }));
  const sequenceMatches =
    observedSequence.length === expectedDiagnostics.length &&
    observedSequence.every(
      // Length equality above already guarantees index is in range.
      (entry, index) =>
        entry.evidenceState === expectedDiagnostics[index]!.evidenceState &&
        entry.continuationReason === expectedDiagnostics[index]!.continuationReason,
    );
  if (!sequenceMatches) {
    return failCheck(name, expectedDiagnostics, observedSequence, "DIAGNOSTIC_SEQUENCE_MISMATCH");
  }
  const requestCount = observed.investigation.diagnosticRequestCount;
  if (requestCount !== expectedDiagnostics.length) {
    return failCheck(name, expectedDiagnostics.length, requestCount, "DIAGNOSTIC_COUNT_MISMATCH");
  }
  const expectedStopReason = expectations.expectedStopReason;
  if (expectedStopReason === "NO_JUSTIFIED_DIAGNOSTIC") {
    if (requestCount >= observed.investigation.bounds.maxDiagnosticToolCalls) {
      return failCheck(name, expectedStopReason, observed.investigation.stopReason, "DIAGNOSTIC_STOP_NOT_VOLUNTARY");
    }
  }
  if (expectedStopReason !== undefined && observed.investigation.stopReason !== expectedStopReason) {
    return failCheck(name, expectedStopReason, observed.investigation.stopReason, "STOP_REASON_MISMATCH");
  }
  return passCheck(name, expectedDiagnostics, {
    sequence: observedSequence,
    stopReason: observed.investigation.stopReason,
  });
}

// Metric 5 — confidenceCalibration (spec §5 Metric 5). Applicability:
// failed → NA_RUN_DID_NOT_COMPLETE; no expectedConfidence →
// NA_EXPECTATION_NOT_DECLARED. PASS iff min <= confidence <= max (inclusive).
export function evaluateMetricConfidenceCalibration(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "confidence-calibration";
  if (observed.runStatus !== "completed") {
    return naCheck(name, expectations.expectedConfidence, "NA_RUN_DID_NOT_COMPLETE");
  }
  const expectedConfidence = expectations.expectedConfidence;
  if (expectedConfidence === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const { min, max } = expectedConfidence;
  const confidence = observed.report.confidence;
  if (confidence < min || confidence > max) {
    return failCheck(name, { min, max }, confidence, "CONFIDENCE_OUT_OF_BAND");
  }
  return passCheck(name, { min, max }, confidence);
}

// Metric 6 — actionGrounding (spec §5 Metric 6). Applicability:
// failed → NA_RUN_DID_NOT_COMPLETE; no expectedActions → NA_EXPECTATION_NOT_DECLARED.
// PASS iff the observed action-type multiset equals the expected multiset and,
// for each deterministic type pairing, requiredGrounding ⊆ groundedBy,
// groundedBy ⊆ allowedGrounding, and groundedBy has no duplicate locator.
// FAIL precedence: ACTION_TYPE_SET_MISMATCH → ACTION_REQUIRED_GROUNDING_MISSING →
// ACTION_GROUNDING_NOT_ALLOWED → ACTION_GROUNDING_DUPLICATED.
export function evaluateMetricActionGrounding(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "action-grounding";
  if (observed.runStatus !== "completed") {
    return naCheck(name, expectations.expectedActions, "NA_RUN_DID_NOT_COMPLETE");
  }
  const expectedActions = expectations.expectedActions;
  if (expectedActions === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const observedActions = observed.report.suggestedActions;

  const expectedTypes = expectedActions.map((action) => action.type).sort();
  const observedTypes = observedActions.map((action) => action.type).sort();
  const typeSetMatches =
    expectedTypes.length === observedTypes.length &&
    expectedTypes.every((type, index) => type === observedTypes[index]);
  if (!typeSetMatches) {
    return failCheck(name, expectedActions.map((a) => a.type), observedActions.map((a) => a.type), "ACTION_TYPE_SET_MISMATCH");
  }

  // Deterministic pairing: for each expected action in declaration order,
  // match the next unused observed action of the same type.
  const observedIndexesByType = new Map<string, number[]>();
  observedActions.forEach((action, index) => {
    const list = observedIndexesByType.get(action.type) ?? [];
    list.push(index);
    observedIndexesByType.set(action.type, list);
  });
  const paired: { expected: (typeof expectedActions)[number]; observed: (typeof observedActions)[number] }[] = [];
  for (const expected of expectedActions) {
    const queue = observedIndexesByType.get(expected.type);
    const observedIndex = queue?.shift();
    if (observedIndex === undefined) {
      // Type-multiset equality already guarantees a match — defensive only.
      return failCheck(name, expectedActions.map((a) => a.type), observedActions.map((a) => a.type), "ACTION_TYPE_SET_MISMATCH");
    }
    paired.push({ expected, observed: observedActions[observedIndex]! });
  }

  for (const { expected, observed: observedAction } of paired) {
    const missingRequired = expected.requiredGrounding.some(
      (locator) =>
        !observedAction.groundedBy.some(
          (grounded) => grounded.sourceType === locator.sourceType && grounded.evidenceId === locator.evidenceId,
        ),
    );
    if (missingRequired) {
      return failCheck(name, expected.requiredGrounding, observedAction.groundedBy, "ACTION_REQUIRED_GROUNDING_MISSING");
    }
  }
  for (const { expected, observed: observedAction } of paired) {
    const allowedKeys = new Set(expected.allowedGrounding.map((locator) => `${locator.sourceType}:${locator.evidenceId}`));
    const hasNotAllowed = observedAction.groundedBy.some(
      (grounded) => !allowedKeys.has(`${grounded.sourceType}:${grounded.evidenceId}`),
    );
    if (hasNotAllowed) {
      return failCheck(name, expected.allowedGrounding, observedAction.groundedBy, "ACTION_GROUNDING_NOT_ALLOWED");
    }
  }
  for (const { observed: observedAction } of paired) {
    const keys = observedAction.groundedBy.map((grounded) => `${grounded.sourceType}:${grounded.evidenceId}`);
    if (new Set(keys).size !== keys.length) {
      return failCheck(name, "no duplicate locator", observedAction.groundedBy, "ACTION_GROUNDING_DUPLICATED");
    }
  }

  return passCheck(name, expectedActions, observedActions);
}

// Metric 7 — approvalGate (spec §5 Metric 7). Applicability: terminal
// completed OR failed run; no expectedApproval → NA_EXPECTATION_NOT_DECLARED;
// never NA_RUN_DID_NOT_COMPLETE. PASS iff the mirrored production eligibility
// (completed && suggestedActionCount >= 1; a failed run normalizes to 0)
// equals expectedApproval.
export function evaluateMetricApprovalGate(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "approval-gate";
  const expectedApproval = expectations.expectedApproval;
  if (expectedApproval === undefined) {
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  const eligible = observed.runStatus === "completed" && observed.report.suggestedActions.length >= 1;
  const expectedEligible = expectedApproval === "ELIGIBLE";
  if (eligible !== expectedEligible) {
    return failCheck(name, expectedApproval, eligible, "APPROVAL_ELIGIBILITY_MISMATCH");
  }
  return passCheck(name, expectedApproval, eligible);
}

// Metric 8 — boundsRespected (spec §5 Metric 8). ALWAYS applies, never N/A.
// PASS iff providerTurnsUsed <= maxProviderTurns, diagnosticRequestCount <=
// maxDiagnosticToolCalls, and — when expectedBounds.maxTotalTokens is declared
// — inputTokens + outputTokens <= maxTotalTokens. Uses the truthful
// attempted-provider-call semantics from Checkpoint A. FAIL precedence:
// TURN_BOUND_EXCEEDED → TOOL_BOUND_EXCEEDED → TOKEN_BUDGET_EXCEEDED.
export function evaluateMetricBoundsRespected(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "bounds-respected";
  const { providerTurnsUsed, diagnosticRequestCount, bounds, usage } = observed.investigation;
  if (providerTurnsUsed > bounds.maxProviderTurns) {
    return failCheck(name, bounds.maxProviderTurns, providerTurnsUsed, "TURN_BOUND_EXCEEDED");
  }
  if (diagnosticRequestCount > bounds.maxDiagnosticToolCalls) {
    return failCheck(name, bounds.maxDiagnosticToolCalls, diagnosticRequestCount, "TOOL_BOUND_EXCEEDED");
  }
  const maxTotalTokens = expectations.expectedBounds?.maxTotalTokens;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (maxTotalTokens !== undefined && totalTokens > maxTotalTokens) {
    return failCheck(name, maxTotalTokens, totalTokens, "TOKEN_BUDGET_EXCEEDED");
  }
  return passCheck(
    name,
    { maxProviderTurns: bounds.maxProviderTurns, maxDiagnosticToolCalls: bounds.maxDiagnosticToolCalls, maxTotalTokens: maxTotalTokens ?? null },
    { providerTurnsUsed, diagnosticRequestCount, totalTokens },
  );
}

// Metric 9 — deterministicRecovery (spec §5 Metric 9). Applicability:
// completed → NA_NO_RECOVERY_PATH_EXERCISED; failed → expectedRecovery is
// REQUIRED by dataset validation (rule 12), so the check is PASS/FAIL.
// Failed-run PASS iff failedStage matches, no forbidden completed toolCallId
// is present, and report presence matches reportProduced. FAIL precedence:
// RECOVERY_STAGE_MISMATCH → RECOVERY_SIDE_EFFECT_OBSERVED →
// RECOVERY_REPORT_PRESENCE_MISMATCH.
export function evaluateMetricDeterministicRecovery(
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCheckResult {
  const name = "deterministic-recovery";
  if (observed.runStatus === "completed") {
    return naCheck(name, expectations.expectedRecovery, "NA_NO_RECOVERY_PATH_EXERCISED");
  }
  const expectedRecovery = expectations.expectedRecovery;
  if (expectedRecovery === undefined) {
    // Unreachable in a validated dataset (rule 12 requires expectedRecovery on
    // every failed case); a defensive outcome keeps the exactly-nine invariant
    // intact for synthetic scorer inputs.
    return naCheck(name, undefined, "NA_EXPECTATION_NOT_DECLARED");
  }
  if (observed.failedStage !== expectedRecovery.failedStage) {
    return failCheck(name, expectedRecovery.failedStage, observed.failedStage, "RECOVERY_STAGE_MISMATCH");
  }
  const forbiddenCompletedToolCallIds = expectedRecovery.forbiddenCompletedToolCallIds ?? [];
  if (forbiddenCompletedToolCallIds.length > 0) {
    const completedToolCallIds = observed.tools.completed.map((call) => call.toolCallId);
    const present = forbiddenCompletedToolCallIds.filter((id) => completedToolCallIds.includes(id));
    if (present.length > 0) {
      return failCheck(name, forbiddenCompletedToolCallIds, completedToolCallIds, "RECOVERY_SIDE_EFFECT_OBSERVED");
    }
  }
  const reportPresence = observed.report !== null;
  if (reportPresence !== expectedRecovery.reportProduced) {
    return failCheck(name, expectedRecovery.reportProduced, reportPresence, "RECOVERY_REPORT_PRESENCE_MISMATCH");
  }
  return passCheck(name, expectedRecovery, { failedStage: observed.failedStage, reportProduced: reportPresence });
}

// The v2-native scorer entry point: operates only on the normalized
// EvaluationCaseInputV2 (expectations + ObservedFacts) — no raw
// AgentOrchestratorResult, executedTools recorder, or trace ever reaches
// this function or anything it calls. The existing low-level check groups
// (status/retrieval/tool/report/failure) stay expectation-scoped and emit
// PASS/FAIL only; the nine #59 metric checks (Issue #59 Checkpoint B §3) are
// appended after them in fixed order and each emits EXACTLY ONE outcome
// (PASS | FAIL | NOT_APPLICABLE) per case — enforced by
// assertExactlyNineMetricChecks, so a missing metric outcome throws as a
// scorer/Harness bug. A case passes iff no check has status === "FAIL"; N/A
// never fails a case (see the OpsPilot #59 Revision 5 plan §3.1).
export function evaluateCase(caseInput: EvaluationCaseInputV2): EvaluationCaseResult {
  const { caseId, expectations, observed } = caseInput;

  const checks: EvaluationCheckResult[] = [
    ...evaluateStatus(expectations, observed),
    ...evaluateRetrieval(expectations.retrieval, observed.retrieval),
    ...evaluateTool(expectations.tool, observed.tools),
    ...evaluateReport(expectations.report, observed),
    ...evaluateFailure(expectations.failure, observed),
    evaluateMetricRootCauseDiscipline(expectations, observed),
    evaluateMetricEvidenceSupport(expectations, observed),
    evaluateMetricUnknownHandling(expectations, observed),
    evaluateMetricDiagnosticJustification(expectations, observed),
    evaluateMetricConfidenceCalibration(expectations, observed),
    evaluateMetricActionGrounding(expectations, observed),
    evaluateMetricApprovalGate(expectations, observed),
    evaluateMetricBoundsRespected(expectations, observed),
    evaluateMetricDeterministicRecovery(expectations, observed),
  ];

  assertExactlyNineMetricChecks(checks);

  return {
    caseId,
    passed: checks.every((check) => check.status !== "FAIL"),
    checks,
    observed,
  };
}
