"""Fix 1 (HQ-adjudicated Codex MAJOR): Python's `True == 1` and `False == 0`
must not leak into tool-input parity comparisons — JS's `===` never treats a
boolean and a number as equal, while `1` and `1.0` (one JS Number type) must
stay equal.
"""

from __future__ import annotations

import pytest

from opspilot_evaluation.schemas import ToolExecutedEntry, ToolExpectations, ToolFacts
from opspilot_evaluation.scoring.reason_codes import CheckReasonCode
from opspilot_evaluation.scoring.scorer import CheckOutcome, evaluate_tool, json_values_equal


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        (True, 1, False),
        (1, True, False),
        (False, 0, False),
        (0, False, False),
        (True, True, True),
        (False, False, True),
        (True, False, False),
        (1, 1.0, True),
        (1, 1, True),
        (1.5, 1.5, True),
        (1, 2, False),
        ({"enabled": True}, {"enabled": 1}, False),
        ({"enabled": False}, {"enabled": 0}, False),
        ({"enabled": True}, {"enabled": True}, True),
        ([True, 2], [1, 2], False),
        ([True, 2], [True, 2], True),
        ([{"count": 1.0}], [{"count": 1}], True),
        ([{"flag": False}], [{"flag": 0}], False),
        ("1", 1, False),
        (None, None, True),
        (None, False, False),
    ],
)
def test_json_values_equal(a: object, b: object, expected: bool) -> None:
    assert json_values_equal(a, b) is expected


def test_evaluate_tool_executed_top_level_bool_number_mismatch() -> None:
    expectations = ToolExpectations(
        expectedExecuted=[ToolExecutedEntry(toolName="get_service_status", input={"enabled": True})]
    )
    observed = ToolFacts(
        requested=[],
        executed=[ToolExecutedEntry(toolName="get_service_status", input={"enabled": 1})],
        completed=[],
    )
    checks = evaluate_tool(expectations, observed)
    expected = CheckOutcome(name="tool-executed", passed=False, reason_code=CheckReasonCode.TOOL_EXECUTED_MISMATCH)
    assert checks == [expected]


def test_evaluate_tool_executed_nested_bool_number_mismatch() -> None:
    expectations = ToolExpectations(
        expectedExecuted=[
            ToolExecutedEntry(toolName="get_service_status", input={"flags": [{"enabled": False}]})
        ]
    )
    observed = ToolFacts(
        requested=[],
        executed=[ToolExecutedEntry(toolName="get_service_status", input={"flags": [{"enabled": 0}]})],
        completed=[],
    )
    checks = evaluate_tool(expectations, observed)
    expected = CheckOutcome(name="tool-executed", passed=False, reason_code=CheckReasonCode.TOOL_EXECUTED_MISMATCH)
    assert checks == [expected]


def test_evaluate_tool_executed_numeric_1_vs_1_point_0_still_equal() -> None:
    expectations = ToolExpectations(
        expectedExecuted=[ToolExecutedEntry(toolName="get_service_status", input={"count": 1})]
    )
    observed = ToolFacts(
        requested=[],
        executed=[ToolExecutedEntry(toolName="get_service_status", input={"count": 1.0})],
        completed=[],
    )
    checks = evaluate_tool(expectations, observed)
    assert checks == [CheckOutcome(name="tool-executed", passed=True)]
