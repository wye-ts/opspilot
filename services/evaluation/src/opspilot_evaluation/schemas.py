"""Pydantic v2 models for the active v2 evaluation contract.

Mirrors, field-for-field, the TypeScript source of truth:
  - apps/worker/src/evaluation/v2-types.ts      (EvaluationSuiteInputV2 / V2 result shapes)
  - apps/worker/src/evaluation/types.ts         (EvaluationExpectations / EvaluationMetrics)
  - apps/worker/src/evaluation/observed-facts.ts (ObservedFacts discriminated union, v2)
  - apps/worker/src/evaluation/json-value.ts    (JsonValue + the JSON-safety invariants)
  - packages/contracts/src/agent-orchestrator.ts (AgentOrchestratorErrorCode)
  - packages/contracts/src/resolution-report.ts  (EvidenceReference.sourceType,
                                                   SuggestedAction.type, category,
                                                   recommendationDisposition)
  - packages/contracts/src/evidence-assessment.ts (EvidenceAssessment)
  - packages/contracts/src/evidence.ts           (EvidenceLocator)
  - packages/contracts/src/investigation-event.ts (ToolFailureCode)
  - packages/contracts/src/investigation-execution-stage.ts (InvestigationExecutionStage)

One deliberate exception: `EvaluationRunResultV2` (the POST/GET /evaluations
response body) is the persisted HTTP evaluation *resource*, not a byte-for-
byte mirror of TS's `EvaluationSuiteResultV2` scorer-result type — it adds
the persisted `id`. See the comment above that class.

The frozen v1 contract has moved, byte-for-byte, into the unwired
`opspilot_evaluation.legacy_v1` package (the offline oracle for
ts-parity-v1.json); the active service accepts contractVersion 2 only
(OpsPilot #59 Checkpoint A §5/§6).

Every model uses extra="forbid" so a malformed/contradictory wire shape is
rejected by Pydantic itself rather than silently coerced (see the Phase 2
task spec, "Request constraints").
"""

from __future__ import annotations

import math
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, Strict, field_validator, model_validator

MAX_CASES = 200

# ---------------------------------------------------------------------------
# Strict per-field markers for request-side primitive fields (see the "Strict
# Pydantic request typing" fix). Pydantic's lax mode coerces wrong primitives
# ("false" -> False, 1 -> True, 123 -> "123"); the v2 contract requires
# the wire types to be rejected instead, so every str/bool/list[str] request
# field is marked strict. Enum and Literal[enum] fields are deliberately left
# lax: their closed membership already rejects wrong primitives (a number can
# only coerce to a non-member string), and pydantic strict mode would reject
# the wire's plain string values ("completed", "RAG_CHUNK", ...). JsonValue
# needs no strict marker — the smart union already preserves each JSON
# primitive exactly (1 stays int, 1.0 stays float, "true" stays str), which is
# what keeps `1` vs `1.0` from ever becoming an artificial scorer mismatch.
# ---------------------------------------------------------------------------

_StrictStr = Annotated[str, Strict()]
_StrictBool = Annotated[bool, Strict()]
_StrictStrList = Annotated[list[_StrictStr], Strict()]

# ---------------------------------------------------------------------------
# JsonValue — mirrors json-value.ts's toJsonValue() invariants that still
# apply once a value has already survived JSON parsing: Python's JSON parser
# (unlike JavaScript's) accepts the non-standard "NaN"/"Infinity"/"-Infinity"
# tokens, and PostgreSQL JSONB round-trips finite values only, so non-finite
# numbers are rejected explicitly. Sparse arrays, `undefined`, BigInt, and
# prototype-pollution keys (Date, Map, __proto__ shadowing) are all
# impossible to construct via JSON parsing at all, so no separate check is
# needed for those traps on this side of the wire.
# ---------------------------------------------------------------------------

# PEP 695 `type` statement, not a plain `Union[...]` assignment: pydantic
# resolves a self-referential alias defined this way without runaway
# recursion during schema generation, which a bare forward-ref Union does not.
type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


class NonJsonSafeValueError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(f"value is not JSON-safe: {reason}")


def assert_json_safe(value: object) -> None:
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise NonJsonSafeValueError(f"non-finite number ({value})")
        return
    if isinstance(value, list):
        for item in value:
            assert_json_safe(item)
        return
    if isinstance(value, dict):
        for item in value.values():
            assert_json_safe(item)
        return
    raise NonJsonSafeValueError(f"unsupported type {type(value).__name__}")


