"""Deterministic scorer with semantic parity to the TypeScript v2 scorer.

Ports apps/worker/src/evaluation/evaluation-evaluator.ts function-for-
function: same check names, same check order per case (status, retrieval,
tool, report, failure), same pass/fail logic, same reason-code selection.
At Checkpoint A the active scorer emits PASS/FAIL only; NOT_APPLICABLE is
structurally supported by CheckOutcome but never emitted yet (OpsPilot #59
Checkpoint A §3). A case passes iff no check has status FAIL.

Unlike the TS scorer, there is no TS-internal EvaluationCheckResult carrying
expected/observed echoes: the wire contract (EvaluationCheckV2) never exposes
them (see the task spec, "Do not expose per-check internal expected/observed
echoes"), so the internal CheckOutcome shape below only ever carries what the
wire needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from opspilot_evaluation.schemas import (
    CheckStatus,
    EvaluationCaseInputV2,
    EvaluationExpectations,
    EvidenceEntry,
    ExpectedActionExpectations,
    JsonValue,
    ObservedFactsCompleted,
    ObservedFactsFailed,
    ReportExpectations,
    RetrievalExpectations,
    RetrievalFacts,
    SuggestedActionFacts,
    ToolExpectations,
    ToolFacts,
)
from opspilot_evaluation.scoring.not_applicable_codes import NotApplicableCode
from opspilot_evaluation.scoring.reason_codes import CheckReasonCode

ObservedFactsUnion = ObservedFactsCompleted | ObservedFactsFailed

# Issue #59 Checkpoint B — the nine metric check names in the fixed spec §3
# order. Mirrors evaluation-evaluator.ts's METRIC_CHECK_NAMES. Every case must
# emit EXACTLY ONE outcome per name (PASS | FAIL | NOT_APPLICABLE).
METRIC_CHECK_NAMES = [
    "root-cause-discipline",
    "evidence-support",
    "unknown-telemetry-handling",
    "diagnostic-justification",
    "confidence-calibration",
    "action-grounding",
    "approval-gate",
    "bounds-respected",
    "deterministic-recovery",
]


@dataclass(frozen=True)
class CheckOutcome:
    name: str
    status: CheckStatus
    reason_code: CheckReasonCode | NotApplicableCode | None = None

    def __post_init__(self) -> None:
        # Mirrors the EvaluationCheckV2 discriminated-union invariant in
        # v2-types.ts: a PASS check carries reasonCode null, a FAIL check
        # carries a CheckReasonCode, and a NOT_APPLICABLE check carries a
        # NotApplicableCode.
        if self.status is CheckStatus.PASS:
            if self.reason_code is not None:
                raise ValueError(f'Invariant violated: passing check "{self.name}" carries a reasonCode')
        elif self.status is CheckStatus.FAIL:
            if not isinstance(self.reason_code, CheckReasonCode):
                raise ValueError(f'Invariant violated: failing check "{self.name}" has no valid CheckReasonCode')
        elif self.status is CheckStatus.NOT_APPLICABLE:
            if not isinstance(self.reason_code, NotApplicableCode):
                raise ValueError(
                    f'Invariant violated: not-applicable check "{self.name}" has no valid NotApplicableCode'
                )


@dataclass(frozen=True)
class CaseScoreResult:
    case_id: str
    passed: bool
    checks: list[CheckOutcome] = field(default_factory=list)


def _pass(name: str) -> CheckOutcome:
    return CheckOutcome(name=name, status=CheckStatus.PASS)


def _fail(name: str, reason_code: CheckReasonCode) -> CheckOutcome:
    return CheckOutcome(name=name, status=CheckStatus.FAIL, reason_code=reason_code)


def _check(name: str, passed: bool, fail_reason: CheckReasonCode) -> CheckOutcome:
    return _pass(name) if passed else _fail(name, fail_reason)


def _na(name: str, reason_code: NotApplicableCode) -> CheckOutcome:
    return CheckOutcome(name=name, status=CheckStatus.NOT_APPLICABLE, reason_code=reason_code)


def _count_distinct_evidence_locators(locators: list[EvidenceEntry]) -> int:
    """Mirrors countDistinctEvidenceLocators from packages/contracts/src/evidence.ts:
    counts DISTINCT (sourceType, evidenceId) pairs, never raw length."""
    return len({f"{entry.sourceType}:{entry.evidenceId}" for entry in locators})


def _assert_exactly_nine_metric_checks(checks: list[CheckOutcome]) -> None:
    for name in METRIC_CHECK_NAMES:
        occurrences = [check for check in checks if check.name == name]
        if len(occurrences) != 1:
            raise RuntimeError(
                f'Metric completeness invariant violated: check "{name}" produced '
                f"{len(occurrences)} outcomes; exactly one is required per case."
            )


def evaluate_status(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> list[CheckOutcome]:
    expected = expectations.runStatus.value
    if observed.runStatus.value == expected:
        return [_pass("status")]
    return [_fail("status", CheckReasonCode.STATUS_MISMATCH)]


def evaluate_retrieval(
    expectations: RetrievalExpectations | None,
    observed: RetrievalFacts,
) -> list[CheckOutcome]:
    if expectations is None:
        return []

    checks: list[CheckOutcome] = []
    retrieval_completed = observed.completed
    retrieved_chunk_ids = observed.chunkIds

    if expectations.expectedTop1 is not None:
        expected = expectations.expectedTop1
        if not retrieval_completed:
            checks.append(_fail("retrieval-top1", CheckReasonCode.RETRIEVAL_NOT_OBSERVED))
        else:
            top1 = retrieved_chunk_ids[0] if retrieved_chunk_ids else None
            if top1 == expected:
                checks.append(_pass("retrieval-top1"))
            else:
                checks.append(_fail("retrieval-top1", CheckReasonCode.RETRIEVAL_TOP1_MISMATCH))

    if expectations.expectedInTopK is not None:
        expected_top_k = expectations.expectedInTopK
        if not retrieval_completed:
            checks.append(_fail("retrieval-hit3", CheckReasonCode.RETRIEVAL_NOT_OBSERVED))
        else:
            missing = [chunk_id for chunk_id in expected_top_k if chunk_id not in retrieved_chunk_ids]
            checks.append(_check("retrieval-hit3", not missing, CheckReasonCode.RETRIEVAL_HIT3_MISMATCH))

    if expectations.expectedNoResults:
        if not retrieval_completed:
            checks.append(_fail("retrieval-no-results", CheckReasonCode.RETRIEVAL_NOT_OBSERVED))
        elif len(retrieved_chunk_ids) == 0:
            checks.append(_pass("retrieval-no-results"))
        else:
            checks.append(_fail("retrieval-no-results", CheckReasonCode.RETRIEVAL_NO_RESULTS_MISMATCH))

    if expectations.forbiddenChunkIds:
        forbidden = expectations.forbiddenChunkIds
        if not retrieval_completed:
            checks.append(_fail("retrieval-forbidden", CheckReasonCode.RETRIEVAL_NOT_OBSERVED))
        else:
            present = [chunk_id for chunk_id in forbidden if chunk_id in retrieved_chunk_ids]
            checks.append(_check("retrieval-forbidden", not present, CheckReasonCode.RETRIEVAL_FORBIDDEN_MISMATCH))

    return checks


def json_values_equal(a: JsonValue, b: JsonValue) -> bool:
    """Mirrors evaluation-evaluator.ts's deepEqual: JS's `===` never treats a
    boolean and a number as equal, unlike Python's `True == 1`. `1` and `1.0`
    stay equal, since JS has only one Number type.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_values_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_values_equal(v, b[key]) for key, v in a.items())
    return type(a) is type(b) and a == b


