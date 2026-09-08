import type { FakeAgentScenario } from "@opspilot/agent-runtime";
import type {
  AgentOrchestratorErrorCode,
  ContinuationReason,
  EvidenceLocator,
  EvidenceState,
  InvestigationExecutionStage,
  InvestigationStopReason,
  SuggestedAction,
} from "@opspilot/contracts";
import type { CheckReasonCode } from "./check-reason-codes";
import type { NotApplicableCode } from "./not-applicable-codes";
import type { JsonValue } from "./json-value";
import type { ObservedFacts } from "./observed-facts";

// The runner is the single place that builds a RetrievalInput from a case's
// retrievalQuery; no case may override topK (see docs/07-evaluation-plan.md).
export const EVALUATION_TOP_K = 3;

export type CorpusProfile = "default" | "injection-probe";
export type ToolProfile = "default" | "with-always-fails-tool";

export interface EvaluationCase {
  readonly id: string;
  readonly description: string;
  readonly ticketContext: { readonly ticketId: string; readonly summary: string };
  readonly retrievalQuery: string;
  readonly corpusProfile: CorpusProfile;
  readonly toolProfile: ToolProfile;
  readonly scenario: FakeAgentScenario;
  readonly expectations: EvaluationExpectations;
}

export interface EvaluationExpectations {
  readonly runStatus: "completed" | "failed";

  readonly retrieval?: {
    readonly expectedTop1?: string;
    // "hit@3" — must be non-empty when present (dataset-validation rule 9).
    readonly expectedInTopK?: readonly string[];
    // Mutually exclusive with expectedTop1/expectedInTopK (dataset-validation rule 8).
    readonly expectedNoResults?: true;
    readonly forbiddenChunkIds?: readonly string[];
  };

  readonly tool?: {
    // Observed via the TOOL_REQUESTED trace event. Only fires when lookup and
    // input-schema validation both succeed.
    readonly expectedRequested?: readonly { readonly toolName: string; readonly toolCallId: string }[];

    // Observed via the per-case recording ToolRegistry wrapper, independent of
    // the trace. "Executed" = the wrapped execute() was reached, whether it
    // then succeeded or threw. `input` must be JSON-safe — this crosses the
    // v1 cross-language contract (see json-value.ts).
    readonly expectedExecuted?: readonly { readonly toolName: string; readonly input: JsonValue }[];

    // Observed via the TOOL_COMPLETED trace event, which carries both
    // toolCallId and toolName (confirmed against AgentTraceEvent).
    readonly expectedCompleted?: readonly { readonly toolName: string; readonly toolCallId: string }[];

    readonly forbiddenExecutedToolNames?: readonly string[];
    readonly forbiddenCompletedToolCallIds?: readonly string[];
  };

  readonly report?: {
    // STAGE expectations: pure functions of result.status/result.code. Always
    // evaluable — never require result.report, never "missing." May be
    // declared on either a "completed" or a "failed" case.
    readonly schemaExpectation?: "VALID" | "INVALID";
    readonly groundingExpectation?: "VALID" | "INVALID";

    // PAYLOAD expectations: require an actual result.report, i.e.
    // runStatus: "completed" (dataset-validation rule 6).
    readonly requiredEvidenceTypes?: readonly ("TOOL_EXECUTION" | "RAG_CHUNK")[];
    readonly requiredEvidenceIds?: readonly string[];
    readonly forbiddenEvidenceIds?: readonly string[];
    readonly requiredActionTypes?: readonly SuggestedAction["type"][];
  };

  readonly failure?: {
    readonly expectedCode: AgentOrchestratorErrorCode;
  };

  // Issue #59 Checkpoint B — the nine #59 metric expectation fields (spec
  // §5). Each is consumed by exactly one metric check in
  // evaluation-evaluator.ts; the dataset-validation rules in
  // dataset-validation.ts enforce the cross-field preconditions (e.g. any
  // expectedRootCause requires expectedEvidence with SUFFICIENT state).
  readonly expectedRootCause?: "PRESENT" | "ABSENT";

