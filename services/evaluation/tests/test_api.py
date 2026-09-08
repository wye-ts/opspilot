from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from opspilot_evaluation.db.models import (
    EvaluationCaseResult,
    EvaluationCheck,
    EvaluationMetric,
    EvaluationRun,
)
from opspilot_evaluation.db.session import get_sessionmaker
from opspilot_evaluation.schemas import EvaluationCaseInputV2
from tests.fixture_loader import build_wire_request, load_fixture_v2

pytestmark = pytest.mark.asyncio

# The two persisted v2 metric shapes the Checkpoint-B read path must support
# (see _read_metrics in api.py): the six pre-B ratios and the nine #59 ratios.
ORIGINAL_METRIC_NAMES = (
    "retrievalTop1",
    "retrievalHitAt3",
    "schemaHandlingCorrectness",
    "evidenceGroundingCorrectness",
    "toolCorrectness",
    "expectedStatusCorrectness",
)
NEW_METRIC_NAMES = (
    "rootCauseDiscipline",
    "evidenceSupport",
    "unknownHandling",
    "diagnosticJustification",
    "confidenceCalibration",
    "actionGrounding",
    "approvalGate",
    "boundsRespected",
    "deterministicRecovery",
)
# Milestone 13 Issue B (#75) — the third generation: the seven FLAT persisted
# names the nested wire shape maps onto (see MILESTONE_13_METRIC_PATHS).
MILESTONE_13_METRIC_NAMES = (
    "recallAtKExact",
    "recallAtKParaphrase",
    "recallAtKNearMiss",
    "meanReciprocalRankExact",
    "meanReciprocalRankParaphrase",
    "meanReciprocalRankNearMiss",
    "falsePositiveRate",
)


def _retrieval_quality_input(retriever_name: str = "bm25") -> dict:
    """A realistic precomputed retrieval-quality payload — MRR encoded in
    sixths (6/3/2/0 per query, denominator = queryCount * 6), matching
    runbooks-eval/score-query-set.ts's output."""
    return {
        "retrieverName": retriever_name,
        "corpusContentHash": "a" * 64,
        "recallAtK": {
            "exact": {"numerator": 10, "denominator": 10},
            "paraphrase": {"numerator": 9, "denominator": 10},
            "nearMiss": {"numerator": 12, "denominator": 12},
        },
        "meanReciprocalRank": {
            "exact": {"numerator": 60, "denominator": 60},
            "paraphrase": {"numerator": 55, "denominator": 60},
            "nearMiss": {"numerator": 58, "denominator": 72},
        },
        "falsePositiveRate": {"numerator": 3, "denominator": 8},
    }


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


def _metric_rows(run_id: uuid.UUID, names: tuple[str, ...]) -> list[EvaluationMetric]:
    # Deterministic distinct values so tests can assert exact preservation.
    return [
        EvaluationMetric(
            evaluation_run_id=run_id,
            name=name,
            numerator=index + 1,
            denominator=len(names),
        )
        for index, name in enumerate(names)
    ]


async def _seed_v2_run(
    metric_names: tuple[str, ...],
    *,
    retriever_name: str | None = None,
    corpus_hash: str | None = None,
) -> str:
    """Seeds a contractVersion-2 run directly (bypassing POST) with a valid
    case/check and exactly the given metric rows — used to exercise the GET
    read-compatibility path for persisted shapes POST can no longer produce.

    The two provenance columns default to NULL/NULL (every pre-Milestone-13
    row) and can be set independently so the partial-provenance corruption
    case is reachable at all."""
    run_id = uuid.uuid4()
    case_result_id = uuid.uuid4()
    now = datetime.now(UTC)
    run = EvaluationRun(
        id=run_id,
        contract_version=2,
        dataset_id="compat-dataset",
        status="COMPLETED",
        total_cases=1,
        passed_cases=1,
        failed_cases=0,
        pass_rate=1.0,
        retrieval_quality_retriever_name=retriever_name,
        retrieval_quality_corpus_hash=corpus_hash,
        completed_at=now,
    )
    case = EvaluationCaseResult(
        id=case_result_id,
        evaluation_run_id=run_id,
        case_index=0,
        case_id="case-compat",
        passed=True,
        expectations={"runStatus": "completed"},
        observed={},
    )
    check = EvaluationCheck(
        id=uuid.uuid4(),
        case_result_id=case_result_id,
        check_index=0,
        name="status",
        status="PASS",
        reason_code=None,
    )

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        session.add_all([run, case, check, *_metric_rows(run_id, metric_names)])
        await session.commit()
        return str(run_id)


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


