import {
  ResolutionReportSchema,
  type AgentOrchestratorErrorCode,
  type AgentTraceEvent,
  type EvidenceReference,
  type ResolutionReport,
  type RetrievalSummaryEntry,
} from "@opspilot/contracts";

import type {
  AgentConversationMessage,
  AgentTurnPhase,
  LlmProvider,
} from "../providers/llm-provider";
import { formatRagContext } from "../rag/rag-context-formatting";
import { validateRetrievalInput, validateRetrievedChunks } from "../rag/retrieval-validation";
import {
  RetrieverError,
  type RetrievalInput,
  type RetrievedRunbookChunk,
  type RunbookRetriever,
} from "../rag/runbook-retriever";
import type { ToolRegistry } from "../tools/diagnostic-tool";

// docs/04-agent-design.md §11 runs an unbounded investigation loop governed
// by a configured turn budget (AGENT_MAX_INVESTIGATION_TURNS, default 5).
// This vertical slice hard-bounds the loop to 2 logical provider turns
// instead of wiring the full budget/deadline machinery: at most one
// diagnostic tool call, then a required report submission.
const MAX_PROVIDER_TURNS = 2;

// A provider must not infer this from turnIndex itself (see
// docs/04-agent-design.md §9's phase concept) — only the orchestrator's own
// bounded-loop policy maps turn positions to a phase.
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// RetrievalSummaryEntry and AgentTraceEvent now live in @opspilot/contracts
// (Zod-backed — see docs/11-agent-run-persistence.md) so packages/database
// can type its repository functions against the real trace-event shape
// without depending on apps/worker. Re-exported here so every existing
// import site keeps working unchanged — a type relocation, not a behavior
// change. docs/04-agent-design.md §16.1: only these trace event kinds are
// wired in this slice; RETRIEVAL_COMPLETED is pushed at most once, only
// after both retrieval-input and retrieval-output validation succeed.
export type { AgentTraceEvent, RetrievalSummaryEntry };

export interface AgentOrchestratorParams {
  readonly provider: LlmProvider;
  readonly toolRegistry: ToolRegistry;
  readonly initialConversation: readonly AgentConversationMessage[];
  readonly allowedRagChunkIds?: ReadonlySet<string>;
  readonly retriever?: RunbookRetriever;
  readonly retrievalInput?: RetrievalInput;
  readonly maxOutputTokens?: number;
}

export type AgentOrchestratorResult =
  | {
      readonly status: "completed";
      readonly report: ResolutionReport;
      readonly trace: readonly AgentTraceEvent[];
    }
  | {
      readonly status: "failed";
      readonly code: AgentOrchestratorErrorCode;
      readonly message: string;
      readonly trace: readonly AgentTraceEvent[];
    };

function failed(
  code: AgentOrchestratorErrorCode,
  message: string,
  trace: readonly AgentTraceEvent[],
): AgentOrchestratorResult {
  return { status: "failed", code, message, trace };
}

export function findInvalidEvidence(
  evidence: readonly EvidenceReference[],
  allowedRagChunkIds: ReadonlySet<string>,
  successfulToolExecutionIds: ReadonlySet<string>,
): boolean {
  return evidence.some((entry) =>
    entry.sourceType === "RAG_CHUNK"
      ? !allowedRagChunkIds.has(entry.evidenceId)
      : !successfulToolExecutionIds.has(entry.evidenceId),
  );
}

// Caller-contract-level validity: retriever and retrievalInput must both be
// present or both absent, and a retriever's allowedRagChunkIds must never be
// supplied by the caller — it is derived exclusively from that retriever's
// own results (see the "no merge" comment below). Both violations are
// RETRIEVAL_PARAMS_INVALID, matching invalid-topK/empty-query (also a
// caller-contract violation) rather than RETRIEVAL_RESPONSE_INVALID, which is
// reserved for a retriever that ran and returned structurally invalid data.
function validateOrchestratorParams(params: AgentOrchestratorParams): string | null {
  const hasRetriever = params.retriever !== undefined;
  const hasRetrievalInput = params.retrievalInput !== undefined;

  if (hasRetriever !== hasRetrievalInput) {
    return "retriever and retrievalInput must both be provided or both omitted.";
  }

  if (hasRetriever && (params.allowedRagChunkIds?.size ?? 0) > 0) {
    return (
      "allowedRagChunkIds must not be supplied together with a retriever; " +
      "it is derived exclusively from that retriever's results."
    );
  }

  return null;
}

