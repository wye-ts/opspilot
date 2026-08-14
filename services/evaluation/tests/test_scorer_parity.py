"""Parity guarantee A (see the task spec): deep equality between the Python
scorer's output and the TS-owned golden fixture for check names, check
order, passed, reasonCode, case verdict, case totals, and all six metrics.
"""

from __future__ import annotations

from opspilot_evaluation.schemas import EvaluationSuiteInputV1
from opspilot_evaluation.scoring.metrics import aggregate_metrics
from opspilot_evaluation.scoring.scorer import score_cases
from tests.fixture_loader import build_wire_request, load_fixture


def test_pydantic_models_accept_the_canonical_fixture_shape() -> None:
    fixture = load_fixture()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)
    assert len(suite.cases) == len(fixture["cases"])


def test_scorer_matches_ts_fixture_per_case() -> None:
    fixture = load_fixture()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)

    results = score_cases(suite.cases)

    assert len(results) == len(fixture["cases"])
    for result, fixture_case in zip(results, fixture["cases"], strict=True):
        expected = fixture_case["expected"]
        assert result.case_id == fixture_case["caseId"]
        assert result.passed == expected["passed"], fixture_case["caseId"]

        got_checks = [(c.name, c.passed, c.reason_code.value if c.reason_code else None) for c in result.checks]
        exp_checks = [(c["name"], c["passed"], c["reasonCode"]) for c in expected["checks"]]
        assert got_checks == exp_checks, fixture_case["caseId"]


def test_scorer_matches_ts_fixture_metrics() -> None:
    fixture = load_fixture()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)

    results = score_cases(suite.cases)
    metrics = aggregate_metrics(results)
    got = metrics.model_dump()

    for name, expected_value in fixture["expectedMetrics"].items():
        # Semantic numeric equality (no 1-vs-1.0 false trap): Python's ==
        # already treats 1 == 1.0, and MetricRatio numerator/denominator are
        # plain ints on both sides.
        assert got[name] == expected_value, name