async def test_count_token_fields_are_strict_non_negative_integers(client: AsyncClient) -> None:
    # Checkpoint B numeric-domain alignment: every count/token field is a
    # non-negative integer in BOTH languages. Fractional, negative, numeric-
    # string, and boolean values are rejected with 422 rather than silently
    # coerced (the pre-fix lax `int` coerced 1.5→1, "2"→2, true→1).
    invalid_values = [-1, -0.5, 1.5, "2", True]
    valid_values = [0, 1, 2]

    for value in invalid_values:
        case = _minimal_case()
        case["expectations"] = {
            "runStatus": "completed",
            "expectedEvidence": {"state": "SUFFICIENT", "requiredLocators": [], "minDistinctLocators": value},
        }
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422, (
            f"minDistinctLocators={value!r} should be rejected"
        )

    for value in valid_values:
        case = _minimal_case()
        case["expectations"] = {
            "runStatus": "completed",
            "expectedEvidence": {"state": "SUFFICIENT", "requiredLocators": [], "minDistinctLocators": value},
        }
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 201, (
            f"minDistinctLocators={value!r} should be accepted"
        )

    for value in invalid_values:
        case = _minimal_case()
        case["expectations"] = {"runStatus": "completed", "expectedBounds": {"maxTotalTokens": value}}
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422, (
            f"maxTotalTokens={value!r} should be rejected"
        )

    for value in [0, 1, 2]:
        case = _minimal_case()
        case["expectations"] = {"runStatus": "completed", "expectedBounds": {"maxTotalTokens": value}}
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 201, (
            f"maxTotalTokens={value!r} should be accepted"
        )

    # Representative observed investigation count/token fields reject the
    # same wrong primitives.
    for field in ("providerTurnsUsed", "diagnosticRequestCount"):
        case = _minimal_case()
        case["observed"]["investigation"][field] = 1.5
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422, (
            f"investigation.{field}=1.5 should be rejected"
        )

    case = _minimal_case()
    case["observed"]["investigation"]["usage"]["inputTokens"] = -1
    assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422

    case = _minimal_case()
    case["observed"]["investigation"]["bounds"]["maxProviderTurns"] = True
    assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422


async def test_confidence_bounds_are_strict_finite_unit_numbers(client: AsyncClient) -> None:
    # Confidence bounds are continuous/fractional quantities: valid JSON
    # integers (0, 1) and fractions (0.25, 0.75) are accepted, while booleans,
    # numeric strings, negatives, values above 1, min > max, and non-finite
    # values are rejected with 422 rather than coerced (the pre-fix lax
    # `float` coerced true->1.0, "0.5"->0.5, and NaN passed the range check).
    invalid_values = [False, True, "0.5", -0.1, 1.1]
    valid_values = [0, 1, 0.25, 0.75]

    for value in invalid_values:
        for field in ("min", "max"):
            case = _minimal_case()
            band = {"min": 0.5, "max": 0.5}
            band[field] = value
            case["expectations"] = {"runStatus": "completed", "expectedConfidence": band}
            assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422, (
                f"confidence.{field}={value!r} should be rejected"
            )

    for value in valid_values:
        case = _minimal_case()
        case["expectations"] = {
            "runStatus": "completed",
            "expectedConfidence": {"min": value, "max": value},
        }
        assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 201, (
            f"confidence {value!r} should be accepted"
        )

    # min > max is rejected by the model_validator.
    case = _minimal_case()
    case["expectations"] = {
        "runStatus": "completed",
        "expectedConfidence": {"min": 0.9, "max": 0.2},
    }
    assert (await client.post("/evaluations", json=_minimal_suite([case]))).status_code == 422

    # Non-finite bounds reach the server via the non-standard "NaN"/"Infinity"
    # JSON tokens (see test_non_finite_tool_input_rejected for the technique)
    # and are rejected by the strict finite-float constraint.
    for token in ("NaN", "Infinity", "-Infinity"):
        case = _minimal_case()
        case["expectations"] = {
            "runStatus": "completed",
            "expectedConfidence": {"min": 0.0, "max": 0.5},
        }
        raw_body = json.dumps(_minimal_suite([case])).replace('"min": 0.0', f'"min": {token}').encode()
        response = await client.post("/evaluations", content=raw_body, headers={"Content-Type": "application/json"})
        assert response.status_code == 422, f"confidence.min={token} should be rejected"


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


