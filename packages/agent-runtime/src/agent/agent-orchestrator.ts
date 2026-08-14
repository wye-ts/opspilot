import {
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  ResolutionReportSchema,
  summarizeReportValidationIssues,
  type AgentOrchestratorErrorCode,
  type AgentTraceEvent,
  type AgentTurnResult,
  type EvidenceReference,
  type InvestigationEventPayload,
  type InvestigationExecutionStage,
  type ReportValidationIssue,
  type ResolutionReport,
  type RetrievalSummaryEntry,
} from "@opspilot/contracts";

import { LlmProviderError } from "../providers/llm-provider";
import type {
  AgentConversationMessage,
  AgentTurnPhase,
  LlmProvider,
  LlmProviderErrorCategory,
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

// Issue #57 Checkpoint B: the orchestrator adopts the reviewed, shared source
// bounds from packages/contracts/src/agent-run-bounds.ts — 4 provider turns /
// 3 diagnostic tool calls, with MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1
// asserted by a contracts unit test. Turns 0..2 are INVESTIGATION, each
// accepting at most one diagnostic tool request (so the diagnostic bound
// coincides with the number of investigation turns); turn 3 is the reserved
// forced FINALIZATION turn. The aspirational AGENT_MAX_* env budgets in
// docs/04-agent-design.md §7 remain unwired (Decision 1); there is no
// same-tool-name limit (Decision 3).

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
  // Forwarded verbatim to every provider turn. The orchestrator neither
  // creates nor inspects it: it owns no deadline of its own (see
  // MAX_PROVIDER_TURNS above — the loop is bounded by turn count, not by
  // wall clock). Scope: this covers the provider calls only. Tool execution,
  // retrieval, and persistence are NOT cancelled by it, so it is not a strict
  // deadline for the whole run. Retries remain the provider transport's concern.
  readonly signal?: AbortSignal;
  /**
   * The CANONICAL persistence channel (issue #37).
   *
   * Optional, and absent for every direct caller — evals, demos, the
   * orchestrator's own unit tests — which is why the legacy in-memory
   * `trace` channel below is kept entirely independent of it rather than
   * derived from it. When omitted this is a no-op and the returned
   * `AgentTraceEvent[]` is byte-for-byte what it has always been.
   *
   * AWAITED, because the ordering claim has to be real: if TOOL_REQUESTED is
   * not durable before the registry lookup runs, the ledger is not
   * describing what actually happened. A rejection aborts the run
   * immediately — see the two-channel note on `trace` below.
   */
  readonly emitLifecycleEvent?: (payload: InvestigationEventPayload) => Promise<void>;
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
      /**
       * The execution stage that was actually running when this failure
       * occurred, stated by the site that produced it rather than inferred
       * downstream. Persistence must never guess: RUN_FAILED.failedStage is
       * required to name the stage the reducer sees as active, and a wrong
       * guess is rejected (FAILED_STAGE_NOT_TRUTHFUL).
       */
      readonly failedStage: InvestigationExecutionStage;
      /**
       * Populated only for REPORT_SCHEMA_INVALID, from
       * summarizeReportValidationIssues — safe to log (paths, codes,
       * expected/received type names, our own schema's static bounds), never
       * the raw report Claude submitted. Absent for every other failure code.
       */
      readonly reportValidationIssues?: readonly ReportValidationIssue[];
    };

function failed(
  code: AgentOrchestratorErrorCode,
  message: string,
  trace: readonly AgentTraceEvent[],
  failedStage: InvestigationExecutionStage,
  reportValidationIssues?: readonly ReportValidationIssue[],
): AgentOrchestratorResult {
  return {
    status: "failed",
    code,
    message,
    trace,
    failedStage,
    ...(reportValidationIssues !== undefined ? { reportValidationIssues } : {}),
  };
}

/**
 * Maps a transport-level provider failure onto the persisted failure code.
 *
 * Grouped by what an operator would do about it, not by vendor error class.
 * TIMEOUT and CANCELLED are kept separate from everything else because they
 * are not provider faults: one means the run outlived its budget, the other
 * means the caller went away. Collapsing either into PROVIDER_UNAVAILABLE
 * would send an operator looking for an outage that never happened.
 *
 * An exhaustive switch, deliberately: adding a category to
 * LlmProviderErrorCategory should fail the build here rather than silently
 * fall through to a default.
 */
