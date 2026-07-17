import {
  ResolutionReportSchema,
  type AgentOrchestratorErrorCode,
  type EvidenceReference,
  type ResolutionReport,
} from "@opspilot/contracts";

import type {
  AgentConversationMessage,
  AgentTurnPhase,
  LlmProvider,
} from "../providers/llm-provider";
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

// docs/04-agent-design.md §16.1: only these three trace event kinds are
// wired in this slice (no RUN_STARTED/RETRIEVAL/persistence — no AgentRun
// exists yet to attach them to).
export type AgentTraceEvent =
  | {
      readonly type: "TOOL_REQUESTED";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "TOOL_COMPLETED";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: "REPORT_GENERATED" };

export interface AgentOrchestratorParams {
  readonly provider: LlmProvider;
  readonly toolRegistry: ToolRegistry;
  readonly initialConversation: readonly AgentConversationMessage[];
  readonly allowedRagChunkIds?: ReadonlySet<string>;
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

export async function runAgentOrchestrator(
  params: AgentOrchestratorParams,
): Promise<AgentOrchestratorResult> {
  const {
    provider,
    toolRegistry,
    allowedRagChunkIds = new Set<string>(),
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  } = params;
  let conversation = [...params.initialConversation];
  const trace: AgentTraceEvent[] = [];
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
