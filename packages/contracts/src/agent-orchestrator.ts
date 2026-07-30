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
  // Transport-level provider failures. Distinct from PROVIDER_PROTOCOL_INVALID,
  // which means the provider answered but the answer did not satisfy the
  // contract; these three mean no usable answer was produced at all.
  //
  // They exist so an expected live-provider failure finalizes the run as FAILED
  // instead of escaping as a thrown error and leaving the row RUNNING forever
  // with no recovery path. Under the deterministic provider that escape was a
  // genuine "should never happen"; under a live provider it is the ordinary
  // path for an auth failure, a rate limit, a timeout, or a cancellation.
  //
  // The split is by operator response, not by vendor error class:
  //   PROVIDER_UNAVAILABLE — auth, billing, rate limit, connectivity, server
  //     error, malformed request, unknown. Retry or fix configuration.
  //   PROVIDER_TIMEOUT     — the caller's own deadline, or the transport's.
  //   PROVIDER_CANCELLED   — the caller went away. Not a provider fault, and
  //     must never be reported as one.
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_CANCELLED",
]);

export type AgentOrchestratorErrorCode = z.infer<
  typeof AgentOrchestratorErrorCodeSchema
>;
