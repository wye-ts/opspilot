import { z } from "zod";

export const DiagnosticToolRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
    // Issue #58 Checkpoint B (§3.1): the model-declared evidence assessment as
    // it arrived from the provider, UNVALIDATED. Mirroring rawInput on
    // report_submission (docs/04-agent-design.md §13) exactly, the provider
    // adapter only extracts this structurally; authoritative
    // EvidenceAssessmentSchema validation happens once, in the orchestrator,
    // uniformly for live and fake providers (see agent-orchestrator.ts's
    // V0 guard). Never persist or replay this raw form — only the validated
    // value rides on the canonical TOOL_REQUESTED record.
    rawAssessment: z.unknown(),
  })
  .strict();

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

// docs/04-agent-design.md §18 defines the broader AgentRunErrorCode set.
// This is the narrower subset of protocol-level codes actually produced by
// provider-turn normalization (§10) so far; extend it as more normalization
// failure modes are implemented.
export const AgentProtocolErrorCodeSchema = z.enum([
  "PROVIDER_PROTOCOL_INVALID",
  // stop_reason === "max_tokens": the provider was cut off before it finished
  // responding. Distinct from PROVIDER_PROTOCOL_INVALID (a complete response
  // that violates the turn contract) — this is an incomplete one, and must
  // never be reinterpreted as whatever partial content happens to be present
  // (e.g. a partially-filled submit_resolution_report tool_use block
  // otherwise misclassifying as a schema-invalid report).
  "PROVIDER_OUTPUT_TRUNCATED",
]);

const DiagnosticToolRequestTurnResultSchema = z
  .object({
    type: z.literal("diagnostic_tool_request"),
    providerRequestId: z.string().min(1),
    usage: TokenUsageSchema,
    request: DiagnosticToolRequestSchema,
  })
  .strict();

// The report has not been validated yet at this point (docs/03-technical-design.md
// §13.5) — rawInput is the unvalidated submit_resolution_report tool-call
// input. Schema validation happens later, in report submission handling
// (docs/04-agent-design.md §13), not in the normalized turn result itself.
const ReportSubmissionTurnResultSchema = z
  .object({
    type: z.literal("report_submission"),
    providerRequestId: z.string().min(1),
    usage: TokenUsageSchema,
    rawInput: z.unknown(),
  })
  .strict();

const ProtocolErrorTurnResultSchema = z
  .object({
    type: z.literal("protocol_error"),
    providerRequestId: z.string().min(1).optional(),
    usage: TokenUsageSchema.optional(),
    code: AgentProtocolErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const AgentTurnResultSchema = z.discriminatedUnion("type", [
  DiagnosticToolRequestTurnResultSchema,
  ReportSubmissionTurnResultSchema,
  ProtocolErrorTurnResultSchema,
]);

export type DiagnosticToolRequest = z.infer<typeof DiagnosticToolRequestSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type AgentProtocolErrorCode = z.infer<
  typeof AgentProtocolErrorCodeSchema
>;
export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;