  readonly expectedEvidence?: {
    readonly state: EvidenceState;
    readonly requiredLocators: readonly EvidenceLocator[];
    readonly requiresTelemetry?: boolean;
    readonly minDistinctLocators?: number;
  };

  readonly expectedTelemetryEvidence?: {
    readonly probative: readonly EvidenceLocator[];
    readonly nonProbative: readonly EvidenceLocator[];
  };

  readonly expectedDiagnostics?: readonly {
    readonly evidenceState: EvidenceState;
    readonly continuationReason: ContinuationReason;
  }[];

  readonly expectedStopReason?: InvestigationStopReason;

  readonly expectedConfidence?: { readonly min: number; readonly max: number };

  readonly expectedActions?: readonly {
    readonly type: SuggestedAction["type"];
    readonly requiredGrounding: readonly EvidenceLocator[];
    readonly allowedGrounding: readonly EvidenceLocator[];
  }[];

  readonly expectedApproval?: "ELIGIBLE" | "NOT_ELIGIBLE";

  readonly expectedBounds?: { readonly maxTotalTokens?: number };

  readonly expectedRecovery?: {
    readonly failedStage: InvestigationExecutionStage;
    readonly forbiddenCompletedToolCallIds?: readonly string[];
    readonly reportProduced: boolean;
  };
}

// The v2 three-state check status (see v2-types.ts's EvaluationCheckV2). At
// Checkpoint A the active scorer emits PASS/FAIL only; NOT_APPLICABLE is
// structurally supported but never emitted yet.
export type EvaluationCheckStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";

export interface EvaluationCheckResult {
  readonly name: string;
  readonly status: EvaluationCheckStatus;
  readonly expected: unknown;
  readonly observed: unknown;
  // A closed application-authored reason code, never raw prose (see
  // check-reason-codes.ts / not-applicable-codes.ts). Present iff
  // status !== "PASS"; a FAIL check carries a CheckReasonCode and a
  // NOT_APPLICABLE check carries a NotApplicableCode.
  readonly reasonCode?: CheckReasonCode | NotApplicableCode;
}

// TS-internal only: retains ObservedFacts and each check's expected/observed
// for local debugging/tests. The cross-language wire result
// (EvaluationCaseResultV2 in v2-types.ts) is derived from this but strips
// both (see toEvaluationCaseResultV2). A case passes iff no check has
// status === "FAIL".
export interface EvaluationCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckResult[];
  readonly observed: ObservedFacts;
}

export interface EvaluationMetrics {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly passRate: number;

  readonly retrievalTop1: { readonly numerator: number; readonly denominator: number };
  readonly retrievalHitAt3: { readonly numerator: number; readonly denominator: number };
  readonly schemaHandlingCorrectness: { readonly numerator: number; readonly denominator: number };
  readonly evidenceGroundingCorrectness: { readonly numerator: number; readonly denominator: number };
  readonly toolCorrectness: { readonly numerator: number; readonly denominator: number };
  readonly expectedStatusCorrectness: { readonly numerator: number; readonly denominator: number };

  // Issue #59 Checkpoint B — the nine #59 metric ratios (spec §5/§11). Same
  // { numerator, denominator } wire shape as the six above (the DB
  // evaluation_metrics table carries no na_count column — see the Checkpoint
  // B design decision); N/A counts are derived by the formatter from each
  // case's check results by metric check name.
  readonly rootCauseDiscipline: { readonly numerator: number; readonly denominator: number };
  readonly evidenceSupport: { readonly numerator: number; readonly denominator: number };
  readonly unknownHandling: { readonly numerator: number; readonly denominator: number };
  readonly diagnosticJustification: { readonly numerator: number; readonly denominator: number };
  readonly confidenceCalibration: { readonly numerator: number; readonly denominator: number };
  readonly actionGrounding: { readonly numerator: number; readonly denominator: number };
  readonly approvalGate: { readonly numerator: number; readonly denominator: number };
  readonly boundsRespected: { readonly numerator: number; readonly denominator: number };
  readonly deterministicRecovery: { readonly numerator: number; readonly denominator: number };

