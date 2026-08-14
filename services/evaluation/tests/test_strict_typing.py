"""Fix (MAJOR): request-side v1 models reject wrong JSON primitive types
instead of coercing them. Every malformed request must 422 and persist zero
runs, while approved behaviors (valid JSON numbers, 1 vs 1.0 equivalence,
omitted/null discriminants, omitted optional expectations) stay accepted.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from opspilot_evaluation.db.models import EvaluationRun
from opspilot_evaluation.db.session import get_sessionmaker

pytestmark = pytest.mark.asyncio


def _case() -> dict:
    return {
        "caseId": "case-one",
        "expectations": {
            "runStatus": "completed",
            "retrieval": {
                "expectedTop1": "chunk-a",
                "expectedInTopK": ["chunk-a"],
                "expectedNoResults": True,
                "forbiddenChunkIds": ["chunk-b"],
            },
        },
        "observed": {
            "runStatus": "completed",
            "errorCode": None,
            "retrieval": {"completed": True, "chunkIds": ["chunk-a"]},
            "tools": {
                "requested": [{"toolName": "get_service_status", "toolCallId": "call-1"}],
                "executed": [],
                "completed": [{"toolName": "get_service_status", "toolCallId": "call-1"}],
            },
            "report": {
                "evidence": [{"evidenceId": "ev-1", "sourceType": "RAG_CHUNK"}],
                "suggestedActionTypes": [],
            },
        },
    }


def _suite() -> dict:
    return {"contractVersion": 1, "datasetId": "strict-typing", "cases": [_case()]}


def _set_path(root: dict, path: str, value: object) -> dict:
    """Set a dotted path, resolving numeric segments as list indexes."""
    node: Any = root
    parts = path.split(".")
    for part in parts[:-1]:
        node = node[int(part)] if part.isdigit() else node[part]
    last = parts[-1]
    if last.isdigit():
        node[int(last)] = value
    else:
        node[last] = value
    return root


# Suite-level fields live on the request root; everything else is relative to
# the single case in `cases[0]`.
_SUITE_LEVEL_FIELDS = frozenset({"contractVersion", "datasetId"})

# (label, dotted path, wrong-primitive value). Each is the *only* defect in an
# otherwise valid suite, so a 422 can only come from strict type rejection.
WRONG_PRIMITIVES = [
    ("string where bool required", "observed.retrieval.completed", "false"),
    ("0 where bool required", "observed.retrieval.completed", 0),
    ("1 where bool required", "observed.retrieval.completed", 1),
    ("1 where bool required (expectation)", "expectations.retrieval.expectedNoResults", 1),
    ("0 where bool required (expectation)", "expectations.retrieval.expectedNoResults", 0),
    ("string where bool required (expectation)", "expectations.retrieval.expectedNoResults", "true"),
    ("number where string required (caseId)", "caseId", 123),
    ("number where string required (datasetId)", "datasetId", 123),
    ("number where enum required (runStatus)", "expectations.runStatus", 1),
    ("number where string required (chunkId)", "observed.retrieval.chunkIds", [123]),
    ("number where string required (expectedTop1)", "expectations.retrieval.expectedTop1", 5),
    ("number where string required (expectedInTopK)", "expectations.retrieval.expectedInTopK", [1]),
    ("number where string required (nested toolName)", "observed.tools.requested.0.toolName", 123),
    ("bool where string required (nested toolCallId)", "observed.tools.completed.0.toolCallId", True),
    ("number where enum required (nested sourceType)", "observed.report.evidence.0.sourceType", 5),
    ("string where integer literal required (contractVersion)", "contractVersion", "1"),
    ("bool where integer literal required (contractVersion)", "contractVersion", True),
]


@pytest.mark.parametrize(("label", "path", "value"), WRONG_PRIMITIVES)
async def test_wrong_primitive_type_rejected_with_422_and_zero_runs(
    client: AsyncClient, label: str, path: str, value: object
) -> None:
    suite = _suite()
    root = suite if path.split(".")[0] in _SUITE_LEVEL_FIELDS else suite["cases"][0]
    _set_path(root, path, value)

    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 422, label

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        result = await session.execute(select(EvaluationRun))
        assert result.scalars().all() == [], label


async def test_valid_json_numbers_still_accepted(client: AsyncClient) -> None:
    # `1` vs `1.0` must never become an artificial mismatch: 1.0 is a valid
    # JSON number equal to the literal 1, so it must be accepted and coerced
    # to the canonical persisted value.
    suite = _suite()
    suite["contractVersion"] = 1.0
    response = await client.post("/evaluations", json=suite)
    assert response.status_code == 201
    assert response.json()["contractVersion"] == 1


async def test_control_valid_suite_still_persists(client: AsyncClient) -> None:
    # Control: the same suite with only correct primitive types must succeed.
    response = await client.post("/evaluations", json=_suite())
    assert response.status_code == 201
