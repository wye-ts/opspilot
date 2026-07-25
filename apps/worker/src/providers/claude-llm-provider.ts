import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type {
  AgentTurnInput,
  LlmProvider,
  LlmProviderErrorCategory,
  RawProviderTurnContext,
} from "@opspilot/agent-runtime";
import type { AgentTurnResult, TokenUsage } from "@opspilot/contracts";

import { buildClaudeMessages, buildSystemPrompt } from "./claude-message-mapping";
import { normalizeClaudeMessage } from "./claude-response-normalization";
import {
  SUBMIT_RESOLUTION_REPORT_TOOL,
  SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  toClaudeDiagnosticTool,
  type DiagnosticToolWithDescription,
} from "./claude-tool-schemas";

const { LlmProviderError } = opspilotAgentRuntime;

// The seam ClaudeLlmProvider depends on instead of a concrete Anthropic
// client, so tests can inject a fake with zero live calls. A real
// `new Anthropic(...)` instance satisfies this structurally.
export interface AnthropicMessagesClient {
  readonly messages: {
    // The SDK's real return type is APIPromise<Message>, which resolves to
    // Message intersected with a non-enumerable `_request_id` (sourced from
    // the `request-id` response header) — not part of the public Message
    // interface itself, so it's declared explicitly here.
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message & { readonly _request_id?: string | null }>;
  };
}

export type ClaudeProviderLogEvent =
  | {
      // "response_received" means the HTTP call succeeded, not that the
      // agent turn was semantically successful — normalizedResultType may
      // still be protocol_error. Never describe that case as "success".
      readonly outcome: "response_received";
      readonly model: string;
      readonly providerRequestId: string;
      readonly providerMessageId: string;
      readonly usage: TokenUsage;
      readonly latencyMs: number;
      readonly normalizedResultType: AgentTurnResult["type"];
    }
  | {
      readonly outcome: "error";
      readonly model: string;
      readonly category: LlmProviderErrorCategory;
      readonly latencyMs: number;
    };

export interface ClaudeLlmProviderOptions {
  readonly client: AnthropicMessagesClient;
  readonly model: string;
  readonly diagnosticTools: readonly DiagnosticToolWithDescription[];
  readonly logger?: (event: ClaudeProviderLogEvent) => void;
}

const SANITIZED_MESSAGE_BY_CATEGORY: Record<LlmProviderErrorCategory, string> = {
  AUTHENTICATION: "Anthropic API rejected the request as unauthorized.",
  RATE_LIMIT: "Anthropic API rate limit was exceeded.",
  CONNECTION: "Failed to connect to the Anthropic API.",
  TIMEOUT: "The request to the Anthropic API timed out.",
  SERVER_ERROR: "The Anthropic API returned a server error.",
  REQUEST_INVALID:
    "The Anthropic API rejected the request as malformed; this likely indicates an adapter bug.",
  UNKNOWN: "The Anthropic API request failed for an unknown reason.",
};

// Order matters: APIConnectionTimeoutError extends APIConnectionError, so it
// must be checked first or every timeout would misclassify as CONNECTION.
function classifyError(error: unknown): LlmProviderErrorCategory {
  if (error instanceof APIConnectionTimeoutError) return "TIMEOUT";
  if (error instanceof APIConnectionError) return "CONNECTION";
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return "AUTHENTICATION";
  }
  if (error instanceof RateLimitError) return "RATE_LIMIT";
  if (error instanceof InternalServerError) return "SERVER_ERROR";
  if (
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof UnprocessableEntityError
  ) {
    return "REQUEST_INVALID";
  }
  return "UNKNOWN";
}

export class ClaudeLlmProvider implements LlmProvider {
  constructor(private readonly options: ClaudeLlmProviderOptions) {}

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const params = this.buildRequestParams(input);
    const startedAt = performance.now();

    let message: Anthropic.Message & { readonly _request_id?: string | null };
    try {
      message = await this.options.client.messages.create(params);
    } catch (error) {
      const category = classifyError(error);
      this.options.logger?.({
        outcome: "error",
        model: this.options.model,
        category,
        latencyMs: performance.now() - startedAt,
      });
      // Transport/auth/rate-limit/server failures never produced a
      // parseable model response, so they must never be laundered into a
      // protocol_error AgentTurnResult — they throw instead.
      throw new LlmProviderError(category, SANITIZED_MESSAGE_BY_CATEGORY[category]);
    }

    const latencyMs = performance.now() - startedAt;
    const providerRequestId = message._request_id;
    if (!providerRequestId) {
      this.options.logger?.({
        outcome: "error",
        model: this.options.model,
        category: "UNKNOWN",
        latencyMs,
      });
      throw new LlmProviderError("UNKNOWN", "Anthropic response was missing a request id.");
    }

    const context: RawProviderTurnContext = {
      providerRequestId,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };

    // Normalize before logging so the logged event reflects what the turn
    // actually resolved to — a protocol_error must never be reported as if
    // the turn had succeeded.
    const normalizedResult = normalizeClaudeMessage(message, context);

    this.options.logger?.({
      outcome: "response_received",
      model: message.model,
      providerRequestId,
      providerMessageId: message.id,
      usage: context.usage,
      latencyMs,
      normalizedResultType: normalizedResult.type,
    });

    return normalizedResult;
  }

  private buildRequestParams(input: AgentTurnInput): Anthropic.MessageCreateParamsNonStreaming {
    const isInvestigation = input.phase === "INVESTIGATION";

    const tools: Anthropic.Tool[] = isInvestigation
      ? [...this.options.diagnosticTools.map(toClaudeDiagnosticTool), SUBMIT_RESOLUTION_REPORT_TOOL]
      : [SUBMIT_RESOLUTION_REPORT_TOOL];

    const toolChoice: Anthropic.ToolChoice = isInvestigation
      ? { type: "auto", disable_parallel_tool_use: true }
      : { type: "tool", name: SUBMIT_RESOLUTION_REPORT_TOOL_NAME, disable_parallel_tool_use: true };

    return {
      model: this.options.model,
      // Never inferred or hardcoded here — the caller (orchestrator or spike
      // runner) owns this value.
      max_tokens: input.maxOutputTokens,
      system: buildSystemPrompt(input.phase),
      messages: buildClaudeMessages(input.conversation),
      tools,
      tool_choice: toolChoice,
      // Claude Sonnet 5 defaults to adaptive thinking, which is incompatible
      // with forced tool_choice ({type:"tool",...}) and would 400 error.
      // Disabled uniformly on every call so thinking is never a second
      // experimental variable in this spike.
      thinking: { type: "disabled" },
    };
  }
}
