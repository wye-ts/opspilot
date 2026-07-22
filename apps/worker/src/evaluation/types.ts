import type { AgentOrchestratorErrorCode, SuggestedAction } from "@opspilot/contracts";

import type { FakeAgentScenario } from "../providers/fake-llm-provider";

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
    // then succeeded or threw.
    readonly expectedExecuted?: readonly { readonly toolName: string; readonly input: unknown }[];

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
}

export interface EvaluationCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly reason?: string;
}

export interface EvaluationCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckResult[];
  readonly observed: {
    readonly runStatus: "completed" | "failed";
    readonly retrievalCompletedObserved: boolean;
    readonly retrievedChunkIds: readonly string[];
    readonly requestedTools: readonly { readonly toolName: string; readonly toolCallId: string }[];
    readonly executedTools: readonly { readonly toolName: string; readonly input: unknown }[];
    readonly completedToolCallIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly errorCode?: AgentOrchestratorErrorCode;
  };
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
}
