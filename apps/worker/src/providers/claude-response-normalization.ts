import type Anthropic from "@anthropic-ai/sdk";
import type { AgentTurnResult, DiagnosticToolRequest } from "@opspilot/contracts";

import { SUBMIT_RESOLUTION_REPORT_TOOL_NAME } from "./claude-tool-schemas";
import { normalizeDiagnosticToolRequests, type RawProviderTurnContext } from "./llm-provider";

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

function toDiagnosticToolRequest(block: Anthropic.ToolUseBlock): DiagnosticToolRequest {
  return { toolCallId: block.id, toolName: block.name, input: block.input };
}

function protocolError(
  context: RawProviderTurnContext,
  message: string,
): AgentTurnResult {
  return {
    type: "protocol_error",
    providerRequestId: context.providerRequestId,
    usage: context.usage,
    code: "PROVIDER_PROTOCOL_INVALID",
    message,
  };
}

// This handles only the response-content decision tree, and only ever runs
// on a response the SDK call already returned successfully — SDK/transport
// failures (auth, rate limit, connection, timeout, server errors) never
// reach this function; they're thrown as LlmProviderError by the adapter
// before a Message ever exists to normalize.
export function normalizeClaudeMessage(
  message: Anthropic.Message,
  context: RawProviderTurnContext,
): AgentTurnResult {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return protocolError(
      context,
      `Claude refused to respond${category ? ` (category: ${category})` : ""}.`,
    );
  }

  const toolUseBlocks = message.content.filter(isToolUseBlock);
  const reportBlocks = toolUseBlocks.filter(
    (block) => block.name === SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  );
  const diagnosticBlocks = toolUseBlocks.filter(
    (block) => block.name !== SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  );

  if (reportBlocks.length > 0 && diagnosticBlocks.length > 0) {
    return protocolError(
      context,
      `Provider returned both a submit_resolution_report call and ${diagnosticBlocks.length} diagnostic tool call(s) in one turn; exactly one kind is supported per turn.`,
    );
  }

  if (reportBlocks.length >= 2) {
    return protocolError(
      context,
      `Provider returned ${reportBlocks.length} submit_resolution_report calls in one turn; at most one is supported.`,
    );
  }

  const [reportBlock] = reportBlocks;
  if (reportBlocks.length === 1 && reportBlock) {
    return {
      type: "report_submission",
      providerRequestId: context.providerRequestId,
      usage: context.usage,
      rawInput: reportBlock.input,
    };
  }

  // 0, or >=2, diagnostic tool calls (with 0 report calls) both collapse to
  // protocol_error inside this shared, unmodified helper — see
  // docs/04-agent-design.md §10 and llm-provider.ts.
  return normalizeDiagnosticToolRequests(diagnosticBlocks.map(toDiagnosticToolRequest), context);
}
