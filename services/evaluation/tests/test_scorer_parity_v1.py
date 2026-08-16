"""FROZEN v1 oracle test (OpsPilot #59 Checkpoint A §5/§6, mirroring the
TypeScript legacy-v1/parity-v1.test.ts): proves the historical v1
contract/scorer remains reproducible OFFLINE against the frozen
ts-parity-v1.json fixture. This is the only live consumer of the
opspilot_evaluation.legacy_v1 package; the active scorer/service never
imports it.
"""

from __future__ import annotations

from opspilot_evaluation.legacy_v1.metrics_v1 import aggregate_metrics_v1
from opspilot_evaluation.legacy_v1.schemas_v1 import EvaluationSuiteInputV1
from opspilot_evaluation.legacy_v1.scorer_v1 import score_cases_v1
from tests.fixture_loader import build_wire_request, load_fixture_v1


def test_frozen_v1_fixture_is_the_historical_artifact() -> None:
    fixture = load_fixture_v1()
    assert fixture["contractVersion"] == 1
    assert fixture["datasetId"] == "opspilot-deterministic-v1"
    assert len(fixture["cases"]) == 15


def test_frozen_v1_schemas_accept_the_canonical_fixture_shape() -> None:
    fixture = load_fixture_v1()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)
    assert len(suite.cases) == len(fixture["cases"])


def test_frozen_v1_oracle_reproduces_fixture_per_case() -> None:
    fixture = load_fixture_v1()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)

    results = score_cases_v1(suite.cases)

    assert len(results) == len(fixture["cases"])
    for result, fixture_case in zip(results, fixture["cases"], strict=True):
        expected = fixture_case["expected"]
        assert result.case_id == fixture_case["caseId"]
        assert result.passed == expected["passed"], fixture_case["caseId"]

        got_checks = [(c.name, c.passed, c.reason_code.value if c.reason_code else None) for c in result.checks]
        exp_checks = [(c["name"], c["passed"], c["reasonCode"]) for c in expected["checks"]]
        assert got_checks == exp_checks, fixture_case["caseId"]


def test_frozen_v1_oracle_reproduces_fixture_metrics() -> None:
    fixture = load_fixture_v1()
    request = build_wire_request(fixture)
    suite = EvaluationSuiteInputV1.model_validate(request)

    results = score_cases_v1(suite.cases)
    metrics = aggregate_metrics_v1(results)
    got = metrics.model_dump()

    for name, expected_value in fixture["expectedMetrics"].items():
        assert got[name] == expected_value, name


def test_frozen_v1_observed_shapes_carry_no_v2_additions() -> None:
    # The frozen v1 fixture must stay structurally v1: no investigation, no
    # failedStage, no tools.completed[].output, no report metadata.
    fixture = load_fixture_v1()
    for case in fixture["cases"]:
        observed = case["observed"]
        assert sorted(observed.keys()) == ["errorCode", "report", "retrieval", "runStatus", "tools"]
        assert sorted(observed["tools"].keys()) == ["completed", "executed", "requested"]
        for completed in observed["tools"]["completed"]:
            assert sorted(completed.keys()) == ["toolCallId", "toolName"]
        if observed["runStatus"] == "completed":
            assert sorted(observed["report"].keys()) == ["evidence", "suggestedActionTypes"]
