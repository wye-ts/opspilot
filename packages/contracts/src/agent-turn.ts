import { z } from "zod";

export const DiagnosticToolRequestSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
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
