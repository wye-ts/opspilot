"""FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5/§6): the historical
v1 aggregate metrics, preserved so the offline v1 regression oracle can
reproduce the frozen ts-parity-v1.json fixture's expectedMetrics. A
byte-for-byte port of the pre-#59 scoring/metrics.py. Unwired from the active
runtime — the active metrics (scoring/metrics.py) operate on the v2 status
model; this module must never change.
"""

from __future__ import annotations

from opspilot_evaluation.legacy_v1.schemas_v1 import EvaluationMetricsV1, MetricRatio
from opspilot_evaluation.legacy_v1.scorer_v1 import CaseScoreResultV1

TOOL_CHECK_NAMES = frozenset(
    {
        "tool-requested",
        "tool-executed",
        "tool-completed",
        "tool-forbidden-executed",
        "tool-forbidden-completed",
    }
)


def _has_check(result: CaseScoreResultV1, name: str) -> bool:
    return any(check.name == name for check in result.checks)


def _check_passed(result: CaseScoreResultV1, name: str) -> bool:
    return any(check.name == name and check.passed for check in result.checks)


def _simple_ratio(results: list[CaseScoreResultV1], check_name: str) -> MetricRatio:
    declaring = [result for result in results if _has_check(result, check_name)]
    passing = [result for result in declaring if _check_passed(result, check_name)]
    return MetricRatio(numerator=len(passing), denominator=len(declaring))


def _tool_correctness_ratio(results: list[CaseScoreResultV1]) -> MetricRatio:
    declaring = [
        result for result in results if any(check.name in TOOL_CHECK_NAMES for check in result.checks)
    ]
    passing = [
        result
        for result in declaring
        if all(check.passed for check in result.checks if check.name in TOOL_CHECK_NAMES)
    ]
    return MetricRatio(numerator=len(passing), denominator=len(declaring))


def aggregate_metrics_v1(results: list[CaseScoreResultV1]) -> EvaluationMetricsV1:
    total_cases = len(results)
    passed_cases = len([result for result in results if result.passed])
    failed_cases = total_cases - passed_cases
    pass_rate = 0.0 if total_cases == 0 else passed_cases / total_cases

    return EvaluationMetricsV1(
        totalCases=total_cases,
        passedCases=passed_cases,
        failedCases=failed_cases,
        passRate=pass_rate,
        retrievalTop1=_simple_ratio(results, "retrieval-top1"),
        retrievalHitAt3=_simple_ratio(results, "retrieval-hit3"),
        schemaHandlingCorrectness=_simple_ratio(results, "schema-handling"),
        evidenceGroundingCorrectness=_simple_ratio(results, "evidence-grounding"),
        toolCorrectness=_tool_correctness_ratio(results),
        expectedStatusCorrectness=_simple_ratio(results, "status"),
    )
