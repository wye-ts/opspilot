import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import {
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  deriveInvestigationStopReason,
  type AgentOrchestratorErrorCode,
  type EvidenceAssessment,
  type EvidenceLocator,
  type EvidenceReference,
  type EvidenceState,
  type IncidentCategory,
  type InvestigationEventPayload,
  type InvestigationExecutionStage,
  type InvestigationStopReason,
  type RecommendationDisposition,
  type SuggestedAction,
  type ToolFailureCode,
} from "@opspilot/contracts";
import { toJsonValue, type JsonValue } from "./json-value";
import type { RecordedProviderTurn } from "./recording-provider";
import type { RecordedToolExecution } from "./recording-tool-registry";

interface RetrievalFacts {
  readonly completed: boolean;
  readonly chunkIds: readonly string[];
}

interface ToolFacts {
  readonly requested: readonly { readonly toolName: string; readonly toolCallId: string }[];
  readonly executed: readonly { readonly toolName: string; readonly input: JsonValue }[];
  // A completed tool call also carries the normalized JSON-safe output of the
  // successful execution that produced the TOOL_COMPLETED event (OpsPilot
  // #59 Checkpoint A §4.3/§4.4). Failed executions are never fabricated into
  // completed entries (see the executed/output pairing below).
  readonly completed: readonly { readonly toolName: string; readonly toolCallId: string; readonly output: JsonValue }[];
}

interface ReportFacts {
  readonly evidence: readonly Pick<EvidenceReference, "evidenceId" | "sourceType">[];
  readonly suggestedActionTypes: readonly SuggestedAction["type"][];
  // v2 additions (OpsPilot #59 Checkpoint A §4.4): structured report
  // metadata only — never report prose (no rootCause text, summary text, or
  // action payload prose crosses the evaluation boundary for #59).
  readonly category: IncidentCategory;
  readonly rootCausePresent: boolean;
  readonly confidence: number;
  readonly evidenceState: EvidenceState;
  readonly recommendationDisposition: RecommendationDisposition;
  readonly suggestedActions: readonly {
    readonly type: SuggestedAction["type"];
    readonly groundedBy: readonly EvidenceLocator[];
  }[];
}

interface InvestigationFacts {
  readonly providerTurnsUsed: number;
  readonly diagnosticRequestCount: number;
  readonly forcedFinalization: boolean;
  readonly stopReason: InvestigationStopReason | null;
  // Ordered diagnostic assessments, in canonical TOOL_REQUESTED event order
  // (OpsPilot #59 Checkpoint A §4.1): the validated continuation assessment
  // that accompanied each accepted diagnostic request.
  readonly assessments: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly assessment: EvidenceAssessment;
  }[];
  readonly toolFailures: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly failureCode: ToolFailureCode;
  }[];
  readonly bounds: {
    readonly maxProviderTurns: number;
    readonly maxDiagnosticToolCalls: number;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly providerCalls: number;
  };
}

// The normalized fact set every scoring function operates on — the exact
// nested v2 cross-language request shape frozen by the OpsPilot #59 Revision
// 5 plan (see v2-types.ts's EvaluationCaseInputV2.observed). There is
// deliberately only ONE canonical type used by buildObservedFacts,
// EvaluationCaseInputV2.observed, LocalEvaluationScorer, the parity fixture,
// and the FastAPI request body — never a separate flat scorer shape plus a
// separate nested wire shape.
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
// v2 adds `investigation` (Milestone-11 observation facts, §4.4) and
// `failedStage` to BOTH branches, and extends tools.completed[].output and
// the completed report fields.
//
// buildObservedFacts is the ONLY function in this package allowed to know
// about AgentOrchestratorResult, raw trace events, the recording
// tool-registry output, the lifecycle-event collector, the recording
// provider, or ResolutionReport structure — every scoring function
// downstream operates only on ObservedFacts + EvaluationExpectations.
export type ObservedFacts =
  | {
      readonly runStatus: "completed";
      readonly errorCode: null;
      readonly retrieval: RetrievalFacts;
      readonly tools: ToolFacts;
      readonly report: ReportFacts;
      readonly investigation: InvestigationFacts;
      readonly failedStage: null;
    }
  | {
      readonly runStatus: "failed";
      readonly errorCode: AgentOrchestratorErrorCode;
      readonly retrieval: RetrievalFacts;
      readonly tools: ToolFacts;
      readonly report: null;
      readonly investigation: InvestigationFacts;
      readonly failedStage: InvestigationExecutionStage;
    };

