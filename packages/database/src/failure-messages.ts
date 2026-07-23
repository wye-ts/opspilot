import type { AgentOrchestratorErrorCode } from "@opspilot/contracts";

// Fixed, application-authored display text derived from the stable error
// code — never the orchestrator's own dynamic message and never any raw
// provider/tool/database text. failure_message is not a persisted column
// (see docs/11-agent-run-persistence.md); this map is the only source of a
// FAILED run's display message, computed at read time.
export const FAILURE_DISPLAY_MESSAGES: Record<AgentOrchestratorErrorCode, string> = {
  RETRIEVAL_PARAMS_INVALID: "Retrieval was requested with invalid parameters.",
  RETRIEVAL_FAILED: "The runbook retriever failed to complete retrieval.",
  RETRIEVAL_RESPONSE_INVALID: "The retriever returned a response that failed validation.",
  TOOL_NOT_FOUND: "The requested diagnostic tool is not registered.",
  TOOL_INPUT_INVALID: "The diagnostic tool was called with invalid input.",
  TOOL_OUTPUT_INVALID: "The diagnostic tool returned output that failed validation.",
  TOOL_EXECUTION_FAILED: "The diagnostic tool failed during execution.",
  REPORT_SCHEMA_INVALID: "The submitted resolution report failed schema validation.",
  REPORT_EVIDENCE_INVALID: "The submitted resolution report cited invalid evidence.",
  PROVIDER_PROTOCOL_INVALID: "The model provider violated the expected turn protocol.",
};
