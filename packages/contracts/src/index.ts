// Named re-export syntax (`export { X } from "./y"`) compiles, under
// CommonJS, to a live-binding getter that Vite-node's CJS interop (used by
// Vitest) does not reliably forward when this module is consumed via a
// default import — see packages/agent-runtime/src/index.ts for the full
// explanation. Every VALUE export below is imported first, then re-exported
// as a plain `const`. Type-only exports are unaffected and keep the ordinary
// `export type {...} from "./y"` form.

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
import { TicketContextSchema as _TicketContextSchema } from "./ticket-context";

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
export type { TicketContext } from "./ticket-context";