async def test_metrics_persist_with_all_twenty_two_names(client: AsyncClient) -> None:
    # Issue #59 Checkpoint B §11 plus Milestone 13 Issue B (#75): the six v1
    # ratios, the nine #59 ratios, and the seven flat Milestone-13 names
    # (MILESTONE_13_METRIC_NAMES — the nested recallAtK/meanReciprocalRank
    # groups flattened via the explicit mapping table, plus falsePositiveRate)
    # are all persisted as ratio rows (numerator/denominator); N/A counts are
    # derived by the formatter and never persisted, and the two provenance
    # values live on the run row, not here.
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
        "rootCauseDiscipline",
        "evidenceSupport",
        "unknownHandling",
        "diagnosticJustification",
        "confidenceCalibration",
        "actionGrounding",
        "approvalGate",
        "boundsRespected",
        "deterministicRecovery",
        "recallAtKExact",
        "recallAtKParaphrase",
        "recallAtKNearMiss",
        "meanReciprocalRankExact",
        "meanReciprocalRankParaphrase",
        "meanReciprocalRankNearMiss",
        "falsePositiveRate",
    }


async def test_get_pre_b_v2_row_is_served_with_zero_evaluated_new_ratios(client: AsyncClient) -> None:
    # Checkpoint B remediation (MAJOR): a valid pre-B v2 run — the six
    # original metric rows, none of the nine #59 rows — must remain readable.
    # GET preserves the six stored values exactly, synthesizes the nine new
    # ratios as 0/0 (never inventing check rows), and performs no DB write.
    run_id = await _seed_v2_run(ORIGINAL_METRIC_NAMES)

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["contractVersion"] == 2

    metrics = body["metrics"]
    for index, name in enumerate(ORIGINAL_METRIC_NAMES):
        assert metrics[name] == {"numerator": index + 1, "denominator": len(ORIGINAL_METRIC_NAMES)}, name
    for name in NEW_METRIC_NAMES:
        assert metrics[name] == {"numerator": 0, "denominator": 0}, name

    # The read path must not backfill/write any metric rows.
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(
            select(EvaluationMetric).where(EvaluationMetric.evaluation_run_id == uuid.UUID(run_id))
        )
        stored_names = {row.name for row in result.scalars().all()}
    assert stored_names == set(ORIGINAL_METRIC_NAMES)


async def test_get_current_v2_row_round_trips_every_metric_field(client: AsyncClient) -> None:
    # A normal current v2 run — all twenty-two metric rows — still reads back
    # exactly: GET returns the identical persisted resource.
    suite = _minimal_suite([_minimal_case()])
    post_response = await client.post("/evaluations", json=suite)
    assert post_response.status_code == 201
    evaluation_id = post_response.json()["id"]

    get_response = await client.get(f"/evaluations/{evaluation_id}")
    assert get_response.status_code == 200
    assert get_response.json() == post_response.json()
    assert set(get_response.json()["metrics"].keys()) == {
        "totalCases",
        "passedCases",
        "failedCases",
        "passRate",
        *ORIGINAL_METRIC_NAMES,
        *NEW_METRIC_NAMES,
        # Milestone 13 Issue B (#75): NESTED on the wire (the flat
        # MILESTONE_13_METRIC_NAMES exist only as persisted row names), plus
        # the nullable provenance sibling.
        "recallAtK",
        "meanReciprocalRank",
        "falsePositiveRate",
        "retrievalQualityProvenance",
    }


