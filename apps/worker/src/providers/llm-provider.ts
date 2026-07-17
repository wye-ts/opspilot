import type {
  AgentTurnResult,
  DiagnosticToolRequest,
  TokenUsage,
} from "@opspilot/contracts";

// docs/04-agent-design.md §8.2 defines the full AgentMessage union
// (SystemPolicyMessage / UserContextMessage / AssistantTurnMessage /
// DiagnosticToolResultMessage / ReportValidationErrorMessage). This is the
// narrower subset the vertical-slice orchestrator actually builds — enough
// to prove the conversation-feedback loop — not a redefinition of the
// eventual message model.
export interface TicketContextEntry {
  readonly role: "ticket_context";
  readonly ticketId: string;
  readonly summary: string;
}

export interface DiagnosticToolRequestEntry {
  readonly role: "diagnostic_tool_request";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface DiagnosticToolResultEntry {
  readonly role: "diagnostic_tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

export type AgentConversationMessage =
  | TicketContextEntry
  | DiagnosticToolRequestEntry
  | DiagnosticToolResultEntry;

export interface AgentTurnInput {
  readonly turnIndex: number;
  readonly conversation: readonly AgentConversationMessage[];
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