  // Milestone 13 Issue B (#75) — retrieval-quality metrics, PRECOMPUTED
  // against runbooks-eval/retrieval-query-set.json by
  // runbooks-eval/score-query-set.ts and passed through unchanged by both
  // scorers. NOT derived from this run's own EvaluationCaseResultV2 checks
  // (see the plan's decision gate, docs/reviews/29-...-plan.md §0/§2.2).
  //
  // A future reader must not assume these update per-run the way the fifteen
  // ratios above do: they change when the CORPUS or the QUERY SET changes
  // (tracked by retrievalQualityProvenance.corpusContentHash), not when a
  // different case suite runs.
  //
  // All four sub-metrics use the same { numerator, denominator } MetricRatio
  // shape as every other field here — meanReciprocalRank is deliberately NOT a
  // bare float. Because EVALUATION_TOP_K = 3 bounds every reciprocal rank to
  // {1, 1/2, 1/3, 0}, it is encoded in SIXTHS as exact integers (6/3/2/0 per
  // query, denominator = queryCount * 6): a float mean converted back via
  // round(mean * denominator) is lossy and diverges by language at exact tie
  // points (Python banker's rounding vs. JS round-half-up), which would defeat
  // the cross-service parity guarantee this schema exists to provide.
  //
  // recall@k/MRR are computed for exact/paraphrase/nearMiss only —
  // both are undefined for a true_negative query, which has no correct answer;
  // falsePositiveRate is the true_negative group's own metric.
  readonly recallAtK: {
    readonly exact: { readonly numerator: number; readonly denominator: number };
    readonly paraphrase: { readonly numerator: number; readonly denominator: number };
    readonly nearMiss: { readonly numerator: number; readonly denominator: number };
  };
  readonly meanReciprocalRank: {
    readonly exact: { readonly numerator: number; readonly denominator: number };
    readonly paraphrase: { readonly numerator: number; readonly denominator: number };
    readonly nearMiss: { readonly numerator: number; readonly denominator: number };
  };
  readonly falsePositiveRate: { readonly numerator: number; readonly denominator: number };

  // Nullable provenance sibling: non-null iff the three fields above were
  // populated from a real retrieval-quality run rather than left at the
  // zero-default. Without it, two persisted runs — one scored against the
  // keyword retriever, one against BM25 — would be indistinguishable once the
  // originating request context is gone.
  readonly retrievalQualityProvenance: {
    readonly retrieverName: string;
    readonly corpusContentHash: string;
  } | null;
}

// The zero-ratio default used for the four Milestone-13 fields on an ordinary
// case-only run (no retrievalQualityMetrics input). 0/0 means "not evaluated",
// distinct from 0/N which means "evaluated, scored zero" — the same
// distinction the #59 generation's read path already relies on.
export const ZERO_RETRIEVAL_QUALITY_METRICS: Pick<
  EvaluationMetrics,
  "recallAtK" | "meanReciprocalRank" | "falsePositiveRate" | "retrievalQualityProvenance"
> = {
  recallAtK: {
    exact: { numerator: 0, denominator: 0 },
    paraphrase: { numerator: 0, denominator: 0 },
    nearMiss: { numerator: 0, denominator: 0 },
  },
  meanReciprocalRank: {
    exact: { numerator: 0, denominator: 0 },
    paraphrase: { numerator: 0, denominator: 0 },
    nearMiss: { numerator: 0, denominator: 0 },
  },
  falsePositiveRate: { numerator: 0, denominator: 0 },
  retrievalQualityProvenance: null,
};
