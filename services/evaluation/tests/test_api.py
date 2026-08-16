from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from opspilot_evaluation.db.models import (
    EvaluationCaseResult,
    EvaluationMetric,
    EvaluationRun,
)
from opspilot_evaluation.db.session import get_sessionmaker
from opspilot_evaluation.schemas import EvaluationCaseInputV2
from tests.fixture_loader import build_wire_request, load_fixture_v2

pytestmark = pytest.mark.asyncio


def _minimal_investigation() -> dict:
    return {
        "providerTurnsUsed": 0,
        "diagnosticRequestCount": 0,
        "forcedFinalization": False,
        "stopReason": None,
        "assessments": [],
        "toolFailures": [],
        "bounds": {"maxProviderTurns": 4, "maxDiagnosticToolCalls": 3},
        "usage": {"inputTokens": 0, "outputTokens": 0, "providerCalls": 0},
    }


def _minimal_completed_report() -> dict:
    return {
        "evidence": [],
        "suggestedActionTypes": [],
        "category": "UNKNOWN",
        "rootCausePresent": False,
        "confidence": 0.0,
        "evidenceState": "INSUFFICIENT",
        "recommendationDisposition": "ADVISORY",
        "suggestedActions": [],
    }


def _minimal_completed_observed() -> dict:
    return {
        "runStatus": "completed",
        "errorCode": None,
        "retrieval": {"completed": False, "chunkIds": []},
        "tools": {"requested": [], "executed": [], "completed": []},
        "report": _minimal_completed_report(),
        "investigation": _minimal_investigation(),
        "failedStage": None,
    }


def _minimal_case(case_id: str = "case-one") -> dict:
    return {
        "caseId": case_id,
        "expectations": {"runStatus": "completed"},
        "observed": _minimal_completed_observed(),
    }


def _minimal_suite(cases: list[dict], dataset_id: str = "test-dataset") -> dict:
    return {"contractVersion": 2, "datasetId": dataset_id, "cases": cases}


async def test_health_does_not_touch_the_database(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_post_creates_and_get_retrieves(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case("alpha"), _minimal_case("beta")])

    post_response = await client.post("/evaluations", json=suite)
    assert post_response.status_code == 201
    body = post_response.json()
    assert body["contractVersion"] == 2
    assert body["datasetId"] == "test-dataset"
    assert len(body["cases"]) == 2
    evaluation_id = body["id"]
    uuid.UUID(evaluation_id)  # persisted id is a real UUID

    get_response = await client.get(f"/evaluations/{evaluation_id}")
    assert get_response.status_code == 200
    assert get_response.json() == body


async def test_response_is_the_persisted_resource_not_the_bare_scorer_shape(client: AsyncClient) -> None:
    # HQ-adjudicated (Phase 2 review): POST/GET intentionally return the
    # persisted HTTP evaluation resource, a superset of TS's
    # EvaluationSuiteResultV2 scorer-result shape that also carries the
    # persisted `id` — see EvaluationRunResultV2 in schemas.py. Per-case
    # `checks`/`passed` still match the scorer shape exactly (proven
    # separately by test_scorer_parity.py and test_full_ts_fixture_parity_via_api).
    response = await client.post("/evaluations", json=_minimal_suite([_minimal_case()]))
    assert response.status_code == 201
    body = response.json()
    assert set(body.keys()) == {"contractVersion", "datasetId", "id", "cases", "metrics"}


async def test_duplicate_case_ids_rejected(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case("same"), _minimal_case("same")])
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_empty_suite_rejected(client: AsyncClient) -> None:
    suite = _minimal_suite([])
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_more_than_200_cases_rejected(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case(f"case-{i}") for i in range(201)])
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_exactly_200_cases_accepted(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case(f"case-{i}") for i in range(200)])
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201
    assert len(response.json()["cases"]) == 200


@pytest.mark.parametrize("length", [255, 256])
async def test_long_dataset_id_persists_and_round_trips(client: AsyncClient, length: int) -> None:
    # Fix 4 (HQ-adjudicated Codex MINOR): dataset_id is unbounded text, not
    # varchar(255) — a request the schema accepts must not fail persistence.
    dataset_id = "d" * length
    suite = _minimal_suite([_minimal_case()], dataset_id=dataset_id)

    post_response = await client.post("/evaluations", json=suite)
    assert post_response.status_code == 201
    body = post_response.json()
    assert body["datasetId"] == dataset_id

    get_response = await client.get(f"/evaluations/{body['id']}")
    assert get_response.status_code == 200
    assert get_response.json()["datasetId"] == dataset_id


async def test_unsupported_contract_version_rejected(client: AsyncClient) -> None:
    # The active v2 contract accepts contractVersion 2 only — v1 is unwired
    # from the runtime and survives solely as the frozen offline oracle.
    suite = _minimal_suite([_minimal_case()])
    suite["contractVersion"] = 1
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "observed",
    [
        # runStatus completed but errorCode is non-null.
        {
            "runStatus": "completed",
            "errorCode": "TOOL_NOT_FOUND",
            "retrieval": {"completed": False, "chunkIds": []},
            "tools": {"requested": [], "executed": [], "completed": []},
            "report": _minimal_completed_report(),
            "investigation": _minimal_investigation(),
            "failedStage": None,
        },
        # runStatus completed but report is null.
        {
            "runStatus": "completed",
            "errorCode": None,
            "retrieval": {"completed": False, "chunkIds": []},
            "tools": {"requested": [], "executed": [], "completed": []},
            "report": None,
            "investigation": _minimal_investigation(),
            "failedStage": None,
        },
        # runStatus failed but errorCode is null.
        {
            "runStatus": "failed",
            "errorCode": None,
            "retrieval": {"completed": False, "chunkIds": []},
            "tools": {"requested": [], "executed": [], "completed": []},
            "report": None,
            "investigation": _minimal_investigation(),
            "failedStage": "DIAGNOSTIC_EXECUTION",
        },
        # runStatus failed but report is non-null.
        {
            "runStatus": "failed",
            "errorCode": "TOOL_NOT_FOUND",
            "retrieval": {"completed": False, "chunkIds": []},
            "tools": {"requested": [], "executed": [], "completed": []},
            "report": _minimal_completed_report(),
            "investigation": _minimal_investigation(),
            "failedStage": "DIAGNOSTIC_EXECUTION",
        },
    ],
)
async def test_malformed_completed_failed_observation_rejected(client: AsyncClient, observed: dict) -> None:
    case = _minimal_case()
    case["observed"] = observed
    response = await client.post("/evaluations", json=_minimal_suite([case]))
    assert response.status_code == 422