# ---------------------------------------------------------------------------
# Milestone 13 Issue B (#75) — retrieval-quality passthrough, provenance, and
# the third read-compatibility shape.
# ---------------------------------------------------------------------------


async def test_case_only_run_persists_zero_retrieval_quality_and_null_provenance(
    client: AsyncClient,
) -> None:
    # No retrievalQualityMetrics on the request: the four new fields must read
    # as the 0/0 "not evaluated" default with a null provenance, and BOTH
    # provenance columns must be NULL on the row.
    suite = _minimal_suite([_minimal_case()])
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201
    metrics = response.json()["metrics"]

    zero = {"numerator": 0, "denominator": 0}
    assert metrics["recallAtK"] == {"exact": zero, "paraphrase": zero, "nearMiss": zero}
    assert metrics["meanReciprocalRank"] == {"exact": zero, "paraphrase": zero, "nearMiss": zero}
    assert metrics["falsePositiveRate"] == zero
    assert metrics["retrievalQualityProvenance"] is None

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        row = await session.get(EvaluationRun, uuid.UUID(response.json()["id"]))
        assert row is not None
        assert row.retrieval_quality_retriever_name is None
        assert row.retrieval_quality_corpus_hash is None


async def test_retrieval_quality_metrics_are_copied_through_unchanged(client: AsyncClient) -> None:
    # The service NEVER computes these (it has no corpus, retriever, or query
    # set): the persisted values must be byte-identical to what was submitted,
    # and the provenance must name the submitted retriever and corpus hash.
    supplied = _retrieval_quality_input("bm25")
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = supplied

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201
    metrics = response.json()["metrics"]

    assert metrics["recallAtK"] == supplied["recallAtK"]
    assert metrics["meanReciprocalRank"] == supplied["meanReciprocalRank"]
    assert metrics["falsePositiveRate"] == supplied["falsePositiveRate"]
    assert metrics["retrievalQualityProvenance"] == {
        "retrieverName": "bm25",
        "corpusContentHash": supplied["corpusContentHash"],
    }

    # And it survives a GET round-trip identically.
    fetched = await client.get(f"/evaluations/{response.json()['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["metrics"] == metrics


# Codex-review MAJOR fix, verified against source: MetricRatioInput accepted
# any pair of non-negative integers before this fix, letting a numerator
# exceed its denominator (a reported rate above 100%) or a positive
# numerator sit over a zero denominator (undefined as a ratio) — with no
# later recomputation step (this service never computes these values, plan
# §0's decision gate) that could ever catch the corruption downstream.
async def test_retrieval_quality_ratio_numerator_exceeding_denominator_is_rejected(
    client: AsyncClient,
) -> None:
    supplied = _retrieval_quality_input("bm25")
    supplied["falsePositiveRate"] = {"numerator": 9, "denominator": 8}
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = supplied

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_retrieval_quality_ratio_positive_numerator_zero_denominator_is_rejected(
    client: AsyncClient,
) -> None:
    supplied = _retrieval_quality_input("bm25")
    supplied["recallAtK"]["exact"] = {"numerator": 1, "denominator": 0}
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = supplied

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_retrieval_quality_ratio_genuine_zero_zero_is_accepted(client: AsyncClient) -> None:
    supplied = _retrieval_quality_input("bm25")
    supplied["falsePositiveRate"] = {"numerator": 0, "denominator": 0}
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = supplied

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201
    assert response.json()["metrics"]["falsePositiveRate"] == {"numerator": 0, "denominator": 0}


async def test_two_runs_scored_against_different_retrievers_stay_distinguishable(
    client: AsyncClient,
) -> None:
    # Plan §7 criterion 9: without persisted provenance these two runs would be
    # indistinguishable once the originating request context is gone.
    ids = {}
    for retriever_name in ("keyword", "bm25"):
        supplied = _retrieval_quality_input(retriever_name)
        supplied["falsePositiveRate"] = {
            "numerator": 3 if retriever_name == "bm25" else 5,
            "denominator": 8,
        }
        suite = _minimal_suite([_minimal_case()])
        suite["retrievalQualityMetrics"] = supplied
        response = await client.post("/evaluations", json=suite)
        assert response.status_code == 201
        ids[retriever_name] = response.json()["id"]

    read_back = {}
    for retriever_name, evaluation_id in ids.items():
        fetched = await client.get(f"/evaluations/{evaluation_id}")
        assert fetched.status_code == 200
        read_back[retriever_name] = fetched.json()["metrics"]

    assert read_back["keyword"]["retrievalQualityProvenance"]["retrieverName"] == "keyword"
    assert read_back["bm25"]["retrievalQualityProvenance"]["retrieverName"] == "bm25"
    assert read_back["keyword"]["falsePositiveRate"] != read_back["bm25"]["falsePositiveRate"]


async def test_get_pre_milestone_13_row_synthesizes_zero_ratios_and_null_provenance(
    client: AsyncClient,
) -> None:
    # The THIRD read-compatibility shape: a persisted 15-metric run (6+9, no
    # Milestone-13 rows, both provenance columns NULL) must still read
    # successfully, with the new ratios synthesized as 0/0 — exactly as the
    # existing two-shape logic already does for the #59 generation.
    run_id = await _seed_v2_run(ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES)

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 200
    metrics = response.json()["metrics"]

    zero = {"numerator": 0, "denominator": 0}
    assert metrics["recallAtK"] == {"exact": zero, "paraphrase": zero, "nearMiss": zero}
    assert metrics["meanReciprocalRank"] == {"exact": zero, "paraphrase": zero, "nearMiss": zero}
    assert metrics["falsePositiveRate"] == zero
    assert metrics["retrievalQualityProvenance"] is None

    # No backfill: the read path must not write the missing rows.
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(
            select(EvaluationMetric).where(EvaluationMetric.evaluation_run_id == uuid.UUID(run_id))
        )
        stored_names = {row.name for row in result.scalars().all()}
    assert stored_names == set(ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES)


async def test_get_partial_milestone_13_metric_corruption_fails_closed(client: AsyncClient) -> None:
    # Same all-or-nothing rule as the #59 generation, applied to the seven
    # Milestone-13 rows.
    run_id = await _seed_v2_run(
        ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES + MILESTONE_13_METRIC_NAMES[:3]
    )

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"


@pytest.mark.parametrize(
    ("retriever_name", "corpus_hash"),
    [("bm25", None), (None, "a" * 64)],
)
async def test_get_partial_provenance_fails_closed(
    client: AsyncClient, retriever_name: str | None, corpus_hash: str | None
) -> None:
    # Exactly one provenance column set is an internal data inconsistency —
    # rejected via INTERNAL_ERROR, never guessed at (plan §3).
    run_id = await _seed_v2_run(
        ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES,
        retriever_name=retriever_name,
        corpus_hash=corpus_hash,
    )

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"


async def test_explicit_null_retrieval_quality_metrics_rejected(client: AsyncClient) -> None:
    # Omission is the only accepted way to skip an optional field in this
    # contract — explicit null is rejected, same as every other optional field.
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = None

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_retrieval_quality_metrics_rejects_unknown_field(client: AsyncClient) -> None:
    # extra="forbid" on the new models, consistent with the rest of the v2
    # contract — e.g. a trueNegative group that recall@k must never carry.
    supplied = _retrieval_quality_input()
    supplied["recallAtK"]["trueNegative"] = {"numerator": 0, "denominator": 8}
    suite = _minimal_suite([_minimal_case()])
    suite["retrievalQualityMetrics"] = supplied

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_get_partial_new_metric_corruption_fails_closed(client: AsyncClient) -> None:
    # A partial subset of the nine new metric rows is corruption, not a
    # compatibility case: GET fails closed with the service's internal-data
    # error policy rather than silently defaulting the missing ones.
    run_id = await _seed_v2_run(ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES[:3])

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"


async def test_get_missing_original_metric_fails_closed(client: AsyncClient) -> None:
    # The all-or-none compatibility discriminator is over the nine new metric
    # names, but the six originals are required in every shape: a run missing
    # one of them fails closed too.
    run_id = await _seed_v2_run(ORIGINAL_METRIC_NAMES[:-1])

    response = await client.get(f"/evaluations/{run_id}")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"


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
