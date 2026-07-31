// Named re-export syntax (`export { X } from "./y"`) compiles, under
// CommonJS, to a live-binding getter that Vite-node's CJS interop (used by
// Vitest) does not reliably forward when this module is consumed via a
// default import — see packages/agent-runtime/src/index.ts for the full
// explanation. Every VALUE export below is imported first, then re-exported
// as a plain `const`. Type-only exports are unaffected and keep the ordinary
// `export type {...} from "./y"` form.

import {
  ApprovalDecisionSchema as _ApprovalDecisionSchema,
  RecordApprovalDecisionInputSchema as _RecordApprovalDecisionInputSchema,
} from "./agent-run-approval";
import {
  EvidenceReferenceSchema as _EvidenceReferenceSchema,
  IncidentCategorySchema as _IncidentCategorySchema,
  ResolutionReportSchema as _ResolutionReportSchema,
  SuggestedActionSchema as _SuggestedActionSchema,
} from "./resolution-report";
import {
  AgentProtocolErrorCodeSchema as _AgentProtocolErrorCodeSchema,
  AgentTurnResultSchema as _AgentTurnResultSchema,
  DiagnosticToolRequestSchema as _DiagnosticToolRequestSchema,
  TokenUsageSchema as _TokenUsageSchema,
} from "./agent-turn";
import { AgentOrchestratorErrorCodeSchema as _AgentOrchestratorErrorCodeSchema } from "./agent-orchestrator";
import {
  AgentTraceEventSchema as _AgentTraceEventSchema,
  RetrievalSummaryEntrySchema as _RetrievalSummaryEntrySchema,
} from "./agent-trace-event";
import {
  isLiveExecutionEligible as _isLiveExecutionEligible,
  StoredTicketContextSchema as _StoredTicketContextSchema,
  TICKET_ID_MAX_LENGTH as _TICKET_ID_MAX_LENGTH,
  TICKET_SUMMARY_MAX_LENGTH as _TICKET_SUMMARY_MAX_LENGTH,
  TICKET_SUMMARY_MIN_LENGTH as _TICKET_SUMMARY_MIN_LENGTH,
  TicketContextSchema as _TicketContextSchema,
} from "./ticket-context";
import {
  LIVE_RUN_IDEMPOTENCY_KEY_HEADER as _LIVE_RUN_IDEMPOTENCY_KEY_HEADER,
  LiveRunIdempotencyKeySchema as _LiveRunIdempotencyKeySchema,
} from "./live-run-idempotency";

export const ApprovalDecisionSchema = _ApprovalDecisionSchema;
export const RecordApprovalDecisionInputSchema = _RecordApprovalDecisionInputSchema;
export const EvidenceReferenceSchema = _EvidenceReferenceSchema;
export const IncidentCategorySchema = _IncidentCategorySchema;
export const ResolutionReportSchema = _ResolutionReportSchema;
export const SuggestedActionSchema = _SuggestedActionSchema;
export const AgentProtocolErrorCodeSchema = _AgentProtocolErrorCodeSchema;
export const AgentTurnResultSchema = _AgentTurnResultSchema;
export const DiagnosticToolRequestSchema = _DiagnosticToolRequestSchema;
export const TokenUsageSchema = _TokenUsageSchema;
export const AgentOrchestratorErrorCodeSchema = _AgentOrchestratorErrorCodeSchema;
export const AgentTraceEventSchema = _AgentTraceEventSchema;
export const RetrievalSummaryEntrySchema = _RetrievalSummaryEntrySchema;
export const TicketContextSchema = _TicketContextSchema;
export const StoredTicketContextSchema = _StoredTicketContextSchema;
export const TICKET_ID_MAX_LENGTH = _TICKET_ID_MAX_LENGTH;
export const TICKET_SUMMARY_MIN_LENGTH = _TICKET_SUMMARY_MIN_LENGTH;
export const TICKET_SUMMARY_MAX_LENGTH = _TICKET_SUMMARY_MAX_LENGTH;
export const isLiveExecutionEligible = _isLiveExecutionEligible;
export const LIVE_RUN_IDEMPOTENCY_KEY_HEADER = _LIVE_RUN_IDEMPOTENCY_KEY_HEADER;
export const LiveRunIdempotencyKeySchema = _LiveRunIdempotencyKeySchema;

export type { ApprovalDecision, RecordApprovalDecisionInput } from "./agent-run-approval";
export type {
  EvidenceReference,
  IncidentCategory,
  ResolutionReport,
  SuggestedAction,
} from "./resolution-report";
export type {
  AgentProtocolErrorCode,
  AgentTurnResult,
  DiagnosticToolRequest,
  TokenUsage,
} from "./agent-turn";
export type { AgentOrchestratorErrorCode } from "./agent-orchestrator";
export type { AgentTraceEvent, RetrievalSummaryEntry } from "./agent-trace-event";
export type { StoredTicketContext, TicketContext } from "./ticket-context";
