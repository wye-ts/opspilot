"""Direct persistence-layer test: a genuine DB constraint violation (not a
mocked failure) must leave zero rows behind, proving _persist_evaluation's
single-transaction write is actually atomic rather than merely intending to
be.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from opspilot_evaluation.api import _persist_evaluation
from opspilot_evaluation.db.models import EvaluationRun
from opspilot_evaluation.db.session import get_sessionmaker
from opspilot_evaluation.schemas import (
    EvaluationCaseInputV2,
    EvaluationExpectations,
    EvaluationSuiteInputV2,
    InvestigationBounds,
    InvestigationFacts,
    InvestigationUsage,
    ObservedFactsCompleted,
    ReportFacts,
    RetrievalFacts,
    ToolFacts,
)
from opspilot_evaluation.scoring.metrics import aggregate_metrics
from opspilot_evaluation.scoring.scorer import score_cases

pytestmark = pytest.mark.asyncio


def _case(case_id: str) -> EvaluationCaseInputV2:
    observed = ObservedFactsCompleted(
        runStatus="completed",
        errorCode=None,
        retrieval=RetrievalFacts(completed=False, chunkIds=[]),
        tools=ToolFacts(requested=[], executed=[], completed=[]),
        report=ReportFacts(
            evidence=[],
            suggestedActionTypes=[],
            category="UNKNOWN",
            rootCausePresent=False,
            confidence=0.0,
            evidenceState="INSUFFICIENT",
            recommendationDisposition="ADVISORY",
            suggestedActions=[],
        ),
        investigation=InvestigationFacts(
            providerTurnsUsed=0,
            diagnosticRequestCount=0,
            forcedFinalization=False,
            stopReason=None,
            assessments=[],
            toolFailures=[],
            bounds=InvestigationBounds(maxProviderTurns=4, maxDiagnosticToolCalls=3),
            usage=InvestigationUsage(inputTokens=0, outputTokens=0, providerCalls=0),
        ),
    )
    expectations = EvaluationExpectations(runStatus="completed")
    return EvaluationCaseInputV2(caseId=case_id, expectations=expectations, observed=observed)


async def test_genuine_constraint_violation_rolls_back_atomically() -> None:
    # Bypasses EvaluationSuiteInputV2's own duplicate-caseId validator
    # (model_construct skips validation) specifically so this test can
    # exercise the DB's own uq_case_results_run_case constraint instead.
    cases = [_case("dup"), _case("dup")]
    suite = EvaluationSuiteInputV2.model_construct(contractVersion=2, datasetId="rollback-test", cases=cases)
    results = score_cases(cases)
    metrics = aggregate_metrics(results)

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        with pytest.raises(IntegrityError):
            await _persist_evaluation(session, suite, results, metrics)
        await session.rollback()

    async with sessionmaker() as session:
        result = await session.execute(select(EvaluationRun).where(EvaluationRun.dataset_id == "rollback-test"))
        assert result.scalars().all() == []