def evaluate_tool(
    expectations: ToolExpectations | None,
    observed: ToolFacts,
) -> list[CheckOutcome]:
    if expectations is None:
        return []

    checks: list[CheckOutcome] = []

    if expectations.expectedRequested is not None:
        missing_requested = [
            entry
            for entry in expectations.expectedRequested
            if not any(
                req.toolName == entry.toolName and req.toolCallId == entry.toolCallId
                for req in observed.requested
            )
        ]
        checks.append(_check("tool-requested", not missing_requested, CheckReasonCode.TOOL_REQUESTED_MISMATCH))

    if expectations.expectedExecuted is not None:
        missing_executed = [
            entry
            for entry in expectations.expectedExecuted
            if not any(
                exec_.toolName == entry.toolName and json_values_equal(exec_.input, entry.input)
                for exec_ in observed.executed
            )
        ]
        checks.append(_check("tool-executed", not missing_executed, CheckReasonCode.TOOL_EXECUTED_MISMATCH))

    if expectations.expectedCompleted is not None:
        missing_completed = [
            entry
            for entry in expectations.expectedCompleted
            if not any(
                completed.toolName == entry.toolName and completed.toolCallId == entry.toolCallId
                for completed in observed.completed
            )
        ]
        checks.append(_check("tool-completed", not missing_completed, CheckReasonCode.TOOL_COMPLETED_MISMATCH))

    if expectations.forbiddenExecutedToolNames:
        forbidden = expectations.forbiddenExecutedToolNames
        executed_names = [exec_.toolName for exec_ in observed.executed]
        present = [name for name in forbidden if name in executed_names]
        checks.append(
            _check("tool-forbidden-executed", not present, CheckReasonCode.TOOL_FORBIDDEN_EXECUTED_MISMATCH)
        )

    if expectations.forbiddenCompletedToolCallIds:
        forbidden = expectations.forbiddenCompletedToolCallIds
        completed_ids = [completed.toolCallId for completed in observed.completed]
        present = [call_id for call_id in forbidden if call_id in completed_ids]
        checks.append(
            _check("tool-forbidden-completed", not present, CheckReasonCode.TOOL_FORBIDDEN_COMPLETED_MISMATCH)
        )

    return checks


