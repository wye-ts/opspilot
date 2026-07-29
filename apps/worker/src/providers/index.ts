import opspilotAgentRuntime from "@opspilot/agent-runtime";

export const {
  LlmProviderError,
  normalizeDiagnosticToolRequests,
  FakeLlmProvider,
  FakeScenarioTurnNotFoundError,
} = opspilotAgentRuntime;

export type {
  AgentConversationMessage,
  AgentTurnInput,
  AgentTurnPhase,
  DiagnosticToolRequestEntry,
  DiagnosticToolResultEntry,
  DiagnosticToolCatalogEntry,
  LlmProvider,
  LlmProviderErrorCategory,
  LlmProviderFactory,
  LlmProviderSelection,
  PricedTokenUsage,
  PricingStatus,
  RawProviderTurnContext,
  TicketContextEntry,
  FakeAgentScenario,
  FakeProviderTurn,
} from "@opspilot/agent-runtime";

export { ClaudeLlmProvider } from "./claude-llm-provider";
export type {
  AnthropicMessagesClient,
  ClaudeLlmProviderOptions,
  ClaudeProviderLogEvent,
} from "./claude-llm-provider";

export {
  SUPPORTED_CLAUDE_MODEL,
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE,
  UnsupportedClaudeModelError,
  isSupportedClaudeModel,
  requireSupportedClaudeModel,
} from "./claude-model";
export type { SupportedClaudeModel } from "./claude-model";

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ProviderConfigError,
  parseWorkerProviderConfig,
  selectionOf,
} from "./claude-config";
export type {
  AnthropicRuntimeConfig,
  EnvRecord,
  LiveWorkerProviderConfig,
  WorkerProviderConfig,
} from "./claude-config";

export { CLAUDE_PRICING_TABLE, estimateClaudeCostUsd } from "./claude-pricing";

export { LiveProviderUnavailableError, createLlmProviderFactory } from "./create-llm-provider";
export type { LlmProviderFactoryOptions } from "./create-llm-provider";
