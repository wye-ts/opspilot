"""FastAPI routes for the Phase 2 evaluation service.

Exactly the three Phase-2 endpoints from the task spec: GET /health,
POST /evaluations, GET /evaluations/{id}. No worker HTTP integration, no
scorer-default cutover, no retries/idempotency — all Phase 3+/non-goals.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from opspilot_evaluation.db.models import (
    EvaluationCaseResult,
    EvaluationCheck,
    EvaluationMetric,
    EvaluationRun,
)
from opspilot_evaluation.db.session import get_session
from opspilot_evaluation.errors import EvaluationApiError
from opspilot_evaluation.schemas import (
    CheckStatus,
    EvaluationCaseResultV2,
    EvaluationCheckV2,
    EvaluationMetrics,
    EvaluationRunResultV2,
    EvaluationSuiteInputV2,
    MetricRatio,
)
from opspilot_evaluation.scoring.metrics import aggregate_metrics
from opspilot_evaluation.scoring.scorer import CaseScoreResult, score_cases

logger = logging.getLogger("opspilot_evaluation")

router = APIRouter()

# Order matches evaluation-metrics.ts's EvaluationMetrics field order — kept
# as a single named list rather than re-deriving it at each call site. Six
# existing ratios plus the nine Issue #59 Checkpoint B ratios (spec §11); the
# DB evaluation_metrics table carries no na_count column, so N/A counts are
# derived by the formatter, never persisted.
#
# The split into ORIGINAL_METRIC_NAMES / NEW_METRIC_NAMES exists for the
# Checkpoint-B read-compatibility rule in _read_metrics: a pre-B v2 row (only
# the six originals) must still be served, with the nine #59 ratios
# synthesized as 0/0, while partial-new-metric rows fail closed.
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
METRIC_NAMES = ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES


@router.get("/health")
async def health() -> dict[str, str]:
    # Process/service liveness only — deliberately takes no DB dependency
    # (see the task spec, "Do not make /health depend on DB reachability").
    return {"status": "ok", "service": "opspilot-evaluation"}


def _metric_ratio(metrics: EvaluationMetrics, name: str) -> MetricRatio:
    ratio: MetricRatio = getattr(metrics, name)
    return ratio


def _read_metrics(run: EvaluationRun) -> EvaluationMetrics:
    """Reconstructs the persisted EvaluationMetrics of a v2 run, honoring the
    Checkpoint-B read-compatibility rule.

    Exactly two persisted metric shapes are valid:

      A. a pre-B v2 row — all six original ratios, none of the nine #59 ratios
         (valid v2 data persisted before Checkpoint B expanded the shape);
      B. a current B v2 row — all fifteen ratios.

    A pre-B row is served with the nine #59 ratios synthesized as 0/0
    (zero-evaluated) — never inventing PASS/FAIL/N/A check rows and never
    mutating the stored row. Any other shape (a missing original ratio, only a
    subset of the nine #59 ratios, an unknown name, or a duplicate) fails
    closed with the service's internal-data error policy rather than being
    silently defaulted one metric at a time.
    """
    stored: dict[str, MetricRatio] = {}
    for metric in run.metrics:
        if metric.name in stored:
            logger.error("evaluation.read_metrics_duplicate", extra={"metric": metric.name})
            raise EvaluationApiError("INTERNAL_ERROR")
        stored[metric.name] = MetricRatio(numerator=metric.numerator, denominator=metric.denominator)

    missing_original = [name for name in ORIGINAL_METRIC_NAMES if name not in stored]
    if missing_original:
        logger.error("evaluation.read_metrics_missing_original", extra={"missing": missing_original})
        raise EvaluationApiError("INTERNAL_ERROR")

    unknown = sorted(set(stored) - set(METRIC_NAMES))
    if unknown:
        logger.error("evaluation.read_metrics_unknown", extra={"unknown": unknown})
        raise EvaluationApiError("INTERNAL_ERROR")

    present_new = [name for name in NEW_METRIC_NAMES if name in stored]
    if present_new and len(present_new) != len(NEW_METRIC_NAMES):
        logger.error("evaluation.read_metrics_partial_new", extra={"present": present_new})
        raise EvaluationApiError("INTERNAL_ERROR")

    new_ratios = {
        name: stored[name] if name in stored else MetricRatio(numerator=0, denominator=0)
        for name in NEW_METRIC_NAMES
    }

    return EvaluationMetrics(
        totalCases=run.total_cases,
        passedCases=run.passed_cases,
        failedCases=run.failed_cases,
        passRate=run.pass_rate,
        **{name: stored[name] for name in ORIGINAL_METRIC_NAMES},
        **new_ratios,
    )


async def _persist_evaluation(
    session: AsyncSession,
    suite_input: EvaluationSuiteInputV2,
    case_results: list[CaseScoreResult],
    metrics: EvaluationMetrics,
) -> uuid.UUID:
    run_id = uuid.uuid4()
    now = datetime.now(UTC)

    run = EvaluationRun(
        id=run_id,
        contract_version=suite_input.contractVersion,
        dataset_id=suite_input.datasetId,
        status="COMPLETED",
        total_cases=metrics.totalCases,
        passed_cases=metrics.passedCases,
        failed_cases=metrics.failedCases,
        pass_rate=metrics.passRate,
        completed_at=now,
    )

    rows: list[object] = [run]

    for case_index, (case_input, case_result) in enumerate(zip(suite_input.cases, case_results, strict=True)):
        case_result_id = uuid.uuid4()
        rows.append(
            EvaluationCaseResult(
                id=case_result_id,
                evaluation_run_id=run_id,
                case_index=case_index,
                case_id=case_result.case_id,
                passed=case_result.passed,
                expectations=case_input.expectations.model_dump(mode="json"),
                observed=case_input.observed.model_dump(mode="json"),
            )
        )
        for check_index, check in enumerate(case_result.checks):
            rows.append(
                EvaluationCheck(
                    id=uuid.uuid4(),
                    case_result_id=case_result_id,
                    check_index=check_index,
                    name=check.name,
                    status=check.status.value,
                    reason_code=check.reason_code.value if check.reason_code is not None else None,
                )
            )

    for metric_name in METRIC_NAMES:
        ratio = _metric_ratio(metrics, metric_name)
        rows.append(
            EvaluationMetric(
                evaluation_run_id=run_id,
                name=metric_name,
                numerator=ratio.numerator,
                denominator=ratio.denominator,
            )
        )

    session.add_all(rows)
    await session.commit()
    return run_id


@router.post("/evaluations", status_code=201)
async def create_evaluation(
    suite_input: EvaluationSuiteInputV2,
    session: AsyncSession = Depends(get_session),
) -> EvaluationRunResultV2:
    # 1. validate request — done by FastAPI/Pydantic before this body runs.
    # 2. score the whole suite in memory.
    case_results = score_cases(suite_input.cases)
    metrics = aggregate_metrics(case_results)

    # 3-4. persist the complete run/results/checks/metrics in one transaction.
    try:
        run_id = await _persist_evaluation(session, suite_input, case_results, metrics)
    except SQLAlchemyError:
        await session.rollback()
        logger.exception(
            "evaluation.persist_failed",
            extra={"dataset_id": suite_input.datasetId, "case_count": len(suite_input.cases)},
        )
        raise EvaluationApiError("PERSISTENCE_FAILED") from None

    logger.info(
        "evaluation.persisted",
        extra={
            "evaluation_id": str(run_id),
            "dataset_id": suite_input.datasetId,
            "case_count": metrics.totalCases,
            "outcome": "passed" if metrics.failedCases == 0 else "failed",
        },
    )

    # 5. return the persisted representation — EvaluationRunResultV2, the
    # persisted HTTP resource (see schemas.py), not CaseScoreResult, the
    # deterministic scorer/parity shape `case_results` already is.
    return EvaluationRunResultV2(
        contractVersion=suite_input.contractVersion,
        datasetId=suite_input.datasetId,
        id=str(run_id),
        cases=[
            EvaluationCaseResultV2(
                caseId=result.case_id,
                passed=result.passed,
                checks=[
                    EvaluationCheckV2(
                        name=check.name,
                        status=check.status,
                        reasonCode=check.reason_code.value if check.reason_code is not None else None,
                    )
                    for check in result.checks
                ],
            )
            for result in case_results
        ],
        metrics=metrics,
    )


@router.get("/evaluations/{evaluation_id}")
async def get_evaluation(
    evaluation_id: str,
    session: AsyncSession = Depends(get_session),
) -> EvaluationRunResultV2:
    try:
        parsed_id = uuid.UUID(evaluation_id)
    except ValueError:
        raise EvaluationApiError("ROUTE_PARAMETER_INVALID") from None

    stmt = (
        select(EvaluationRun)
        .where(EvaluationRun.id == parsed_id)
        .options(
            selectinload(EvaluationRun.case_results).selectinload(EvaluationCaseResult.checks),
            selectinload(EvaluationRun.metrics),
        )
    )
    result = await session.execute(stmt)
    run = result.scalar_one_or_none()
    if run is None:
        raise EvaluationApiError("EVALUATION_NOT_FOUND")

    # Validated v2 read (replaces the v1-era unsafe cast): POST accepts only
    # contractVersion 2 at the boundary, but a pre-migration row persisted with
    # contract_version 1 can still exist after an in-place upgrade. Serving it
    # through the v2-only resource model would require a blind cast, so it is
    # refused with a stable error instead of being silently relabeled.
    if run.contract_version != 2:
        raise EvaluationApiError("CONTRACT_VERSION_UNSUPPORTED")

    return EvaluationRunResultV2(
        contractVersion=2,
        datasetId=run.dataset_id,
        id=str(run.id),
        cases=[
            EvaluationCaseResultV2(
                caseId=case_result.case_id,
                passed=case_result.passed,
                checks=[
                    EvaluationCheckV2(
                        name=check.name,
                        status=CheckStatus(check.status),
                        reasonCode=check.reason_code,
                    )
                    for check in case_result.checks
                ],
            )
            for case_result in run.case_results
        ],
        metrics=_read_metrics(run),
    )