def evaluate_report(
    expectations: ReportExpectations | None,
    observed: ObservedFactsUnion,
) -> list[CheckOutcome]:
    if expectations is None:
        return []

    checks: list[CheckOutcome] = []
    observed_status = observed.runStatus.value
    observed_error_code = observed.errorCode.value if observed.errorCode is not None else None
    report = observed.report

    if expectations.schemaExpectation is not None:
        if expectations.schemaExpectation == "INVALID":
            passed = observed_status == "failed" and observed_error_code == "REPORT_SCHEMA_INVALID"
        else:
            passed = observed_status == "completed" or (
                observed_status == "failed" and observed_error_code == "REPORT_EVIDENCE_INVALID"
            )
        checks.append(_check("schema-handling", passed, CheckReasonCode.SCHEMA_HANDLING_MISMATCH))

    if expectations.groundingExpectation is not None:
        if expectations.groundingExpectation == "INVALID":
            passed = observed_status == "failed" and observed_error_code == "REPORT_EVIDENCE_INVALID"
        else:
            passed = observed_status == "completed"
        checks.append(_check("evidence-grounding", passed, CheckReasonCode.EVIDENCE_GROUNDING_MISMATCH))

    if expectations.requiredEvidenceTypes is not None:
        if report is None:
            checks.append(_fail("evidence-types", CheckReasonCode.PAYLOAD_NOT_AVAILABLE))
        else:
            observed_evidence_types = [entry.sourceType for entry in report.evidence]
            missing_evidence_types = [
                t for t in expectations.requiredEvidenceTypes if t not in observed_evidence_types
            ]
            checks.append(
                _check("evidence-types", not missing_evidence_types, CheckReasonCode.EVIDENCE_TYPES_MISMATCH)
            )

    if expectations.requiredEvidenceIds is not None or expectations.forbiddenEvidenceIds is not None:
        required_ids = expectations.requiredEvidenceIds or []
        forbidden_ids = expectations.forbiddenEvidenceIds or []
        if report is None:
            checks.append(_fail("evidence-ids", CheckReasonCode.PAYLOAD_NOT_AVAILABLE))
        else:
            observed_ids = [entry.evidenceId for entry in report.evidence]
            missing_ids = [i for i in required_ids if i not in observed_ids]
            forbidden_present = [i for i in forbidden_ids if i in observed_ids]
            passed = not missing_ids and not forbidden_present
            checks.append(_check("evidence-ids", passed, CheckReasonCode.EVIDENCE_IDS_MISMATCH))

    if expectations.requiredActionTypes is not None:
        if report is None:
            checks.append(_fail("action-types", CheckReasonCode.PAYLOAD_NOT_AVAILABLE))
        else:
            observed_action_types = report.suggestedActionTypes
            missing_action_types = [
                t for t in expectations.requiredActionTypes if t not in observed_action_types
            ]
            checks.append(_check("action-types", not missing_action_types, CheckReasonCode.ACTION_TYPES_MISMATCH))

    return checks


