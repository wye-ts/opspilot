import type {
  AgentTurnResult,
  DiagnosticToolRequest,
  EvidenceAssessment,
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
  // Issue #58 Checkpoint B (§3.3): the VALIDATED evidence assessment that
  // accompanied this accepted diagnostic request. Appended to the
  // conversation only after the orchestrator's authoritative
  // EvidenceAssessmentSchema validation accepts it — never the raw
  // unvalidated form. Replayed to Claude on later turns so each decision
  // point sees the prior model-declared evidentiary status that justified
  // the earlier tool call (docs/16 §6.3).
  readonly assessment: EvidenceAssessment;
}

export interface DiagnosticToolResultEntry {
  readonly role: "diagnostic_tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

// Populated once, before the first investigation turn, when the orchestrator
// is given a RunbookRetriever (see agent-orchestrator.ts) and that retrieval
// returned at least one chunk. entries are pre-validated, application-
// controlled values built by ../rag/rag-context-formatting.ts's
// formatRagContext, which imports this type as its return shape's source of
// truth (this module never imports from ../rag, keeping the dependency
// one-directional).
export interface RagContextEntry {
  readonly evidenceId: string;
  readonly sourceType: "RAG_CHUNK";
  readonly runbookId: string;
  readonly title: string;
  readonly content: string;
}

export interface RagContextMessage {
  readonly role: "rag_context";
  readonly entries: readonly RagContextEntry[];
}

export type AgentConversationMessage =
  | TicketContextEntry
  | DiagnosticToolRequestEntry
  | DiagnosticToolResultEntry
  | RagContextMessage;

// docs/04-agent-design.md §9 defines a richer per-turn contract (availableTools,
// toolChoice, deadlineAtMs, promptVersion, ...). phase and maxOutputTokens are
// pulled forward from that contract because a live provider adapter cannot
// correctly select tools/tool_choice or bound its request without them —
// unlike turnIndex, which is an orchestrator-internal loop counter a provider
// must not need to interpret.
export type AgentTurnPhase = "INVESTIGATION" | "FINALIZATION";

export interface AgentTurnInput {
  readonly turnIndex: number;
  readonly phase: AgentTurnPhase;
  readonly maxOutputTokens: number;
  readonly conversation: readonly AgentConversationMessage[];
  // Issue #58 Checkpoint B (§3.2): remaining diagnostic capacity for THIS
  // turn, computed by the orchestrator as MAX_DIAGNOSTIC_TOOL_CALLS minus the
  // number of accepted diagnostic requests so far (0 on the FINALIZATION
  // turn). This is CONSTRAINT VISIBILITY, not a quota: it tells the model how
  // much headroom it has, but the #57 harness remains authoritative for
  // actually enforcing the bound. Deliberately NOT turnIndex — turnIndex is
  // an orchestrator-internal loop counter a provider must not interpret
  // (docs/04-agent-design.md §9). FakeLlmProvider ignores it; a live adapter
  // surfaces it in the system prompt / guidance block.
  readonly diagnosticCallsRemaining: number;
  // Optional caller-owned cancellation seam. AbortSignal is a platform
  // primitive, not an SDK type, so this stays provider-neutral: FakeLlmProvider
  // ignores it, and a live adapter forwards it to its transport.
  //
  // It is deliberately per-turn rather than per-provider-instance. A deadline
  // originates with whoever invoked the run — an HTTP request in the API path,
  // a smoke script locally — and that owner is not known when the provider is
  // constructed. Note this is only a *seam*: nothing here schedules a deadline,
  // and it reaches provider calls only — tool execution, retrieval, and
  // persistence are not cancelled by it in this milestone.
  readonly signal?: AbortSignal;
}

export interface LlmProvider {
  runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}

// Distinct from protocol_error: this covers SDK/transport-level failures
// (auth, rate limit, connectivity, timeout, server errors) that never
// produced a parseable model response, so they must not be laundered into an
// AgentTurnResult. A live provider throws this instead; callers that want to
// surface it (e.g. a demo/spike runner) catch it explicitly.
// BILLING is distinct from AUTHENTICATION on purpose: a rejected key, a
// missing permission, and an exhausted balance need three different operator
// responses, and collapsing them would send an operator down the wrong one.
// CANCELLED is likewise distinct from TIMEOUT — a caller aborting deliberately
// is not a provider failure and must never be reported as one.
export type LlmProviderErrorCategory =
  | "AUTHENTICATION"
  | "BILLING"
  | "RATE_LIMIT"
  | "CONNECTION"
  | "TIMEOUT"
  | "CANCELLED"
  | "SERVER_ERROR"
  | "REQUEST_INVALID"
  | "UNKNOWN";

export class LlmProviderError extends Error {
  constructor(
    readonly category: LlmProviderErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
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
