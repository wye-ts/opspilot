"""FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5/§6): the historical
v1 wire contract, preserved so the offline v1 regression oracle can reproduce
the frozen ts-parity-v1.json fixture forever. Unwired from the active
runtime — the active service accepts contractVersion 2 only (see
opspilot_evaluation.schemas), and nothing in the active evaluation path
imports this module.

Frozen shapes live here; genuinely version-neutral primitives that did not
change at the #59 Checkpoint A cutover (entry primitives, enums, JsonValue,
the expectation sub-models, MetricRatio) are re-exported from the active
schemas module. The v1 WIRE/RESULT SHAPE itself — EvaluationExpectationsV1,
EvaluationMetricsV1, and the v1 ObservedFacts discriminant — is owned here so
the frozen oracle can never acquire future active-v2 fields merely because
active schemas evolve (OpsPilot #59 Checkpoint B remediation: the active
EvaluationExpectations/EvaluationMetrics gained the nine Checkpoint-B fields,
which must stay out of the frozen v1 contract).

The v1 cross-language evaluation contract, as frozen by the approved
Revision 3 plan for OpsPilot #61: a SUITE-level request/response, not a
per-case protocol. TypeScript owned building EvaluationSuiteInputV1 (one
dataset's worth of case expectations + observed run facts); a Python/FastAPI
scorer consumed it whole and produced an EvaluationSuiteResultV1 over HTTP.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from opspilot_evaluation.schemas import (
    MAX_CASES,
    ActionType,
    ErrorCode,
    EvidenceEntry,
    FailureExpectations,
    JsonValue,
    MetricRatio,
    ReportExpectations,
    RetrievalExpectations,
    RetrievalFacts,
    RunStatus,
    ToolExecutedEntry,
    ToolExpectations,
    ToolRequestedEntry,
    _reject_explicit_null,
    _StrictStr,
)

__all__ = [
    "EvaluationCaseInputV1",
    "EvaluationCaseResultV1",
    "EvaluationCheckV1",
    "EvaluationExpectationsV1",
    "EvaluationMetricsV1",
    "EvaluationSuiteInputV1",
    "JsonValue",
    "MetricRatio",
    "ObservedFactsV1",
    "ReportExpectations",
    "ReportFactsV1",
    "RetrievalExpectations",
    "RetrievalFacts",
    "ToolExpectations",
    "ToolFactsV1",
    "ToolRequestedEntry",
    "ToolExecutedEntry",
    "ToolCompletedEntryV1",
]


# ---------------------------------------------------------------------------
# FROZEN v1-specific observed shapes.
#
# The three shapes below are the exact pre-#59 v1 forms: a completed tool call
# carries NO output, the completed report carries ONLY evidence +
# suggestedActionTypes, and the ObservedFacts discriminant carries no
# investigation/failedStage. They must never gain a v2 field.
# ---------------------------------------------------------------------------


class ToolCompletedEntryV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolName: _StrictStr
    toolCallId: _StrictStr


class ToolFactsV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requested: list[ToolRequestedEntry]
    executed: list[ToolExecutedEntry]
    completed: list[ToolCompletedEntryV1]


class ReportFactsV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidence: list[EvidenceEntry]
    suggestedActionTypes: list[ActionType]


class ObservedFactsCompletedV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runStatus: Literal[RunStatus.completed]
    errorCode: None = None
    retrieval: RetrievalFacts
    tools: ToolFactsV1
    report: ReportFactsV1


class ObservedFactsFailedV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runStatus: Literal[RunStatus.failed]
    errorCode: ErrorCode
    retrieval: RetrievalFacts
    tools: ToolFactsV1
    report: None = None


ObservedFactsV1 = ObservedFactsCompletedV1 | ObservedFactsFailedV1


# ---------------------------------------------------------------------------
# FROZEN v1 suite-level request.
# ---------------------------------------------------------------------------


class EvaluationExpectationsV1(BaseModel):
    """The frozen pre-Checkpoint-B v1 expectation set — the exact Checkpoint-A
    EvaluationExpectations, restated here so the offline v1 oracle owns its
    own request shape. The active EvaluationExpectations gained the ten
    Checkpoint-B fields (expectedRootCause, expectedEvidence, ...); with
    extra="forbid" this frozen model rejects any of them on the v1 wire,
    keeping the frozen contract structurally v1.
    """

    model_config = ConfigDict(extra="forbid")
    runStatus: RunStatus
    retrieval: RetrievalExpectations | None = None
    tool: ToolExpectations | None = None
    report: ReportExpectations | None = None
    failure: FailureExpectations | None = None

    _reject_null_fields = _reject_explicit_null("retrieval", "tool", "report", "failure")


class EvaluationCaseInputV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: _StrictStr = Field(min_length=1, max_length=128)
    expectations: EvaluationExpectationsV1
    observed: ObservedFactsV1


class EvaluationSuiteInputV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contractVersion: Literal[1]
    datasetId: _StrictStr = Field(min_length=1)
    cases: list[EvaluationCaseInputV1] = Field(min_length=1, max_length=MAX_CASES)

    @field_validator("contractVersion", mode="before")
    @classmethod
    def _contract_version_is_number(cls, value: object) -> object:
        # `contractVersion` is an integer literal on the wire: reject strings
        # ("1") and booleans, while still accepting every valid JSON number
        # that equals 1 (including 1.0 — 1 vs 1.0 must never become an
        # artificial contract-version mismatch).
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("contractVersion must be the number 1")
        return value

    @model_validator(mode="after")
    def _no_duplicate_case_ids(self) -> EvaluationSuiteInputV1:
        seen: set[str] = set()
        for case in self.cases:
            if case.caseId in seen:
                raise ValueError(f'duplicate caseId: "{case.caseId}"')
            seen.add(case.caseId)
        return self


# ---------------------------------------------------------------------------
# FROZEN v1 check/result shapes.
# ---------------------------------------------------------------------------


class EvaluationCheckV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    passed: bool
    reasonCode: str | None


class EvaluationCaseResultV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: str
    passed: bool
    checks: list[EvaluationCheckV1]


class EvaluationMetricsV1(BaseModel):
    """The frozen pre-Checkpoint-B v1 aggregate-metrics struct — the exact
    Checkpoint-A EvaluationMetrics, restated here so the offline v1 oracle
    owns its own result shape. It carries the six historical ratios and NO
    #59 Checkpoint-B metric fields; the active EvaluationMetrics gains the
    nine new ratios, but this frozen struct must never acquire them.
    """

    model_config = ConfigDict(extra="forbid")
    totalCases: int
    passedCases: int
    failedCases: int
    passRate: float
    retrievalTop1: MetricRatio
    retrievalHitAt3: MetricRatio
    schemaHandlingCorrectness: MetricRatio
    evidenceGroundingCorrectness: MetricRatio
    toolCorrectness: MetricRatio
    expectedStatusCorrectness: MetricRatio
