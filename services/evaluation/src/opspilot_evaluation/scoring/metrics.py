"""Suite-level metric aggregation, ported from evaluation-metrics.ts.

Denominators are based on which checks a case actually emitted (i.e. which
optional expectation the case declared), never on the total case count — see
the task spec, "metric denominators based on emitted checks".
"""

from __future__ import annotations

from opspilot_evaluation.schemas import EvaluationMetrics, MetricRatio
from opspilot_evaluation.scoring.scorer import CaseScoreResult

TOOL_CHECK_NAMES = frozenset(
    {
        "tool-requested",
        "tool-executed",
        "tool-completed",
        "tool-forbidden-executed",
        "tool-forbidden-completed",
    }
)


def _has_check(result: CaseScoreResult, name: str) -> bool:
    return any(check.name == name for check in result.checks)


def _check_passed(result: CaseScoreResult, name: str) -> bool:
    return any(check.name == name and check.passed for check in result.checks)


def _simple_ratio(results: list[CaseScoreResult], check_name: str) -> MetricRatio:
    declaring = [result for result in results if _has_check(result, check_name)]
    passing = [result for result in declaring if _check_passed(result, check_name)]
    return MetricRatio(numerator=len(passing), denominator=len(declaring))


def _tool_correctness_ratio(results: list[CaseScoreResult]) -> MetricRatio:
    declaring = [
        result for result in results if any(check.name in TOOL_CHECK_NAMES for check in result.checks)
    ]
    passing = [
        result
        for result in declaring
        if all(check.passed for check in result.checks if check.name in TOOL_CHECK_NAMES)
    ]
    return MetricRatio(numerator=len(passing), denominator=len(declaring))


def aggregate_metrics(results: list[CaseScoreResult]) -> EvaluationMetrics:
    total_cases = len(results)
    passed_cases = len([result for result in results if result.passed])
    failed_cases = total_cases - passed_cases
    pass_rate = 0.0 if total_cases == 0 else passed_cases / total_cases

    return EvaluationMetrics(
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
