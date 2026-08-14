"""Deterministic scorer with semantic parity to the TypeScript v1 scorer.

Ports apps/worker/src/evaluation/evaluation-evaluator.ts function-for-
function: same check names, same check order per case (status, retrieval,
tool, report, failure), same pass/fail logic, same reason-code selection.

Unlike the TS scorer, there is no TS-internal EvaluationCheckResult carrying
expected/observed echoes: the wire contract (EvaluationCheckV1) never exposes
them (see the task spec, "Do not expose per-check internal expected/observed
echoes"), so the internal CheckOutcome shape below only ever carries what the
wire needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from opspilot_evaluation.schemas import (
    EvaluationCaseInputV1,
    EvaluationExpectations,
    JsonValue,
    ObservedFactsCompleted,
    ObservedFactsFailed,
    ReportExpectations,
    RetrievalExpectations,
    RetrievalFacts,
    ToolExpectations,
    ToolFacts,
)
from opspilot_evaluation.scoring.reason_codes import CheckReasonCode

ObservedFactsUnion = ObservedFactsCompleted | ObservedFactsFailed


@dataclass(frozen=True)
class CheckOutcome:
    name: str
    passed: bool
    reason_code: CheckReasonCode | None = None

    def __post_init__(self) -> None:
        # Mirrors the EvaluationCheckV1 discriminated-union invariant in
        # v1-types.ts: reasonCode is present iff passed is False.
        if self.passed and self.reason_code is not None:
            raise ValueError(f'Invariant violated: passing check "{self.name}" carries a reasonCode')
        if not self.passed and self.reason_code is None:
            raise ValueError(f'Invariant violated: failing check "{self.name}" has no reasonCode')


@dataclass(frozen=True)
class CaseScoreResult:
    case_id: str
    passed: bool
    checks: list[CheckOutcome] = field(default_factory=list)


def _pass(name: str) -> CheckOutcome:
    return CheckOutcome(name=name, passed=True)


def _fail(name: str, reason_code: CheckReasonCode) -> CheckOutcome:
    return CheckOutcome(name=name, passed=False, reason_code=reason_code)


def _check(name: str, passed: bool, fail_reason: CheckReasonCode) -> CheckOutcome:
    return _pass(name) if passed else _fail(name, fail_reason)


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


def evaluate_case(case_input: EvaluationCaseInputV1) -> CaseScoreResult:
    expectations = case_input.expectations
    observed = case_input.observed

    checks: list[CheckOutcome] = [
        *evaluate_status(expectations, observed),
        *evaluate_retrieval(expectations.retrieval, observed.retrieval),
        *evaluate_tool(expectations.tool, observed.tools),
        *evaluate_report(expectations.report, observed),
        *evaluate_failure(expectations, observed),
    ]

    return CaseScoreResult(
        case_id=case_input.caseId,
        passed=all(check.passed for check in checks),
        checks=checks,
    )


def score_cases(cases: list[EvaluationCaseInputV1]) -> list[CaseScoreResult]:
    return [evaluate_case(case) for case in cases]