function providerFailureCode(category: LlmProviderErrorCategory): AgentOrchestratorErrorCode {
  switch (category) {
    case "TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "CANCELLED":
      return "PROVIDER_CANCELLED";
    case "AUTHENTICATION":
    case "BILLING":
    case "RATE_LIMIT":
    case "CONNECTION":
    case "SERVER_ERROR":
    case "REQUEST_INVALID":
    case "UNKNOWN":
      return "PROVIDER_UNAVAILABLE";
  }
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
    // The ONE failure reachable before anything is traced or emitted, and
    // the reason AGENT_STARTED is emitted just below rather than at function
    // entry: the contract's single pre-agent exception requires the stream to
    // be exactly RUN_CREATED -> RUN_FAILED. Emitting AGENT_STARTED first would
    // not fail loudly — it would quietly make that hand-written exception
    // unreachable. See docs/16-investigation-event-contract.md §5.
    return failed("RETRIEVAL_PARAMS_INVALID", paramsError, [], "AGENT_ANALYSIS");
  }

  const { provider, toolRegistry, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS } = params;

  // TWO INDEPENDENT OUTPUT CHANNELS, deliberately not derived from one
  // another (issue #37, docs/reviews/21-...md §5):
  //
  //   canonical persistence -> await params.emitLifecycleEvent?.(payload)
  //   legacy in-memory      -> trace.push(legacyAgentTraceEvent)
  //
  // Their timing is NOT identical for every path: canonical TOOL_REQUESTED is
  // emitted before registry lookup/input validation, while the legacy push
  // stays at its old post-validation point. Keeping them separate is what
  // lets direct callers (evals, demos, unit tests) see exactly the trace they
  // always have, while the ledger truthfully records that the provider did
  // request a tool even when that tool turned out not to exist.
  //
  // ORDERING RULE for any event with both channels: canonical first, legacy
  // second. If canonical persistence fails, the await throws before the push
  // runs, so the in-memory trace never claims a transition whose durable
  // record does not exist.
  const emit = async (payload: InvestigationEventPayload): Promise<void> => {
    await params.emitLifecycleEvent?.(payload);
  };

  const trace: AgentTraceEvent[] = [];
  let conversation = [...params.initialConversation];

  // Manual mode (no retriever): allowedRagChunkIds is exactly what the
  // caller passed, unchanged from today's behavior — the preserved baseline.
  // Retrieval mode (retriever present): allowedRagChunkIds is entirely
  // overwritten below by the Set built from validated retrieval results.
  // params.allowedRagChunkIds is never read in that branch — no merge.
  let allowedRagChunkIds: ReadonlySet<string> = params.allowedRagChunkIds ?? new Set<string>();

  await emit({ type: "AGENT_STARTED" });

  if (params.retriever) {
    const retrievalInput = params.retrievalInput as RetrievalInput;

    const inputError = validateRetrievalInput(retrievalInput);
    if (inputError) {
      return failed("RETRIEVAL_PARAMS_INVALID", inputError, trace, "AGENT_ANALYSIS");
    }

    let chunks: readonly RetrievedRunbookChunk[];
    try {
      chunks = await params.retriever.retrieve(retrievalInput);
    } catch (error) {
      const category = error instanceof RetrieverError ? error.category : "UNKNOWN";
      return failed("RETRIEVAL_FAILED", `Runbook retrieval failed (${category}).`, trace, "AGENT_ANALYSIS");
    }

    const outputError = validateRetrievedChunks(chunks, retrievalInput.topK);
    if (outputError) {
      return failed("RETRIEVAL_RESPONSE_INVALID", outputError, trace, "AGENT_ANALYSIS");
    }

    // Only now — after both validations pass — build the Set, trace event,
    // and rag_context message. Chunks are already order-validated
    // (chunks[i].rank === i + 1), so the array order, the model-visible
    // context order, and the trace order all agree by construction.
    allowedRagChunkIds = new Set(chunks.map((chunk) => chunk.chunkId));

    const retrievalSummary = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      rank: chunk.rank,
      score: chunk.score,
    }));

    // Canonical first, legacy second — a failed canonical append must not
    // leave the in-memory trace claiming retrieval completed.
    await emit({ type: "RETRIEVAL_COMPLETED", chunks: retrievalSummary });
    trace.push({ type: "RETRIEVAL_COMPLETED", chunks: retrievalSummary });

    if (chunks.length > 0) {
      conversation = [
        ...conversation,
        { role: "rag_context", entries: formatRagContext(chunks) },
      ];
    }
  }

  const successfulToolExecutionIds = new Set<string>();
  // Accepted diagnostic tool requests this run, incremented per emitted
  // TOOL_REQUESTED (mirroring the reducer's own per-request count). Drives
  // the state-derived active-stage attribution and the defense-in-depth bound
  // check below; the canonical ledger reconstructs the same count from the
  // persisted stream.
  let toolCallCount = 0;

  for (let turnIndex = 0; turnIndex < MAX_PROVIDER_TURNS; turnIndex++) {
    const phase: AgentTurnPhase =
      turnIndex === MAX_PROVIDER_TURNS - 1 ? "FINALIZATION" : "INVESTIGATION";

    // The stage a provider/protocol failure on THIS turn belongs to (issue #57
    // §4.2), derived from run state rather than phase alone. On the
    // finalization turn REPORT_GENERATION_STARTED has just been emitted, so
    // REPORT_GENERATION is the active stage. On an investigation turn after at
    // least one completed diagnostic, the agent is awaiting the provider's next
    // diagnostic decision — a provider failure there is a DIAGNOSTIC_EXECUTION
    // failure, which the reducer admits (as diagnosticLoopActive) only while
    // the loop is genuinely mid-flight and below its bound. Before any tool,
    // an investigation failure is still AGENT_ANALYSIS.
    const activeStage: InvestigationExecutionStage =
      phase === "FINALIZATION"
        ? "REPORT_GENERATION"
        : toolCallCount > 0
          ? "DIAGNOSTIC_EXECUTION"
          : "AGENT_ANALYSIS";

    // Announced immediately before the finalization provider call, and only
    // there. Under the current execution model that turn is reachable only
    // after a diagnostic tool call completed, which is exactly why the
    // contract requires a preceding tool phase for this event. Emitted
    // OUTSIDE the try below so an emission failure is never mistaken for a
    // provider error.
    if (phase === "FINALIZATION") {
      await emit({ type: "REPORT_GENERATION_STARTED" });
    }

    let result: AgentTurnResult;
    try {
      result = await provider.runAgentTurn({
        turnIndex,
        phase,
        maxOutputTokens,
        conversation,
        // Conditional spread: exactOptionalPropertyTypes is on, so an optional
        // property must be absent or a real value, never an explicit undefined.
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
    } catch (error) {
      // An LlmProviderError is an EXPECTED outcome of a live provider call —
      // auth, billing, rate limit, connectivity, timeout, cancellation — and
      // is converted into an ordinary failed result so the caller can finalize
      // the run. Letting it propagate would leave the persisted run RUNNING
      // forever, because AgentRunService's catch turns any throw into
      // AGENT_EXECUTION_CRASHED without finalizing.
      //
      // Its message is already the adapter's sanitized, category-keyed string,
      // so nothing vendor-specific — no response body, header, prompt, request
      // ID, or credential — reaches the trace or the database.
      //
      // Anything else is a genuine defect and still propagates unchanged: the
      // crash path exists precisely to make those loud.
      if (error instanceof LlmProviderError) {
        return failed(providerFailureCode(error.category), error.message, trace, activeStage);
      }
      // Anything else — including InvestigationEventEmissionError raised by
      // the canonical channel — propagates unchanged. The crash path exists
      // precisely to make those loud.
      throw error;
    }

    if (result.type === "protocol_error") {
      return failed(result.code, result.message, trace, activeStage);
    }

    if (result.type === "report_submission") {
      // The provider has genuinely returned a report payload — recorded
      // before validation runs, so the ledger distinguishes "submitted then
      // rejected" from "never submitted".
      await emit({ type: "REPORT_SUBMITTED" });

      // reportInput: true is required for summarizeReportValidationIssues to
      // derive a real receivedType (zod v4 omits `.input` from issues by
      // default). The raw value was already fully in memory as
      // result.rawInput regardless — this doesn't expose anything new, and
      // the summarizer only ever reads `typeof`/Array.isArray off it, never
      // the value itself.
      const parsedReport = ResolutionReportSchema.safeParse(result.rawInput, {
        reportInput: true,
      });

      if (!parsedReport.success) {
        await emit({ type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" });
        return failed(
          "REPORT_SCHEMA_INVALID",
          "The submitted resolution report failed schema validation.",
          trace,
          "REPORT_GENERATION",
          summarizeReportValidationIssues(parsedReport.error),
        );
      }

      if (
        findInvalidEvidence(
          parsedReport.data.evidence,
          allowedRagChunkIds,
          successfulToolExecutionIds,
        )
      ) {
        await emit({ type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_EVIDENCE_INVALID" });
        return failed(
          "REPORT_EVIDENCE_INVALID",
          "The submitted report referenced evidence that was not available in the current agent execution.",
          trace,
          "REPORT_GENERATION",
        );
      }

      // Canonical REPORT_VALIDATED, then the legacy REPORT_GENERATED push.
      // The legacy type name is unchanged: REPORT_GENERATED has always meant
      // "validated and accepted", which is exactly what REPORT_VALIDATED
      // records — two names for one fact, neither derived from the other.
      await emit({ type: "REPORT_VALIDATED" });
      trace.push({ type: "REPORT_GENERATED" });
      return { status: "completed", report: parsedReport.data, trace };
    }

    // result.type === "diagnostic_tool_request"
    if (turnIndex === MAX_PROVIDER_TURNS - 1) {
      // Deliberately BEFORE the canonical TOOL_REQUESTED emission below: a
      // diagnostic tool request on the forced finalization turn must not
      // produce a TOOL_REQUESTED in the ledger at all — the turn requires a
      // report submission, and a rejected request is a provider protocol
      // failure. By this point REPORT_GENERATION_STARTED has been emitted, so
      // REPORT_GENERATION is the truthful active stage.
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "A report submission was required on the final provider turn, but another diagnostic tool request was received.",
        trace,
        "REPORT_GENERATION",
      );
    }

    // Defense-in-depth (issue #57 §4.1): never accept more diagnostic tool
    // requests than the shared bound, even if future constants drift so that
    // the investigation turns outnumber MAX_DIAGNOSTIC_TOOL_CALLS. With the
    // current equality (MAX_DIAGNOSTIC_TOOL_CALLS === MAX_PROVIDER_TURNS - 1)
    // this coincides with the finalization-turn guard above and is
    // unreachable; it exists so a future constant change fails closed instead
    // of executing a call past the reviewed ceiling.
    if (toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "The diagnostic tool bound was reached, but another diagnostic tool request was received.",
        trace,
        "REPORT_GENERATION",
      );
    }

    const { toolCallId, toolName, input } = result.request;

    // CANONICAL TOOL_REQUESTED, emitted here — before registry lookup and
    // before input validation — because the provider genuinely did request
    // the tool, and TOOL_NOT_FOUND / TOOL_INPUT_INVALID must be able to
    // record TOOL_REQUESTED -> TOOL_FAILED. The LEGACY push stays at its
    // original post-validation position further below, unmoved, so a direct
    // caller's in-memory trace is unchanged for those two failures.
    await emit({ type: "TOOL_REQUESTED", toolCallId, toolName });
    toolCallCount += 1;

    const tool = toolRegistry.find(toolName);
    if (!tool) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_NOT_FOUND" });
      return failed(
        "TOOL_NOT_FOUND",
        `Unknown diagnostic tool "${toolName}".`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_INPUT_INVALID" });
      return failed(
        "TOOL_INPUT_INVALID",
        `Invalid input for diagnostic tool "${toolName}".`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    // The LEGACY TOOL_REQUESTED push, unmoved from its original position:
    // reached only after lookup AND input validation both succeed. This is
    // why the two early tool failures above still produce no legacy
    // TOOL_REQUESTED, exactly as before #37.
    trace.push({ type: "TOOL_REQUESTED", toolCallId, toolName });

    let rawOutput: unknown;
    try {
      rawOutput = await tool.execute(parsedInput.data);
    } catch {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_EXECUTION_FAILED" });
      return failed(
        "TOOL_EXECUTION_FAILED",
        `Diagnostic tool "${toolName}" failed during execution.`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_OUTPUT_INVALID" });
      return failed(
        "TOOL_OUTPUT_INVALID",
        `Diagnostic tool "${toolName}" returned an invalid result.`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    await emit({ type: "TOOL_COMPLETED", toolCallId, toolName });
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

  // Unreachable: the finalization turn always returns before the loop can fall
  // through — a diagnostic tool request is rejected by the finalization-turn
  // guard, a report submission returns immediately, and a provider/protocol
  // failure fails closed.
  return failed(
    "PROVIDER_PROTOCOL_INVALID",
    "Bounded provider-turn loop exhausted without a report submission.",
    trace,
    "REPORT_GENERATION",
  );
}
