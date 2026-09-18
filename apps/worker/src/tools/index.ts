import opspilotAgentRuntime from "@opspilot/agent-runtime";

export const {
  InMemoryToolRegistry,
  getServiceStatusTool,
  getRecentDeploymentsTool,
  DIAGNOSTIC_TOOL_CATALOG,
} = opspilotAgentRuntime;

export type {
  DiagnosticToolDefinition,
  ToolRegistry,
} from "@opspilot/agent-runtime";