export async function runAgentOrchestrator(
  params: AgentOrchestratorParams,
): Promise<AgentOrchestratorResult> {
  const paramsError = validateOrchestratorParams(params);
  if (paramsError) {
    return failed("RETRIEVAL_PARAMS_INVALID", paramsError, []);
  }

  const { provider, toolRegistry, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS } = params;
  const trace: AgentTraceEvent[] = [];
  let conversation = [...params.initialConversation];

  // Manual mode (no retriever): allowedRagChunkIds is exactly what the
  // caller passed, unchanged from today's behavior — the preserved baseline.
  // Retrieval mode (retriever present): allowedRagChunkIds is entirely
  // overwritten below by the Set built from validated retrieval results.
  // params.allowedRagChunkIds is never read in that branch — no merge.
  let allowedRagChunkIds: ReadonlySet<string> = params.allowedRagChunkIds ?? new Set<string>();

  if (params.retriever) {
    const retrievalInput = params.retrievalInput as RetrievalInput;

    const inputError = validateRetrievalInput(retrievalInput);
    if (inputError) {
      return failed("RETRIEVAL_PARAMS_INVALID", inputError, trace);
    }

    let chunks: readonly RetrievedRunbookChunk[];
    try {
      chunks = await params.retriever.retrieve(retrievalInput);
    } catch (error) {
      const category = error instanceof RetrieverError ? error.category : "UNKNOWN";
      return failed("RETRIEVAL_FAILED", `Runbook retrieval failed (${category}).`, trace);
    }

    const outputError = validateRetrievedChunks(chunks, retrievalInput.topK);
    if (outputError) {
      return failed("RETRIEVAL_RESPONSE_INVALID", outputError, trace);
    }

    // Only now — after both validations pass — build the Set, trace event,
    // and rag_context message. Chunks are already order-validated
    // (chunks[i].rank === i + 1), so the array order, the model-visible
    // context order, and the trace order all agree by construction.
    allowedRagChunkIds = new Set(chunks.map((chunk) => chunk.chunkId));

    trace.push({
      type: "RETRIEVAL_COMPLETED",
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        rank: chunk.rank,
        score: chunk.score,
      })),
    });

    if (chunks.length > 0) {
      conversation = [
        ...conversation,
        { role: "rag_context", entries: formatRagContext(chunks) },
      ];
    }
  }

  const successfulToolExecutionIds = new Set<string>();

  for (let turnIndex = 0; turnIndex < MAX_PROVIDER_TURNS; turnIndex++) {
    const phase: AgentTurnPhase =
      turnIndex === MAX_PROVIDER_TURNS - 1 ? "FINALIZATION" : "INVESTIGATION";
    const result = await provider.runAgentTurn({
      turnIndex,
      phase,
      maxOutputTokens,
      conversation,
    });

    if (result.type === "protocol_error") {
      return failed(result.code, result.message, trace);
    }

    if (result.type === "report_submission") {
      const parsedReport = ResolutionReportSchema.safeParse(result.rawInput);

      if (!parsedReport.success) {
        return failed(
          "REPORT_SCHEMA_INVALID",
          "The submitted resolution report failed schema validation.",
          trace,
        );
      }

      if (
        findInvalidEvidence(
          parsedReport.data.evidence,
          allowedRagChunkIds,
          successfulToolExecutionIds,
        )
      ) {
        return failed(
          "REPORT_EVIDENCE_INVALID",
          "The submitted report referenced evidence that was not available in the current agent execution.",
          trace,
        );
      }

      trace.push({ type: "REPORT_GENERATED" });
      return { status: "completed", report: parsedReport.data, trace };
    }

    // result.type === "diagnostic_tool_request"
    if (turnIndex === MAX_PROVIDER_TURNS - 1) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "A report submission was required on the final provider turn, but another diagnostic tool request was received.",
        trace,
      );
    }

    const { toolCallId, toolName, input } = result.request;

    const tool = toolRegistry.find(toolName);
    if (!tool) {
      return failed(
        "TOOL_NOT_FOUND",
        `Unknown diagnostic tool "${toolName}".`,
        trace,
      );
    }

    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return failed(
        "TOOL_INPUT_INVALID",
        `Invalid input for diagnostic tool "${toolName}".`,
        trace,
      );
    }

    trace.push({ type: "TOOL_REQUESTED", toolCallId, toolName });

    let rawOutput: unknown;
    try {
      rawOutput = await tool.execute(parsedInput.data);
    } catch {
      return failed(
        "TOOL_EXECUTION_FAILED",
        `Diagnostic tool "${toolName}" failed during execution.`,
        trace,
      );
    }

    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      return failed(
        "TOOL_OUTPUT_INVALID",
        `Diagnostic tool "${toolName}" returned an invalid result.`,
        trace,
      );
    }

    trace.push({ type: "TOOL_COMPLETED", toolCallId, toolName });
    successfulToolExecutionIds.add(toolCallId);

    conversation = [
      ...conversation,
      {
        role: "diagnostic_tool_request",
        toolCallId,
        toolName,
        input: parsedInput.data,
      },
      {
        role: "diagnostic_tool_result",
        toolCallId,
        toolName,
        output: parsedOutput.data,
      },
    ];
  }

  // Unreachable: the turnIndex === MAX_PROVIDER_TURNS - 1 check above always
  // returns before a 3rd iteration could start.
  return failed(
    "PROVIDER_PROTOCOL_INVALID",
    "Bounded provider-turn loop exhausted without a report submission.",
    trace,
  );
}
