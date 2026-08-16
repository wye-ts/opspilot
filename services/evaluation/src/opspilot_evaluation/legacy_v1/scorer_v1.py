"""FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5/§6): the historical
v1 evaluator, preserved so the offline v1 regression oracle can re-score the
frozen ts-parity-v1.json fixture forever. A byte-for-byte port of the
pre-#59 scoring/scorer.py. Unwired from the active runtime — the active
scorer is the v2 status-based model in scoring/scorer.py; this module must
never change. Its scoring semantics are the historical ones: a check either
passed or failed, and a case passed iff every emitted check passed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from opspilot_evaluation.legacy_v1.reason_codes_v1 import CheckReasonCode
from opspilot_evaluation.legacy_v1.schemas_v1 import (
    EvaluationCaseInputV1,
    EvaluationExpectations,
    JsonValue,
    ObservedFactsCompletedV1,
    ObservedFactsFailedV1,
    ReportExpectations,
    RetrievalExpectations,
    RetrievalFacts,
    ToolExpectations,
    ToolFactsV1,
)

ObservedFactsUnionV1 = ObservedFactsCompletedV1 | ObservedFactsFailedV1


@dataclass(frozen=True)
class CheckOutcomeV1:
    name: str
    passed: bool
    reason_code: CheckReasonCode | None = None

    def __post_init__(self) -> None:
        # Mirrors the EvaluationCheckV1 discriminated-union invariant: reasonCode
        # is present iff passed is False.
        if self.passed and self.reason_code is not None:
            raise ValueError(f'Invariant violated: passing check "{self.name}" carries a reasonCode')
        if not self.passed and self.reason_code is None:
            raise ValueError(f'Invariant violated: failing check "{self.name}" has no reasonCode')


@dataclass(frozen=True)
class CaseScoreResultV1:
    case_id: str
    passed: bool
    checks: list[CheckOutcomeV1] = field(default_factory=list)


def _pass(name: str) -> CheckOutcomeV1:
    return CheckOutcomeV1(name=name, passed=True)


def _fail(name: str, reason_code: CheckReasonCode) -> CheckOutcomeV1:
    return CheckOutcomeV1(name=name, passed=False, reason_code=reason_code)


def _check(name: str, passed: bool, fail_reason: CheckReasonCode) -> CheckOutcomeV1:
    return _pass(name) if passed else _fail(name, fail_reason)


def evaluate_status_v1(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnionV1,
) -> list[CheckOutcomeV1]:
    expected = expectations.runStatus.value
    if observed.runStatus.value == expected:
        return [_pass("status")]
    return [_fail("status", CheckReasonCode.STATUS_MISMATCH)]


def evaluate_retrieval_v1(
    expectations: RetrievalExpectations | None,
    observed: RetrievalFacts,
) -> list[CheckOutcomeV1]:
    if expectations is None:
        return []

    checks: list[CheckOutcomeV1] = []
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


def evaluate_tool_v1(
    expectations: ToolExpectations | None,
    observed: ToolFactsV1,
) -> list[CheckOutcomeV1]:
    if expectations is None:
        return []

    checks: list[CheckOutcomeV1] = []

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


def evaluate_report_v1(
    expectations: ReportExpectations | None,
    observed: ObservedFactsUnionV1,
) -> list[CheckOutcomeV1]:
    if expectations is None:
        return []

    checks: list[CheckOutcomeV1] = []
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


def evaluate_failure_v1(
    expectations: EvaluationExpectations,
    observed: ObservedFactsUnionV1,
) -> list[CheckOutcomeV1]:
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


def evaluate_case_v1(case_input: EvaluationCaseInputV1) -> CaseScoreResultV1:
    expectations = case_input.expectations
    observed = case_input.observed

    checks: list[CheckOutcomeV1] = [
        *evaluate_status_v1(expectations, observed),
        *evaluate_retrieval_v1(expectations.retrieval, observed.retrieval),
        *evaluate_tool_v1(expectations.tool, observed.tools),
        *evaluate_report_v1(expectations.report, observed),
        *evaluate_failure_v1(expectations, observed),
    ]

    return CaseScoreResultV1(
        case_id=case_input.caseId,
        passed=all(check.passed for check in checks),
        checks=checks,
    )


def score_cases_v1(cases: list[EvaluationCaseInputV1]) -> list[CaseScoreResultV1]:
    return [evaluate_case_v1(case) for case in cases]
