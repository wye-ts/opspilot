// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): the historical
// v1 ObservedFacts shape, preserved type-only so the offline v1 regression
// oracle can re-score the frozen ts-parity-v1.json fixture. The active
// ObservedFacts (../observed-facts.ts) is the v2 shape — this module is
// unwired from the active runtime and must never change.
//
// This is the EXACT nested v1 cross-language request shape frozen by the
// OpsPilot #61 Revision 3 plan: runStatus/errorCode/retrieval/tools/report,
// nothing else — no investigation, no failedStage, and tools.completed
// entries carry no output.
import type { AgentOrchestratorErrorCode, EvidenceReference, SuggestedAction } from "@opspilot/contracts";
import type { JsonValue } from "../json-value";

export interface RetrievalFactsV1 {
  readonly completed: boolean;
  readonly chunkIds: readonly string[];
}

export interface ToolFactsV1 {
  readonly requested: readonly { readonly toolName: string; readonly toolCallId: string }[];
  readonly executed: readonly { readonly toolName: string; readonly input: JsonValue }[];
  readonly completed: readonly { readonly toolName: string; readonly toolCallId: string }[];
}

export interface ReportFactsV1 {
  readonly evidence: readonly Pick<EvidenceReference, "evidenceId" | "sourceType">[];
  readonly suggestedActionTypes: readonly SuggestedAction["type"][];
}

export type ObservedFactsV1 =
  | {
      readonly runStatus: "completed";
      readonly errorCode: null;
      readonly retrieval: RetrievalFactsV1;
      readonly tools: ToolFactsV1;
      readonly report: ReportFactsV1;
    }
  | {
      readonly runStatus: "failed";
      readonly errorCode: AgentOrchestratorErrorCode;
      readonly retrieval: RetrievalFactsV1;
      readonly tools: ToolFactsV1;
      readonly report: null;
    };
