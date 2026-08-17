"""Issue #59 Checkpoint B §9 — negative evaluator vectors (Python mirror).

Consumes the same TS-owned fixtures/negative-vectors-v2.json as the
TypeScript consumer (apps/worker/src/evaluation/negative-vectors.test.ts).
Each synthetic vector is validated through the same EvaluationCaseInputV2
schema the live scorer accepts, scored by score_cases, and the #59 metric
FAIL subset must equal the vector's declared expectedFailures EXACTLY — no
missing expected failure, no unexpected #59 metric failure. Because both
languages read the same fixture and the Python scorer is a function-for-
function mirror of evaluation-evaluator.ts (see scorer.py's module docstring),
per-vector agreement on the declared failures is the cross-language agreement
guarantee for negative coverage.
"""

from __future__ import annotations

import json
from pathlib import Path

from opspilot_evaluation.schemas import CheckStatus, EvaluationCaseInputV2
from opspilot_evaluation.scoring.reason_codes import CheckReasonCode
from opspilot_evaluation.scoring.scorer import METRIC_CHECK_NAMES, score_cases

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "worker"
    / "src"
    / "evaluation"
    / "fixtures"
    / "negative-vectors-v2.json"
)

# The 25 retained #59 metric FAIL reason codes (spec §9.1 — one per vector
# family). The mechanical audit below proves the fixture's declared failures
# cover this set exactly: every code appears in >=1 vector and no vector
# declares a code outside it.
RETAINED_FAIL_REASON_CODES = {
    "ROOT_CAUSE_PRESENCE_MISMATCH",
    "ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE",
    "EVIDENCE_REQUIRED_LOCATOR_MISSING",
    "EVIDENCE_STATE_MISMATCH",
    "EVIDENCE_TELEMETRY_MISSING",
    "EVIDENCE_CARDINALITY_INSUFFICIENT",
    "TELEMETRY_CLASSIFICATION_NOT_OBSERVED",
    "UNKNOWN_TELEMETRY_TREATED_AS_ANSWER",
    "UNKNOWN_TELEMETRY_GROUNDS_ACTION",
    "DIAGNOSTIC_SEQUENCE_MISMATCH",
    "DIAGNOSTIC_COUNT_MISMATCH",
    "DIAGNOSTIC_STOP_NOT_VOLUNTARY",
    "STOP_REASON_MISMATCH",
    "CONFIDENCE_OUT_OF_BAND",
    "ACTION_TYPE_SET_MISMATCH",
    "ACTION_REQUIRED_GROUNDING_MISSING",
    "ACTION_GROUNDING_NOT_ALLOWED",
    "ACTION_GROUNDING_DUPLICATED",
    "APPROVAL_ELIGIBILITY_MISMATCH",
    "TURN_BOUND_EXCEEDED",
    "TOOL_BOUND_EXCEEDED",
    "TOKEN_BUDGET_EXCEEDED",
    "RECOVERY_STAGE_MISMATCH",
    "RECOVERY_SIDE_EFFECT_OBSERVED",
    "RECOVERY_REPORT_PRESENCE_MISMATCH",
}


def load_fixture() -> list[dict]:
    with FIXTURE_PATH.open() as f:
        return json.load(f)["vectors"]


def metric_fail_subset(checks) -> list[tuple[str, str]]:
    """The #59 metric FAIL subset of a scored case: exactly the checks whose
    status is FAIL and whose name is one of the nine metric check names.
    Deterministically sorted so the expected/actual comparison is a true set
    equality regardless of check order."""
    return sorted(
        (check.name, check.reason_code.value)
        for check in checks
        if check.status is CheckStatus.FAIL and check.name in METRIC_CHECK_NAMES
    )


def sort_failures(failures: list[dict]) -> list[tuple[str, str]]:
    return sorted((failure["checkName"], failure["reasonCode"]) for failure in failures)


def test_vectors_are_nonempty_with_unique_ids() -> None:
    vectors = load_fixture()
    assert len(vectors) >= 25
    ids = [vector["id"] for vector in vectors]
    assert len(set(ids)) == len(ids)


def test_declared_failures_are_valid_metric_check_names_and_reason_codes() -> None:
    vectors = load_fixture()
    for vector in vectors:
        for failure in vector["expectedFailures"]:
            assert failure["checkName"] in METRIC_CHECK_NAMES, vector["id"]
            # ValueError for any code outside the closed CheckReasonCode set.
            assert CheckReasonCode(failure["reasonCode"]).value == failure["reasonCode"], vector["id"]


def test_mechanical_coverage_of_all_25_codes() -> None:
    vectors = load_fixture()
    declared = {
        failure["reasonCode"] for vector in vectors for failure in vector["expectedFailures"]
    }
    assert declared == RETAINED_FAIL_REASON_CODES


def test_pydantic_accepts_every_vector_and_actual_fail_subset_equals_declared() -> None:
    vectors = load_fixture()
    cases = [
        EvaluationCaseInputV2.model_validate(
            {
                "caseId": vector["id"],
                "expectations": vector["expectations"],
                "observed": vector["observed"],
            }
        )
        for vector in vectors
    ]

    results = score_cases(cases)
    results_by_id = {result.case_id: result for result in results}
    assert len(results_by_id) == len(vectors)

    for vector in vectors:
        result = results_by_id[vector["id"]]
        assert metric_fail_subset(result.checks) == sort_failures(vector["expectedFailures"]), vector["id"]
        if vector["expectedFailures"]:
            assert result.passed is False, vector["id"]
