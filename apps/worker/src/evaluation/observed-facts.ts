import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { AgentOrchestratorErrorCode, EvidenceReference, SuggestedAction } from "@opspilot/contracts";
import { toJsonValue, type JsonValue } from "./json-value";
import type { RecordedToolExecution } from "./recording-tool-registry";

interface RetrievalFacts {
  readonly completed: boolean;
  readonly chunkIds: readonly string[];
}

interface ToolFacts {
  readonly requested: readonly { readonly toolName: string; readonly toolCallId: string }[];
  readonly executed: readonly { readonly toolName: string; readonly input: JsonValue }[];
  readonly completed: readonly { readonly toolName: string; readonly toolCallId: string }[];
}

interface ReportFacts {
  readonly evidence: readonly Pick<EvidenceReference, "evidenceId" | "sourceType">[];
  readonly suggestedActionTypes: readonly SuggestedAction["type"][];
}

// The normalized fact set every scoring function operates on — and, as of
// the HQ final contract-shape correction, the EXACT nested v1 cross-language
// request shape frozen by Revision 3 (see v1-types.ts's
// EvaluationCaseInputV1.observed). There is deliberately only ONE canonical
// type used by buildObservedFacts, EvaluationCaseInputV1.observed,
// LocalEvaluationScorer, the parity fixture, and (later) the FastAPI
// request body — never a separate flat scorer shape plus a separate nested
// wire shape.
//
// A discriminated union, not three independent fields — this is a fix for
// an independent-review finding that the prior flat-field shape let
// TypeScript construct a contradictory state
// (runStatus: "completed", errorCode: null, report: null) that could score
// as a false pass. runStatus is now tied to errorCode/report so that state
// is unrepresentable at the type level; buildObservedFacts is the only
// function that constructs either variant. (Runtime enforcement of this
// invariant against untrusted/malformed JSON — e.g. from a future Python
// caller — is Phase 2 territory; Phase 1 closes the TypeScript-side hole.)
//
// buildObservedFacts is the ONLY function in this package allowed to know
// about AgentOrchestratorResult, raw trace events, the recording
// tool-registry output, or ResolutionReport structure — every scoring
// function downstream operates only on ObservedFacts + EvaluationExpectations.
export type ObservedFacts =
  | {
      readonly runStatus: "completed";
      readonly errorCode: null;
      readonly retrieval: RetrievalFacts;
      readonly tools: ToolFacts;
      readonly report: ReportFacts;
    }
  | {
      readonly runStatus: "failed";
      readonly errorCode: AgentOrchestratorErrorCode;
      readonly retrieval: RetrievalFacts;
      readonly tools: ToolFacts;
      readonly report: null;
    };

// Pure normalization boundary: turns a raw AgentOrchestratorResult plus the
// per-case tool recorder into ObservedFacts, with no scoring/verdict logic
// of its own. Deliberately never copies report prose, raw provider
// payloads, or the whole trace across the boundary — only the specific
// fields scoring needs, in the exact nested shape the future FastAPI
// request will use.
//
// Tool-execution inputs are validated/deep-copied through toJsonValue() here
// — the recorder's raw `unknown` input never crosses into ObservedFacts
// unchanged. A non-JSON-safe recorded input (e.g. a BigInt argument) throws
// NonJsonSafeValueError at this boundary rather than silently scoring a
// pass and failing later, invisibly, at JSON.stringify time.
export function buildObservedFacts(
  agentResult: AgentOrchestratorResult,
  executedTools: readonly RecordedToolExecution[],
): ObservedFacts {
  const retrievalEvent = agentResult.trace.find((event) => event.type === "RETRIEVAL_COMPLETED");
  const retrieval: RetrievalFacts = {
    completed: retrievalEvent !== undefined,
    chunkIds:
      retrievalEvent?.type === "RETRIEVAL_COMPLETED" ? retrievalEvent.chunks.map((chunk) => chunk.chunkId) : [],
  };

  const requested = agentResult.trace
    .filter((event): event is Extract<typeof event, { type: "TOOL_REQUESTED" }> => event.type === "TOOL_REQUESTED")
    .map((event) => ({ toolName: event.toolName, toolCallId: event.toolCallId }));

  const completedTools = agentResult.trace
    .filter((event): event is Extract<typeof event, { type: "TOOL_COMPLETED" }> => event.type === "TOOL_COMPLETED")
    .map((event) => ({ toolName: event.toolName, toolCallId: event.toolCallId }));

  const tools: ToolFacts = {
    requested,
    executed: executedTools.map((entry) => ({
      toolName: entry.toolName,
      input: toJsonValue(entry.input, `tools.executed[toolName=${entry.toolName}].input`),
    })),
    completed: completedTools,
  };

  if (agentResult.status === "completed") {
    return {
      runStatus: "completed",
      errorCode: null,
      retrieval,
      tools,
      report: {
        evidence: agentResult.report.evidence.map((entry) => ({
          evidenceId: entry.evidenceId,
          sourceType: entry.sourceType,
        })),
        suggestedActionTypes: agentResult.report.suggestedActions.map((action) => action.type),
      },
    };
  }

  return {
    runStatus: "failed",
    errorCode: agentResult.code,
    retrieval,
    tools,
    report: null,
  };
}
