"""Suite-level metric aggregation, ported from evaluation-metrics.ts.

Denominators are based on which checks a case actually emitted (i.e. which
optional expectation the case declared), never on the total case count — see
the task spec, "metric denominators based on emitted checks". Operates on the
v2 status model: a check counts as passing iff its status is PASS.
"""

from __future__ import annotations

from opspilot_evaluation.schemas import CheckStatus, EvaluationMetrics, MetricRatio
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


def _check_passed(result: CaseScoreResult, name: str) -> bool:
    return any(check.name == name and check.status == CheckStatus.PASS for check in result.checks)


def _is_applicable(result: CaseScoreResult, name: str) -> bool:
    """A case is in a metric's denominator iff it emitted a PASS or FAIL
    outcome for that check — a NOT_APPLICABLE outcome is excluded from BOTH
    numerator and denominator (spec §11: denominator = PASS + FAIL, N/A counted
    separately by the formatter). The six v1 ratios never see NOT_APPLICABLE,
    so this is a no-op for them; for the nine #59 metrics it is the required
    semantics — a case where a metric was inapplicable cannot lower the ratio.
    Mirrors isApplicable in evaluation-metrics.ts."""
    return any(
        check.name == name and check.status is not CheckStatus.NOT_APPLICABLE for check in result.checks
    )


def _simple_ratio(results: list[CaseScoreResult], check_name: str) -> MetricRatio:
    applicable = [result for result in results if _is_applicable(result, check_name)]
    passing = [result for result in applicable if _check_passed(result, check_name)]
    return MetricRatio(numerator=len(passing), denominator=len(applicable))


def _tool_correctness_ratio(results: list[CaseScoreResult]) -> MetricRatio:
    declaring = [
        result for result in results if any(check.name in TOOL_CHECK_NAMES for check in result.checks)
    ]
    passing = [
        result
        for result in declaring
        if all(check.status == CheckStatus.PASS for check in result.checks if check.name in TOOL_CHECK_NAMES)
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
        # Issue #59 Checkpoint B — the nine #59 metric ratios (spec §5/§11).
        # N/A checks are excluded from BOTH numerator and denominator by
        # _simple_ratio, mirroring the TS aggregator.
        rootCauseDiscipline=_simple_ratio(results, "root-cause-discipline"),
        evidenceSupport=_simple_ratio(results, "evidence-support"),
        unknownHandling=_simple_ratio(results, "unknown-telemetry-handling"),
        diagnosticJustification=_simple_ratio(results, "diagnostic-justification"),
        confidenceCalibration=_simple_ratio(results, "confidence-calibration"),
        actionGrounding=_simple_ratio(results, "action-grounding"),
        approvalGate=_simple_ratio(results, "approval-gate"),
        boundsRespected=_simple_ratio(results, "bounds-respected"),
        deterministicRecovery=_simple_ratio(results, "deterministic-recovery"),
    )