# ---------------------------------------------------------------------------
# Closed enums
# ---------------------------------------------------------------------------


class RunStatus(StrEnum):
    completed = "completed"
    failed = "failed"


# The narrower subset actually produced by the orchestrator, mirrored
# byte-for-byte from packages/contracts/src/agent-orchestrator.ts.
class ErrorCode(StrEnum):
    RETRIEVAL_PARAMS_INVALID = "RETRIEVAL_PARAMS_INVALID"
    RETRIEVAL_FAILED = "RETRIEVAL_FAILED"
    RETRIEVAL_RESPONSE_INVALID = "RETRIEVAL_RESPONSE_INVALID"
    TOOL_NOT_FOUND = "TOOL_NOT_FOUND"
    TOOL_INPUT_INVALID = "TOOL_INPUT_INVALID"
    TOOL_OUTPUT_INVALID = "TOOL_OUTPUT_INVALID"
    TOOL_EXECUTION_FAILED = "TOOL_EXECUTION_FAILED"
    REPORT_SCHEMA_INVALID = "REPORT_SCHEMA_INVALID"
    REPORT_EVIDENCE_INVALID = "REPORT_EVIDENCE_INVALID"
    PROVIDER_PROTOCOL_INVALID = "PROVIDER_PROTOCOL_INVALID"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
    PROVIDER_CANCELLED = "PROVIDER_CANCELLED"


class EvidenceSourceType(StrEnum):
    RAG_CHUNK = "RAG_CHUNK"
    TOOL_EXECUTION = "TOOL_EXECUTION"


# Mirrors SuggestedAction["type"] from packages/contracts/src/resolution-report.ts.
class ActionType(StrEnum):
    UPDATE_TICKET_STATUS = "UPDATE_TICKET_STATUS"
    CREATE_ESCALATION = "CREATE_ESCALATION"
    DRAFT_CUSTOMER_REPLY = "DRAFT_CUSTOMER_REPLY"


class SchemaOrGroundingExpectation(StrEnum):
    VALID = "VALID"
    INVALID = "INVALID"


