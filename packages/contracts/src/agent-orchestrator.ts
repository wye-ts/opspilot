import { z } from "zod";

// docs/04-agent-design.md §18 defines the broader AgentRunErrorCode set.
// This is the narrower subset actually produced by the vertical-slice
// orchestrator (tool lookup/validation, report validation, and provider
// protocol errors) so far; extend it as more of the orchestrator is
// implemented.
export const AgentOrchestratorErrorCodeSchema = z.enum([
  "RETRIEVAL_PARAMS_INVALID",
  "RETRIEVAL_FAILED",
  "RETRIEVAL_RESPONSE_INVALID",
  "TOOL_NOT_FOUND",
  "TOOL_INPUT_INVALID",
  "TOOL_OUTPUT_INVALID",
  "TOOL_EXECUTION_FAILED",
  "REPORT_SCHEMA_INVALID",
  "REPORT_EVIDENCE_INVALID",
  "PROVIDER_PROTOCOL_INVALID",
]);

export type AgentOrchestratorErrorCode = z.infer<
  typeof AgentOrchestratorErrorCodeSchema
>;