def evaluate_failure(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> list[CheckOutcome]:
    failure = expectations.failure
    if failure is None:
        return []

    if observed.runStatus.value != "failed":
        return [_fail("failure-code", CheckReasonCode.FAILURE_CODE_RUN_COMPLETED)]

    expected = failure.expectedCode.value
    observed_code = observed.errorCode.value if observed.errorCode is not None else None
    if observed_code == expected:
        return [_pass("failure-code")]
    return [_fail("failure-code", CheckReasonCode.FAILURE_CODE_MISMATCH)]


# ---------------------------------------------------------------------------
# Issue #59 Checkpoint B — the nine metric checks (spec §3/§4/§5). Function-
# for-function mirror of evaluation-evaluator.ts's evaluateMetric* functions:
# same check names, same applicability, same FAIL reason-code precedence. Each
# returns EXACTLY ONE CheckOutcome (PASS | FAIL | NOT_APPLICABLE).
# ---------------------------------------------------------------------------


def evaluate_metric_root_cause_discipline(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "root-cause-discipline"
    if observed.runStatus.value != "completed":
        return _na(name, NotApplicableCode.NA_RUN_DID_NOT_COMPLETE)
    assert observed.report is not None  # completed ⇒ non-null report (schema-invariant)
    expected_root_cause = expectations.expectedRootCause
    if expected_root_cause is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    expected_presence = expected_root_cause == "PRESENT"
    observed_presence = observed.report.rootCausePresent
    if observed_presence != expected_presence:
        return _fail(name, CheckReasonCode.ROOT_CAUSE_PRESENCE_MISMATCH)
    if expected_presence and observed.report.evidenceState != "SUFFICIENT":
        return _fail(name, CheckReasonCode.ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE)
    return _pass(name)


def evaluate_metric_evidence_support(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "evidence-support"
    if observed.runStatus.value != "completed":
        return _na(name, NotApplicableCode.NA_RUN_DID_NOT_COMPLETE)
    assert observed.report is not None  # completed ⇒ non-null report (schema-invariant)
    expected_evidence = expectations.expectedEvidence
    if expected_evidence is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    report_evidence = observed.report.evidence
    missing_required = [
        locator
        for locator in expected_evidence.requiredLocators
        if not any(
            entry.sourceType == locator.sourceType and entry.evidenceId == locator.evidenceId
            for entry in report_evidence
        )
    ]
    if missing_required:
        return _fail(name, CheckReasonCode.EVIDENCE_REQUIRED_LOCATOR_MISSING)
    if observed.report.evidenceState != expected_evidence.state:
        return _fail(name, CheckReasonCode.EVIDENCE_STATE_MISMATCH)
    if expected_evidence.requiresTelemetry is True:
        has_telemetry = any(entry.sourceType == "TOOL_EXECUTION" for entry in report_evidence)
        if not has_telemetry:
            return _fail(name, CheckReasonCode.EVIDENCE_TELEMETRY_MISSING)
    if expected_evidence.minDistinctLocators is not None:
        distinct = _count_distinct_evidence_locators(report_evidence)
        if distinct < expected_evidence.minDistinctLocators:
            return _fail(name, CheckReasonCode.EVIDENCE_CARDINALITY_INSUFFICIENT)
    return _pass(name)


def evaluate_metric_unknown_handling(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "unknown-telemetry-handling"
    if observed.runStatus.value != "completed":
        return _na(name, NotApplicableCode.NA_RUN_DID_NOT_COMPLETE)
    assert observed.report is not None  # completed ⇒ non-null report (schema-invariant)
    non_probative = (
        expectations.expectedTelemetryEvidence.nonProbative
        if expectations.expectedTelemetryEvidence
        else []
    )
    if not non_probative:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)

    # A. Every declared non-probative telemetry locator was observed as a
    # completed tool call. A TOOL_EXECUTION locator's evidenceId IS the
    # toolCallId of the successful execution that produced it.
    completed_tool_call_ids = [call.toolCallId for call in observed.tools.completed]
    not_observed = [locator for locator in non_probative if locator.evidenceId not in completed_tool_call_ids]
    if not_observed:
        return _fail(name, CheckReasonCode.TELEMETRY_CLASSIFICATION_NOT_OBSERVED)

    # B. The case-declared UNKNOWN response is honored.
    expected_evidence = expectations.expectedEvidence
    if expected_evidence is not None and observed.report.evidenceState != expected_evidence.state:
        return _fail(name, CheckReasonCode.UNKNOWN_TELEMETRY_TREATED_AS_ANSWER)
    expected_root_cause = expectations.expectedRootCause
    if expected_root_cause is not None:
        expected_presence = expected_root_cause == "PRESENT"
        if observed.report.rootCausePresent != expected_presence:
            return _fail(name, CheckReasonCode.UNKNOWN_TELEMETRY_TREATED_AS_ANSWER)

    # C. No observed action with non-empty groundedBy is grounded solely on
    # locators declared non-probative.
    non_probative_keys = {f"{loc.sourceType}:{loc.evidenceId}" for loc in non_probative}
    grounded_only_on_unknown = any(
        action.groundedBy
        and all(f"{loc.sourceType}:{loc.evidenceId}" in non_probative_keys for loc in action.groundedBy)
        for action in observed.report.suggestedActions
    )
    if grounded_only_on_unknown:
        return _fail(name, CheckReasonCode.UNKNOWN_TELEMETRY_GROUNDS_ACTION)

    return _pass(name)


def evaluate_metric_diagnostic_justification(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "diagnostic-justification"
    expected_diagnostics = expectations.expectedDiagnostics
    if expected_diagnostics is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    observed_sequence = [
        (entry.assessment.evidenceState, entry.assessment.continuationReason)
        for entry in observed.investigation.assessments
    ]
    expected_sequence = [
        (entry.evidenceState, entry.continuationReason) for entry in expected_diagnostics
    ]
    if observed_sequence != expected_sequence:
        return _fail(name, CheckReasonCode.DIAGNOSTIC_SEQUENCE_MISMATCH)
    request_count = observed.investigation.diagnosticRequestCount
    if request_count != len(expected_diagnostics):
        return _fail(name, CheckReasonCode.DIAGNOSTIC_COUNT_MISMATCH)
    expected_stop_reason = expectations.expectedStopReason
    if expected_stop_reason == "NO_JUSTIFIED_DIAGNOSTIC":
        if request_count >= observed.investigation.bounds.maxDiagnosticToolCalls:
            return _fail(name, CheckReasonCode.DIAGNOSTIC_STOP_NOT_VOLUNTARY)
    if expected_stop_reason is not None and observed.investigation.stopReason != expected_stop_reason:
        return _fail(name, CheckReasonCode.STOP_REASON_MISMATCH)
    return _pass(name)


def evaluate_metric_confidence_calibration(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "confidence-calibration"
    if observed.runStatus.value != "completed":
        return _na(name, NotApplicableCode.NA_RUN_DID_NOT_COMPLETE)
    assert observed.report is not None  # completed ⇒ non-null report (schema-invariant)
    expected_confidence = expectations.expectedConfidence
    if expected_confidence is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    confidence = observed.report.confidence
    if confidence < expected_confidence.min or confidence > expected_confidence.max:
        return _fail(name, CheckReasonCode.CONFIDENCE_OUT_OF_BAND)
    return _pass(name)


def _match_actions_deterministically(
    expected_actions: list[ExpectedActionExpectations],
    observed_actions: list[SuggestedActionFacts],
) -> list[tuple[ExpectedActionExpectations, SuggestedActionFacts]] | None:
    """Deterministic type pairing, mirroring evaluation-evaluator.ts: for each
    expected action in declaration order, match the next unused observed action
    of the same type. Returns a list of (expected, observed) pairs, or None when
    the type multiset differs (defensive; the caller checks it first)."""
    observed_by_type: dict[str, list[int]] = {}
    for index, action in enumerate(observed_actions):
        observed_by_type.setdefault(action.type, []).append(index)
    paired: list[tuple[ExpectedActionExpectations, SuggestedActionFacts]] = []
    for expected in expected_actions:
        queue = observed_by_type.get(expected.type)
        if not queue:
            return None
        observed_index = queue.pop(0)
        paired.append((expected, observed_actions[observed_index]))
    return paired


def evaluate_metric_action_grounding(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "action-grounding"
    if observed.runStatus.value != "completed":
        return _na(name, NotApplicableCode.NA_RUN_DID_NOT_COMPLETE)
    assert observed.report is not None  # completed ⇒ non-null report (schema-invariant)
    expected_actions = expectations.expectedActions
    if expected_actions is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    observed_actions = observed.report.suggestedActions

    expected_types = sorted(action.type for action in expected_actions)
    observed_types = sorted(action.type for action in observed_actions)
    if expected_types != observed_types:
        return _fail(name, CheckReasonCode.ACTION_TYPE_SET_MISMATCH)

    paired = _match_actions_deterministically(expected_actions, observed_actions)
    if paired is None:
        return _fail(name, CheckReasonCode.ACTION_TYPE_SET_MISMATCH)

    for expected, observed_action in paired:
        missing_required = any(
            not any(
                grounded.sourceType == locator.sourceType and grounded.evidenceId == locator.evidenceId
                for grounded in observed_action.groundedBy
            )
            for locator in expected.requiredGrounding
        )
        if missing_required:
            return _fail(name, CheckReasonCode.ACTION_REQUIRED_GROUNDING_MISSING)

    for expected, observed_action in paired:
        allowed_keys = {f"{loc.sourceType}:{loc.evidenceId}" for loc in expected.allowedGrounding}
        has_not_allowed = any(
            f"{grounded.sourceType}:{grounded.evidenceId}" not in allowed_keys
            for grounded in observed_action.groundedBy
        )
        if has_not_allowed:
            return _fail(name, CheckReasonCode.ACTION_GROUNDING_NOT_ALLOWED)

    for _, observed_action in paired:
        keys = [f"{grounded.sourceType}:{grounded.evidenceId}" for grounded in observed_action.groundedBy]
        if len(set(keys)) != len(keys):
            return _fail(name, CheckReasonCode.ACTION_GROUNDING_DUPLICATED)

    return _pass(name)


def evaluate_metric_approval_gate(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "approval-gate"
    expected_approval = expectations.expectedApproval
    if expected_approval is None:
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    # Mirrors TS's `runStatus === "completed" && suggestedActions.length >= 1`.
    # The extra `report is not None` guard only fires on completed-with-null
    # report, which the schema rejects — it exists purely to satisfy the
    # union-typed `report` for the static checker.
    report = observed.report
    eligible = observed.runStatus.value == "completed" and report is not None and len(report.suggestedActions) >= 1
    expected_eligible = expected_approval == "ELIGIBLE"
    if eligible != expected_eligible:
        return _fail(name, CheckReasonCode.APPROVAL_ELIGIBILITY_MISMATCH)
    return _pass(name)


def evaluate_metric_bounds_respected(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "bounds-respected"
    investigation = observed.investigation
    provider_turns_used = investigation.providerTurnsUsed
    diagnostic_request_count = investigation.diagnosticRequestCount
    bounds = investigation.bounds
    usage = investigation.usage
    if provider_turns_used > bounds.maxProviderTurns:
        return _fail(name, CheckReasonCode.TURN_BOUND_EXCEEDED)
    if diagnostic_request_count > bounds.maxDiagnosticToolCalls:
        return _fail(name, CheckReasonCode.TOOL_BOUND_EXCEEDED)
    max_total_tokens = expectations.expectedBounds.maxTotalTokens if expectations.expectedBounds else None
    total_tokens = usage.inputTokens + usage.outputTokens
    if max_total_tokens is not None and total_tokens > max_total_tokens:
        return _fail(name, CheckReasonCode.TOKEN_BUDGET_EXCEEDED)
    return _pass(name)


def evaluate_metric_deterministic_recovery(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnion,
) -> CheckOutcome:
    name = "deterministic-recovery"
    if observed.runStatus.value == "completed":
        return _na(name, NotApplicableCode.NA_NO_RECOVERY_PATH_EXERCISED)
    expected_recovery = expectations.expectedRecovery
    if expected_recovery is None:
        # Unreachable in a validated dataset (validation rule 12 requires
        # expectedRecovery on every failed case); defensive outcome keeps the
        # exactly-nine invariant intact for synthetic scorer inputs.
        return _na(name, NotApplicableCode.NA_EXPECTATION_NOT_DECLARED)
    if observed.failedStage != expected_recovery.failedStage:
        return _fail(name, CheckReasonCode.RECOVERY_STAGE_MISMATCH)
    forbidden_completed_tool_call_ids = expected_recovery.forbiddenCompletedToolCallIds or []
    if forbidden_completed_tool_call_ids:
        completed_tool_call_ids = [call.toolCallId for call in observed.tools.completed]
        present = [call_id for call_id in forbidden_completed_tool_call_ids if call_id in completed_tool_call_ids]
        if present:
            return _fail(name, CheckReasonCode.RECOVERY_SIDE_EFFECT_OBSERVED)
    report_presence = observed.report is not None
    if report_presence != expected_recovery.reportProduced:
        return _fail(name, CheckReasonCode.RECOVERY_REPORT_PRESENCE_MISMATCH)
    return _pass(name)


def evaluate_case(case_input: EvaluationCaseInputV2) -> CaseScoreResult:
    expectations = case_input.expectations
    observed = case_input.observed

    checks: list[CheckOutcome] = [
        *evaluate_status(expectations, observed),
        *evaluate_retrieval(expectations.retrieval, observed.retrieval),
        *evaluate_tool(expectations.tool, observed.tools),
        *evaluate_report(expectations.report, observed),
        *evaluate_failure(expectations, observed),
        evaluate_metric_root_cause_discipline(expectations, observed),
        evaluate_metric_evidence_support(expectations, observed),
        evaluate_metric_unknown_handling(expectations, observed),
        evaluate_metric_diagnostic_justification(expectations, observed),
        evaluate_metric_confidence_calibration(expectations, observed),
        evaluate_metric_action_grounding(expectations, observed),
        evaluate_metric_approval_gate(expectations, observed),
        evaluate_metric_bounds_respected(expectations, observed),
        evaluate_metric_deterministic_recovery(expectations, observed),
    ]

    _assert_exactly_nine_metric_checks(checks)

    return CaseScoreResult(
        case_id=case_input.caseId,
        # A case passes iff no check has status FAIL (OpsPilot #59 Checkpoint A §3).
        passed=all(check.status != CheckStatus.FAIL for check in checks),
        checks=checks,
    )


def score_cases(cases: list[EvaluationCaseInputV2]) -> list[CaseScoreResult]:
    return [evaluate_case(case) for case in cases]