# The v2 three-state check status (OpsPilot #59 Checkpoint A §3). Mirrors
# types.ts's EvaluationCheckStatus. At Checkpoint A the active scorer emits
# PASS/FAIL only; NOT_APPLICABLE is structurally supported but never emitted.
class CheckStatus(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"
    NOT_APPLICABLE = "NOT_APPLICABLE"


# v2 observed-facts additions — mirrored from the closed vocabularies in
# packages/contracts (IncidentCategory / RecommendationDisposition from
# resolution-report.ts, EvidenceState from evidence-assessment.ts,
# InvestigationExecutionStage from investigation-execution-stage.ts,
# ToolFailureCode from investigation-event.ts).
class IncidentCategory(StrEnum):
    SERVICE_DEGRADATION = "SERVICE_DEGRADATION"
    RATE_LIMITING = "RATE_LIMITING"
    AUTHENTICATION = "AUTHENTICATION"
    CONFIGURATION = "CONFIGURATION"
    DATA_QUALITY = "DATA_QUALITY"
    UNKNOWN = "UNKNOWN"


class EvidenceState(StrEnum):
    SUFFICIENT = "SUFFICIENT"
    INSUFFICIENT = "INSUFFICIENT"
    CONFLICTING = "CONFLICTING"


class RecommendationDisposition(StrEnum):
    ACTIONABLE = "ACTIONABLE"
    ADVISORY = "ADVISORY"


class InvestigationExecutionStage(StrEnum):
    INVESTIGATION_CREATED = "INVESTIGATION_CREATED"
    AGENT_ANALYSIS = "AGENT_ANALYSIS"
    DIAGNOSTIC_EXECUTION = "DIAGNOSTIC_EXECUTION"
    REPORT_GENERATION = "REPORT_GENERATION"


class InvestigationStopReason(StrEnum):
    SUFFICIENT_EVIDENCE = "SUFFICIENT_EVIDENCE"
    NO_JUSTIFIED_DIAGNOSTIC = "NO_JUSTIFIED_DIAGNOSTIC"
    BOUND_EXHAUSTED = "BOUND_EXHAUSTED"


class ContinuationReason(StrEnum):
    NO_EVIDENCE_YET = "NO_EVIDENCE_YET"
    STATUS_UNRESOLVED = "STATUS_UNRESOLVED"
    SCOPE_NOT_COVERED = "SCOPE_NOT_COVERED"
    CONFLICT_UNRESOLVED = "CONFLICT_UNRESOLVED"


class ToolFailureCode(StrEnum):
    TOOL_NOT_FOUND = "TOOL_NOT_FOUND"
    TOOL_INPUT_INVALID = "TOOL_INPUT_INVALID"
    TOOL_EXECUTION_FAILED = "TOOL_EXECUTION_FAILED"
    TOOL_OUTPUT_INVALID = "TOOL_OUTPUT_INVALID"


# ---------------------------------------------------------------------------
# Shared entry shapes (requested/executed/completed tool calls, evidence)
# ---------------------------------------------------------------------------


class ToolRequestedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolName: _StrictStr
    toolCallId: _StrictStr


class ToolExecutedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolName: _StrictStr
    input: JsonValue

    @field_validator("input")
    @classmethod
    def _input_is_json_safe(cls, value: JsonValue) -> JsonValue:
        assert_json_safe(value)
        return value


class ToolCompletedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolName: _StrictStr
    toolCallId: _StrictStr
    # v2 (OpsPilot #59 Checkpoint A §4.3/§4.4): the normalized JSON-safe output
    # of the successful execution that produced the TOOL_COMPLETED event.
    # Never fabricated for a failed/terminal execution.
    output: JsonValue

    @field_validator("output")
    @classmethod
    def _output_is_json_safe(cls, value: JsonValue) -> JsonValue:
        assert_json_safe(value)
        return value


class ToolCompletedExpectationEntry(BaseModel):
    """Expectation-side completed tool call — mirrors types.ts's inline
    expectedCompleted entry (`{ toolName, toolCallId }`), which carries NO
    output: output is observed-only (on tools.completed), and the evaluator
    compares completed calls purely by toolCallId presence.
    """

    model_config = ConfigDict(extra="forbid")
    toolName: _StrictStr
    toolCallId: _StrictStr


class EvidenceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidenceId: _StrictStr
    sourceType: EvidenceSourceType


# ---------------------------------------------------------------------------
# v2 observed-facts additions (OpsPilot #59 Checkpoint A §4.4): the
# Milestone-11 observation facts carried by both ObservedFacts branches.
# ---------------------------------------------------------------------------


class EvidenceLocator(BaseModel):
    """A low-level (sourceType, evidenceId) pair — mirrors EvidenceLocator
    from packages/contracts/src/evidence.ts."""

    model_config = ConfigDict(extra="forbid")
    evidenceId: _StrictStr
    sourceType: EvidenceSourceType


class EvidenceAssessment(BaseModel):
    """The validated continuation assessment recorded on a TOOL_REQUESTED event.

    Mirrors EvidenceAssessment from packages/contracts/src/evidence-assessment.ts
    structurally. The cross-field invariants that schema enforces with its
    superRefine (SUFFICIENT may not accompany a request, locator distinctness,
    CONFLICTING requires >= 2 locators, NO_EVIDENCE_YET requires zero locators)
    are producer-side: the orchestrator already validated them before emitting
    the event. No active Checkpoint-A check consumes assessment semantics, so
    this side deliberately re-imposes only the structural shape (closed enums,
    bounded cardinality), not the cross-field rules — those arrive with
    Checkpoint B's assessment-driven checks.
    """

    model_config = ConfigDict(extra="forbid")
    evidenceState: EvidenceState
    continuationReason: ContinuationReason
    supportedBy: list[EvidenceLocator] = Field(max_length=10)


class AssessmentFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolCallId: _StrictStr
    toolName: _StrictStr
    assessment: EvidenceAssessment


class ToolFailureFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    toolCallId: _StrictStr
    toolName: _StrictStr
    failureCode: ToolFailureCode


class InvestigationBounds(BaseModel):
    model_config = ConfigDict(extra="forbid")
    maxProviderTurns: int
    maxDiagnosticToolCalls: int


class InvestigationUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputTokens: int
    outputTokens: int
    providerCalls: int


class InvestigationFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    providerTurnsUsed: int
    diagnosticRequestCount: int
    forcedFinalization: _StrictBool
    stopReason: InvestigationStopReason | None
    assessments: list[AssessmentFacts]
    toolFailures: list[ToolFailureFacts]
    bounds: InvestigationBounds
    usage: InvestigationUsage


# ---------------------------------------------------------------------------
# EvaluationExpectations — mirrors types.ts's EvaluationExpectations
#
# Every field below is TS `T | undefined` (an optional key), never `T | null`
# — so omission is the only accepted way to skip it. A `field_validator(...,
# mode="before")` only runs when the key is actually present in the input
# (Pydantic does not validate defaults), so it rejects explicit `null` while
# leaving omission to fall through to the field's `None` default untouched.
# ---------------------------------------------------------------------------


def _reject_explicit_null(*field_names: str) -> Any:
    def _validator(cls: type[BaseModel], value: Any) -> Any:
        if value is None:
            raise ValueError("explicit null is not accepted for this optional field; omit it instead")
        return value

    return field_validator(*field_names, mode="before")(_validator)


class RetrievalExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedTop1: _StrictStr | None = None
    expectedInTopK: _StrictStrList | None = None
    expectedNoResults: Literal[True] | None = None
    forbiddenChunkIds: _StrictStrList | None = None

    _reject_null_fields = _reject_explicit_null(
        "expectedTop1", "expectedInTopK", "expectedNoResults", "forbiddenChunkIds"
    )

    @field_validator("expectedNoResults", mode="before")
    @classmethod
    def _expected_no_results_is_boolean(cls, value: object) -> object:
        # Boolean-only field: reject the coercible 0/1 and "true"/"false"
        # forms that pydantic's Literal[True] would otherwise accept.
        if value is not None and not isinstance(value, bool):
            raise ValueError("expectedNoResults must be a boolean")
        return value


class ToolExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedRequested: list[ToolRequestedEntry] | None = None
    expectedExecuted: list[ToolExecutedEntry] | None = None
    expectedCompleted: list[ToolCompletedExpectationEntry] | None = None
    forbiddenExecutedToolNames: _StrictStrList | None = None
    forbiddenCompletedToolCallIds: _StrictStrList | None = None

    _reject_null_fields = _reject_explicit_null(
        "expectedRequested",
        "expectedExecuted",
        "expectedCompleted",
        "forbiddenExecutedToolNames",
        "forbiddenCompletedToolCallIds",
    )


class ReportExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaExpectation: SchemaOrGroundingExpectation | None = None
    groundingExpectation: SchemaOrGroundingExpectation | None = None
    requiredEvidenceTypes: list[EvidenceSourceType] | None = None
    requiredEvidenceIds: _StrictStrList | None = None
    forbiddenEvidenceIds: _StrictStrList | None = None
    requiredActionTypes: list[ActionType] | None = None

    _reject_null_fields = _reject_explicit_null(
        "schemaExpectation",
        "groundingExpectation",
        "requiredEvidenceTypes",
        "requiredEvidenceIds",
        "forbiddenEvidenceIds",
        "requiredActionTypes",
    )


class FailureExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedCode: ErrorCode


class EvaluationExpectations(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runStatus: RunStatus
    retrieval: RetrievalExpectations | None = None
    tool: ToolExpectations | None = None
    report: ReportExpectations | None = None
    failure: FailureExpectations | None = None

    _reject_null_fields = _reject_explicit_null("retrieval", "tool", "report", "failure")


# ---------------------------------------------------------------------------
# ObservedFacts — mirrors observed-facts.ts's discriminated union exactly.
# runStatus "completed" requires errorCode: null and a non-null report;
# runStatus "failed" requires a non-null errorCode and report: null. Pydantic
# rejects any wire body that contradicts this pairing (see the "malformed
# contradictory completed/failed shapes rejected by Pydantic" requirement).
# v2 adds `investigation` to BOTH branches and `failedStage` (null on a
# completed run, the failed stage on a failed run), and extends
# tools.completed[].output and the completed report fields.
# ---------------------------------------------------------------------------


class RetrievalFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    completed: _StrictBool
    chunkIds: _StrictStrList


class ToolFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requested: list[ToolRequestedEntry]
    executed: list[ToolExecutedEntry]
    completed: list[ToolCompletedEntry]


class SuggestedActionFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: ActionType
    groundedBy: list[EvidenceLocator]


class ReportFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidence: list[EvidenceEntry]
    suggestedActionTypes: list[ActionType]
    # v2 additions (OpsPilot #59 Checkpoint A §4.4): structured report metadata
    # only — never report prose (no rootCause text, summary text, or action
    # payload prose crosses the evaluation boundary for #59).
    category: IncidentCategory
    rootCausePresent: _StrictBool
    confidence: float
    evidenceState: EvidenceState
    recommendationDisposition: RecommendationDisposition
    suggestedActions: list[SuggestedActionFacts]


class ObservedFactsCompleted(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runStatus: Literal[RunStatus.completed]
    errorCode: None = None
    retrieval: RetrievalFacts
    tools: ToolFacts
    report: ReportFacts
    investigation: InvestigationFacts
    failedStage: None = None


class ObservedFactsFailed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runStatus: Literal[RunStatus.failed]
    errorCode: ErrorCode
    retrieval: RetrievalFacts
    tools: ToolFacts
    report: None = None
    investigation: InvestigationFacts
    failedStage: InvestigationExecutionStage


ObservedFacts = Annotated[
    ObservedFactsCompleted | ObservedFactsFailed,
    Field(discriminator="runStatus"),
]


# ---------------------------------------------------------------------------
# Suite-level request — mirrors v2-types.ts's EvaluationCaseInputV2 / EvaluationSuiteInputV2
# ---------------------------------------------------------------------------


class EvaluationCaseInputV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: _StrictStr = Field(min_length=1, max_length=128)
    expectations: EvaluationExpectations
    observed: ObservedFacts


class EvaluationSuiteInputV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contractVersion: Literal[2]
    datasetId: _StrictStr = Field(min_length=1)
    cases: list[EvaluationCaseInputV2] = Field(min_length=1, max_length=MAX_CASES)

    @field_validator("contractVersion", mode="before")
    @classmethod
    def _contract_version_is_number(cls, value: object) -> object:
        # `contractVersion` is an integer literal on the wire: reject strings
        # ("2") and booleans, while still accepting every valid JSON number
        # that equals 2 (including 2.0 — 2 vs 2.0 must never become an
        # artificial contract-version mismatch).
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("contractVersion must be the number 2")
        return value

    @model_validator(mode="after")
    def _no_duplicate_case_ids(self) -> EvaluationSuiteInputV2:
        seen: set[str] = set()
        for case in self.cases:
            if case.caseId in seen:
                raise ValueError(f'duplicate caseId: "{case.caseId}"')
            seen.add(case.caseId)
        return self


# ---------------------------------------------------------------------------
# Suite-level result.
#
# EvaluationCheckV2 and EvaluationCaseResultV2 below mirror v2-types.ts's
# same-named types field-for-field: they are the deterministic scorer/parity
# shape, exercised directly (no HTTP, no `id`) in test_scorer_parity.py's
# parity-oracle comparisons against the TS-owned fixture. Never echoes
# per-check expected/observed values (those are TS-internal-only). The
# three-state status/reason pairing is enforced at CheckOutcome construction
# in scorer.py (a PASS check has no reason code; a FAIL carries a
# CheckReasonCode; a NOT_APPLICABLE carries a NotApplicableCode).
#
# EvaluationRunResultV2, by contrast, is deliberately NOT a byte-for-byte
# mirror of TS's `EvaluationSuiteResultV2` — it is the persisted HTTP
# evaluation *resource* that POST/GET /evaluations return (see the task
# spec's "GET /evaluations/{id}" and "At suite level return: ... persisted
# evaluation id ..."), a superset that adds the persisted `id` on top of the
# TS scorer-result fields. Do not rename this back to `EvaluationSuiteResultV2`
# — that name already belongs to the narrower TS parity type and reusing it
# here previously implied an exact-mirror guarantee this model does not make.
# ---------------------------------------------------------------------------


class EvaluationCheckV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    status: CheckStatus
    reasonCode: str | None


class EvaluationCaseResultV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: str
    passed: bool
    checks: list[EvaluationCheckV2]


class MetricRatio(BaseModel):
    model_config = ConfigDict(extra="forbid")
    numerator: int
    denominator: int


class EvaluationMetrics(BaseModel):
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


class EvaluationRunResultV2(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contractVersion: Literal[2]
    datasetId: str
    id: str
    cases: list[EvaluationCaseResultV2]
    metrics: EvaluationMetrics