// Pure normalization boundary: turns a raw AgentOrchestratorResult plus the
// per-case tool recorder, lifecycle-event collector, and recording provider
// into ObservedFacts, with no scoring/verdict logic of its own. Deliberately
// never copies report prose, raw provider payloads, or the whole trace across
// the boundary — only the specific fields scoring needs, in the exact nested
// shape the FastAPI request will use.
//
// The three additive observation inputs (OpsPilot #59 Checkpoint A §4) are
// all optional so existing callers/tests that only have an AgentOrchestratorResult
// keep working: lifecycleEvents defaults to the empty canonical event list,
// and providerTurns to the empty recording-provider list.
//
// Tool-execution inputs and outputs are validated/deep-copied through
// toJsonValue() here — the recorder's raw `unknown` values never cross into
// ObservedFacts unchanged. A non-JSON-safe recorded input or output (e.g. a
// BigInt) throws NonJsonSafeValueError at this boundary rather than silently
// scoring a pass and failing later, invisibly, at JSON.stringify time.
//
// tools.completed[].output pairing: completed events are matched to recorded
// executions by position. Every real run satisfies the invariant that the
// first `completed.length` executed entries are exactly the successful
// executes that produced the TOOL_COMPLETED events, in order — a failed or
// invalid-output execution is always terminal in the orchestrator, so any
// output-less executed entry sits at the tail beyond completed.length. The
// zip is therefore prefix-safe; an entry missing an output at a position the
// completed list claims (e.g. a hand-built trace in a test) fails closed via
// toJsonValue rather than fabricating one.
export function buildObservedFacts(
  agentResult: AgentOrchestratorResult,
  executedTools: readonly RecordedToolExecution[],
  lifecycleEvents: readonly InvestigationEventPayload[] = [],
  providerTurns: readonly RecordedProviderTurn[] = [],
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
    .map((event, index) => ({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      output: toJsonValue(
        executedTools[index]?.output,
        `tools.completed[${index}] (${event.toolName}).output`,
      ),
    }));

  const tools: ToolFacts = {
    requested,
    executed: executedTools.map((entry) => ({
      toolName: entry.toolName,
      input: toJsonValue(entry.input, `tools.executed[toolName=${entry.toolName}].input`),
    })),
    completed: completedTools,
  };

  // Canonical lifecycle facts (OpsPilot #59 Checkpoint A §4.1): derived
  // exclusively from the existing emitLifecycleEvent payloads, in their
  // recorded order — never a parallel event model.
  const requestedAssessments = lifecycleEvents
    .filter((event): event is Extract<typeof event, { type: "TOOL_REQUESTED" }> => event.type === "TOOL_REQUESTED")
    .map((event) => ({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      assessment: event.assessment,
    }));

  const toolFailures = lifecycleEvents
    .filter((event): event is Extract<typeof event, { type: "TOOL_FAILED" }> => event.type === "TOOL_FAILED")
    .map((event) => ({ toolCallId: event.toolCallId, toolName: event.toolName, failureCode: event.failureCode }));

  const forcedFinalization = lifecycleEvents.some(
    (event) => event.type === "REPORT_GENERATION_STARTED",
  );

  const { inputTokens, outputTokens } = providerTurns.reduce(
    (acc, turn) => ({
      inputTokens: acc.inputTokens + turn.usage.inputTokens,
      outputTokens: acc.outputTokens + turn.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );

  if (agentResult.status === "completed") {
    const report: ReportFacts = {
      evidence: agentResult.report.evidence.map((entry) => ({
        evidenceId: entry.evidenceId,
        sourceType: entry.sourceType,
      })),
      suggestedActionTypes: agentResult.report.suggestedActions.map((action) => action.type),
      category: agentResult.report.category,
      rootCausePresent: agentResult.report.rootCause !== null,
      confidence: agentResult.report.confidence,
      evidenceState: agentResult.report.evidenceState,
      recommendationDisposition: agentResult.report.recommendationDisposition,
      suggestedActions: agentResult.report.suggestedActions.map((action) => ({
        type: action.type,
        groundedBy: action.groundedBy.map((entry) => ({ sourceType: entry.sourceType, evidenceId: entry.evidenceId })),
      })),
    };

    return {
      runStatus: "completed",
      errorCode: null,
      retrieval,
      tools,
      report,
      investigation: {
        providerTurnsUsed: providerTurns.length,
        diagnosticRequestCount: requestedAssessments.length,
        forcedFinalization,
        stopReason: deriveInvestigationStopReason({
          evidenceState: report.evidenceState,
          forcedFinalization,
        }),
        assessments: requestedAssessments,
        toolFailures,
        bounds: { maxProviderTurns: MAX_PROVIDER_TURNS, maxDiagnosticToolCalls: MAX_DIAGNOSTIC_TOOL_CALLS },
        usage: { inputTokens, outputTokens, providerCalls: providerTurns.length },
      },
      failedStage: null,
    };
  }

  return {
    runStatus: "failed",
    errorCode: agentResult.code,
    retrieval,
    tools,
    report: null,
    investigation: {
      providerTurnsUsed: providerTurns.length,
      diagnosticRequestCount: requestedAssessments.length,
      forcedFinalization,
      // A failed run has no report, so there is no final evidenceState to
      // derive from — forced finalization is the only fact that can still
      // produce a stop reason here.
      stopReason: deriveInvestigationStopReason({ evidenceState: undefined, forcedFinalization }),
      assessments: requestedAssessments,
      toolFailures,
      bounds: { maxProviderTurns: MAX_PROVIDER_TURNS, maxDiagnosticToolCalls: MAX_DIAGNOSTIC_TOOL_CALLS },
      usage: { inputTokens, outputTokens, providerCalls: providerTurns.length },
    },
    failedStage: agentResult.failedStage,
  };
}
