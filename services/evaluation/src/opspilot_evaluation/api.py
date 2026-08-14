"""FastAPI routes for the Phase 2 evaluation service.

Exactly the three Phase-2 endpoints from the task spec: GET /health,
POST /evaluations, GET /evaluations/{id}. No worker HTTP integration, no
scorer-default cutover, no retries/idempotency — all Phase 3+/non-goals.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Literal, cast

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
    EvaluationCaseResultV1,
    EvaluationCheckV1,
    EvaluationMetrics,
    EvaluationRunResultV1,
    EvaluationSuiteInputV1,
    MetricRatio,
)
from opspilot_evaluation.scoring.metrics import aggregate_metrics
from opspilot_evaluation.scoring.scorer import CaseScoreResult, score_cases

logger = logging.getLogger("opspilot_evaluation")

router = APIRouter()

# Order matches evaluation-metrics.ts's EvaluationMetrics field order — kept
# as a single named list rather than re-deriving it at each call site.
METRIC_NAMES = (
    "retrievalTop1",
    "retrievalHitAt3",
    "schemaHandlingCorrectness",
    "evidenceGroundingCorrectness",
    "toolCorrectness",
    "expectedStatusCorrectness",
)


@router.get("/health")
async def health() -> dict[str, str]:
    # Process/service liveness only — deliberately takes no DB dependency
    # (see the task spec, "Do not make /health depend on DB reachability").
    return {"status": "ok", "service": "opspilot-evaluation"}


def _metric_ratio(metrics: EvaluationMetrics, name: str) -> MetricRatio:
    ratio: MetricRatio = getattr(metrics, name)
    return ratio


async def _persist_evaluation(
    session: AsyncSession,
    suite_input: EvaluationSuiteInputV1,
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
                    passed=check.passed,
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
    suite_input: EvaluationSuiteInputV1,
    session: AsyncSession = Depends(get_session),
) -> EvaluationRunResultV1:
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

    # 5. return the persisted representation — EvaluationRunResultV1, the
    # persisted HTTP resource (see schemas.py), not CaseScoreResult, the
    # deterministic scorer/parity shape `case_results` already is.
    return EvaluationRunResultV1(
        contractVersion=suite_input.contractVersion,
        datasetId=suite_input.datasetId,
        id=str(run_id),
        cases=[
            EvaluationCaseResultV1(
                caseId=result.case_id,
                passed=result.passed,
                checks=[
                    EvaluationCheckV1(
                        name=check.name,
                        passed=check.passed,
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
) -> EvaluationRunResultV1:
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

    metrics_by_name = {
        metric.name: MetricRatio(numerator=metric.numerator, denominator=metric.denominator)
        for metric in run.metrics
    }

    return EvaluationRunResultV1(
        # Phase 2 accepts only contractVersion 1 at the POST boundary (see
        # EvaluationSuiteInputV1), so any persisted run's value is always 1.
        contractVersion=cast(Literal[1], run.contract_version),
        datasetId=run.dataset_id,
        id=str(run.id),
        cases=[
            EvaluationCaseResultV1(
                caseId=case_result.case_id,
                passed=case_result.passed,
                checks=[
                    EvaluationCheckV1(name=check.name, passed=check.passed, reasonCode=check.reason_code)
                    for check in case_result.checks
                ],
            )
            for case_result in run.case_results
        ],
        metrics=EvaluationMetrics(
            totalCases=run.total_cases,
            passedCases=run.passed_cases,
            failedCases=run.failed_cases,
            passRate=run.pass_rate,
            **{name: metrics_by_name[name] for name in METRIC_NAMES},
        ),
    )