async def test_non_finite_tool_input_rejected(client: AsyncClient) -> None:
    case = _minimal_case()
    case["observed"]["tools"]["executed"] = [{"toolName": "get_service_status", "input": {"x": 0}}]
    suite = _minimal_suite([case])
    # json.dumps(..., allow_nan=True) (the default) is the one Python API
    # that can actually produce the non-standard "NaN" token on the wire —
    # httpx's json= kwarg goes through the same encoder, so a placeholder
    # value is swapped in afterwards to exercise the server's own
    # JSON-safety validator rather than any client-side rejection.
    raw_body = json.dumps(suite).replace('"x": 0', '"x": NaN').encode()
    response = await client.post("/evaluations", content=raw_body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422


async def test_404_for_unknown_evaluation(client: AsyncClient) -> None:
    response = await client.get(f"/evaluations/{uuid.uuid4()}")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "EVALUATION_NOT_FOUND"
    assert "requestId" in body["error"]


async def test_invalid_route_parameter(client: AsyncClient) -> None:
    response = await client.get("/evaluations/not-a-uuid")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "ROUTE_PARAMETER_INVALID"


async def test_check_order_and_expectations_observed_persist(client: AsyncClient) -> None:
    fixture = load_fixture_v2()
    request = build_wire_request(fixture)
    # Use the richest case (most checks) for this assertion.
    richest_case = max(fixture["cases"], key=lambda c: len(c["expected"]["checks"]))
    case = next(c for c in request["cases"] if c["caseId"] == richest_case["caseId"])
    request["cases"] = [case]

    response = await client.post("/evaluations", json=request)
    assert response.status_code == 201
    body = response.json()

    expected_checks = richest_case["expected"]["checks"]
    got_checks = body["cases"][0]["checks"]
    assert [(c["name"], c["status"], c["reasonCode"]) for c in got_checks] == [
        (c["name"], c["status"], c["reasonCode"]) for c in expected_checks
    ]

    # Reload via GET to confirm order survives persistence + reload.
    get_response = await client.get(f"/evaluations/{body['id']}")
    assert get_response.json()["cases"][0]["checks"] == got_checks

    # The persisted JSONB is the validated model's own canonical form (every
    # optional field present, explicit nulls for absent ones) — not a byte
    # copy of the wire JSON, which omits absent optional keys entirely.
    parsed_case = EvaluationCaseInputV2.model_validate(case)

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(
            select(EvaluationCaseResult).where(EvaluationCaseResult.evaluation_run_id == uuid.UUID(body["id"]))
        )
        case_row = result.scalar_one()
        assert case_row.expectations == parsed_case.expectations.model_dump(mode="json")
        assert case_row.observed == parsed_case.observed.model_dump(mode="json")


async def test_metrics_persist_with_all_six_names(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case()])
    response = await client.post("/evaluations", json=suite)
    evaluation_id = uuid.UUID(response.json()["id"])

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(
            select(EvaluationMetric).where(EvaluationMetric.evaluation_run_id == evaluation_id)
        )
        names = {row.name for row in result.scalars().all()}

    assert names == {
        "retrievalTop1",
        "retrievalHitAt3",
        "schemaHandlingCorrectness",
        "evidenceGroundingCorrectness",
        "toolCorrectness",
        "expectedStatusCorrectness",
    }


async def test_persistence_failure_leaves_no_partial_rows(client: AsyncClient) -> None:
    suite = _minimal_suite([_minimal_case()])

    with patch(
        "sqlalchemy.ext.asyncio.AsyncSession.commit",
        new=AsyncMock(side_effect=OperationalError("commit", {}, Exception("simulated failure"))),
    ):
        response = await client.post("/evaluations", json=suite)

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "PERSISTENCE_FAILED"

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(select(EvaluationRun))
        assert result.scalars().all() == []


async def test_full_ts_fixture_parity_via_api(client: AsyncClient) -> None:
    fixture = load_fixture_v2()
    request = build_wire_request(fixture)

    response = await client.post("/evaluations", json=request)
    assert response.status_code == 201
    body = response.json()

    for case_body, fixture_case in zip(body["cases"], fixture["cases"], strict=True):
        expected = fixture_case["expected"]
        assert case_body["caseId"] == fixture_case["caseId"]
        assert case_body["passed"] == expected["passed"]
        assert [(c["name"], c["status"], c["reasonCode"]) for c in case_body["checks"]] == [
            (c["name"], c["status"], c["reasonCode"]) for c in expected["checks"]
        ]

    for name, expected_value in fixture["expectedMetrics"].items():
        assert body["metrics"][name] == expected_value
