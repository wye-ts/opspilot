"""Loads the TS-owned parity fixture and reconstructs the v1 wire request.

The fixture at apps/worker/src/evaluation/fixtures/ts-parity-v1.json is a
single file serving two purposes at once: each case carries the wire-facing
`caseId`/`expectations`/`observed` fields AND a TS-only `expected` field (the
golden check-level output), and the suite carries a TS-only top-level
`expectedMetrics` field. Phase 2 must not duplicate this fixture (see the
task spec, "Parity tests") — this module is the one place that separates the
wire-facing subset from the golden-comparison subset, so both this test
package and any future consumer read the same fixture the same way.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "worker"
    / "src"
    / "evaluation"
    / "fixtures"
    / "ts-parity-v1.json"
)


def load_fixture() -> dict[str, Any]:
    with FIXTURE_PATH.open() as f:
        return json.load(f)


def build_wire_request(fixture: dict[str, Any]) -> dict[str, Any]:
    """Reconstructs the EvaluationSuiteInputV1 wire request from the fixture,
    dropping the TS-only `expected` echo on each case. No shape adaptation:
    caseId/expectations/observed are passed through unmodified.
    """
    return {
        "contractVersion": fixture["contractVersion"],
        "datasetId": fixture["datasetId"],
        "cases": [
            {
                "caseId": case["caseId"],
                "expectations": case["expectations"],
                "observed": case["observed"],
            }
            for case in fixture["cases"]
        ],
    }
