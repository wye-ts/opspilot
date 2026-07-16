import type {
  AgentTurnResult,
  DiagnosticToolRequest,
  TokenUsage,
} from "@opspilot/contracts";

export interface AgentTurnInput {
  readonly turnIndex: number;
}

export interface LlmProvider {
  runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

export interface RawProviderTurnContext {
  readonly providerRequestId: string;
  readonly usage: TokenUsage;
}

/**
 * docs/04-agent-design.md §10: a provider turn carrying anything other than
 * exactly one diagnostic tool request is not a valid diagnostic_tool_request
 * result. It normalizes to protocol_error (PROVIDER_PROTOCOL_INVALID) here —
 * as an ordinary AgentTurnResult value, before any tool execution or
 * persistence — never as a thrown exception (§11).
 */
export function normalizeDiagnosticToolRequests(
  requests: readonly DiagnosticToolRequest[],
  context: RawProviderTurnContext,
): AgentTurnResult {
  const [request, ...rest] = requests;

  if (request && rest.length === 0) {
    return {
      type: "diagnostic_tool_request",
      providerRequestId: context.providerRequestId,
      usage: context.usage,
      request,
    };
  }

  return {
    type: "protocol_error",
    providerRequestId: context.providerRequestId,
    usage: context.usage,
    code: "PROVIDER_PROTOCOL_INVALID",
    message: `Provider returned ${requests.length} diagnostic tool requests in one turn; at most one is supported.`,
  };
}
