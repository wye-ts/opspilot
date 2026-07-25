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
  LlmProvider,
  LlmProviderErrorCategory,
  RawProviderTurnContext,
  TicketContextEntry,
  FakeAgentScenario,
  FakeProviderTurn,
} from "@opspilot/agent-runtime";
