import opspilotAgentRuntime from "@opspilot/agent-runtime";

export const { InMemoryToolRegistry, getServiceStatusTool } = opspilotAgentRuntime;

export type {
  DiagnosticToolDefinition,
  ToolRegistry,
} from "@opspilot/agent-runtime";
