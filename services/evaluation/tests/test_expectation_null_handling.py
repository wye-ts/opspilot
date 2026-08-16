"""Fix 2 (HQ-adjudicated Codex MAJOR, partially accepted): every optional
expectation section/field is TS `T | undefined` — omission is accepted,
explicit `null` is rejected with a 422. The two HQ-approved exceptions are
the completed/failed discriminant fields (`errorCode` on a completed
observation, `report` on a failed observation), where omitted and explicit
`null` are equivalent, both mapping to `None`.
"""

from __future__ import annotations

import copy

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


def _full_expectations() -> dict:
    return {
        "runStatus": "completed",
        "retrieval": {
            "expectedTop1": "chunk-1",
            "expectedInTopK": ["chunk-1"],
            "expectedNoResults": True,
            "forbiddenChunkIds": ["chunk-2"],
        },
        "tool": {
            "expectedRequested": [{"toolName": "get_service_status", "toolCallId": "call-1"}],
            "expectedExecuted": [{"toolName": "get_service_status", "input": {"x": 1}}],
            "expectedCompleted": [{"toolName": "get_service_status", "toolCallId": "call-1"}],
            "forbiddenExecutedToolNames": ["other_tool"],
            "forbiddenCompletedToolCallIds": ["call-2"],
        },
        "report": {
            "schemaExpectation": "VALID",
            "groundingExpectation": "VALID",
            "requiredEvidenceTypes": ["RAG_CHUNK"],
            "requiredEvidenceIds": ["ev-1"],
            "forbiddenEvidenceIds": ["ev-2"],
            "requiredActionTypes": ["CREATE_ESCALATION"],
        },
        "failure": {"expectedCode": "TOOL_NOT_FOUND"},
    }


def _investigation() -> dict:
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


def _valid_observed_completed() -> dict:
    return {
        "runStatus": "completed",
        "errorCode": None,
        "retrieval": {"completed": True, "chunkIds": ["chunk-1"]},
        "tools": {
            "requested": [{"toolName": "get_service_status", "toolCallId": "call-1"}],
            "executed": [{"toolName": "get_service_status", "input": {"x": 1}}],
            # v2 observed completed entries carry a JSON-safe output; these
            # tests never compare outputs, so null is a valid placeholder.
            "completed": [{"toolName": "get_service_status", "toolCallId": "call-1", "output": None}],
        },
        "report": {
            "evidence": [{"evidenceId": "ev-1", "sourceType": "RAG_CHUNK"}],
            "suggestedActionTypes": ["CREATE_ESCALATION"],
            "category": "UNKNOWN",
            "rootCausePresent": False,
            "confidence": 0.0,
            "evidenceState": "INSUFFICIENT",
            "recommendationDisposition": "ADVISORY",
            "suggestedActions": [],
        },
        "investigation": _investigation(),
        "failedStage": None,
    }


def _suite(expectations: dict, observed: dict, dataset_id: str = "null-handling") -> dict:
    return {
        "contractVersion": 2,
        "datasetId": dataset_id,
        "cases": [{"caseId": "case-1", "expectations": expectations, "observed": observed}],
    }


def _set_nested(root: dict, path: str, value: object) -> dict:
    node = root
    parts = path.split(".")
    for part in parts[:-1]:
        node = node[part]
    node[parts[-1]] = value
    return root


def _delete_nested(root: dict, path: str) -> dict:
    node = root
    parts = path.split(".")
    for part in parts[:-1]:
        node = node[part]
    del node[parts[-1]]
    return root


OPTIONAL_EXPECTATION_FIELD_PATHS = [
    "retrieval",
    "tool",
    "report",
    "failure",
    "retrieval.expectedTop1",
    "retrieval.expectedInTopK",
    "retrieval.expectedNoResults",
    "retrieval.forbiddenChunkIds",
    "tool.expectedRequested",
    "tool.expectedExecuted",
    "tool.expectedCompleted",
    "tool.forbiddenExecutedToolNames",
    "tool.forbiddenCompletedToolCallIds",
    "report.schemaExpectation",
    "report.groundingExpectation",
    "report.requiredEvidenceTypes",
    "report.requiredEvidenceIds",
    "report.forbiddenEvidenceIds",
    "report.requiredActionTypes",
]


@pytest.mark.parametrize("field_path", OPTIONAL_EXPECTATION_FIELD_PATHS)
async def test_explicit_null_rejected_for_optional_expectation_field(
    client: AsyncClient, field_path: str
) -> None:
    expectations = _set_nested(_full_expectations(), field_path, None)
    suite = _suite(expectations, _valid_observed_completed())
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422, field_path


@pytest.mark.parametrize("field_path", OPTIONAL_EXPECTATION_FIELD_PATHS)
async def test_omission_still_accepted_for_optional_expectation_field(
    client: AsyncClient, field_path: str
) -> None:
    expectations = _delete_nested(_full_expectations(), field_path)
    suite = _suite(expectations, _valid_observed_completed())
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201, field_path


async def test_explicit_null_rejected_for_failure_expected_code(client: AsyncClient) -> None:
    expectations = _full_expectations()
    expectations["failure"]["expectedCode"] = None
    suite = _suite(expectations, _valid_observed_completed())
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


async def test_contradictory_completed_failed_shapes_still_rejected(client: AsyncClient) -> None:
    observed = _valid_observed_completed()
    observed["errorCode"] = "TOOL_NOT_FOUND"
    suite = _suite(_full_expectations(), observed)
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422


def _strip_checks_ids(body: dict) -> list:
    return [
        [(c["name"], c["status"], c["reasonCode"]) for c in case["checks"]] for case in body["cases"]
    ]


async def test_completed_omitted_error_code_equivalent_to_explicit_null(client: AsyncClient) -> None:
    observed_with_null = _valid_observed_completed()
    assert observed_with_null["errorCode"] is None

    observed_omitted = copy.deepcopy(observed_with_null)
    del observed_omitted["errorCode"]

    response_null = await client.post(
        "/evaluations", json=_suite({"runStatus": "completed"}, observed_with_null, "null-errorcode")
    )
    response_omitted = await client.post(
        "/evaluations", json=_suite({"runStatus": "completed"}, observed_omitted, "omitted-errorcode")
    )

    assert response_null.status_code == 201
    assert response_omitted.status_code == 201
    assert _strip_checks_ids(response_null.json()) == _strip_checks_ids(response_omitted.json())


async def test_failed_omitted_report_equivalent_to_explicit_null(client: AsyncClient) -> None:
    observed_with_null = {
        "runStatus": "failed",
        "errorCode": "TOOL_NOT_FOUND",
        "retrieval": {"completed": False, "chunkIds": []},
        "tools": {"requested": [], "executed": [], "completed": []},
        "report": None,
        "investigation": _investigation(),
        "failedStage": "DIAGNOSTIC_EXECUTION",
    }
    observed_omitted = copy.deepcopy(observed_with_null)
    del observed_omitted["report"]

    response_null = await client.post(
        "/evaluations", json=_suite({"runStatus": "failed"}, observed_with_null, "null-report")
    )
    response_omitted = await client.post(
        "/evaluations", json=_suite({"runStatus": "failed"}, observed_omitted, "omitted-report")
    )

    assert response_null.status_code == 201
    assert response_omitted.status_code == 201
    assert _strip_checks_ids(response_null.json()) == _strip_checks_ids(response_omitted.json())
