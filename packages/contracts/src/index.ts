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
  MAX_DIAGNOSTIC_TOOL_CALLS as _MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS as _MAX_PROVIDER_TURNS,
} from "./agent-run-bounds";
import {
  countDistinctEvidenceLocators as _countDistinctEvidenceLocators,
  EvidenceLocatorSchema as _EvidenceLocatorSchema,
  EvidenceSourceTypeSchema as _EvidenceSourceTypeSchema,
} from "./evidence";
import {
  ContinuationReasonSchema as _ContinuationReasonSchema,
  deriveInvestigationStopReason as _deriveInvestigationStopReason,
  EvidenceAssessmentSchema as _EvidenceAssessmentSchema,
  EvidenceStateSchema as _EvidenceStateSchema,
} from "./evidence-assessment";
import {
  EvidenceReferenceSchema as _EvidenceReferenceSchema,
  IncidentCategorySchema as _IncidentCategorySchema,
  RecommendationDispositionSchema as _RecommendationDispositionSchema,
  ResolutionReportSchema as _ResolutionReportSchema,
  StoredResolutionReportSchema as _StoredResolutionReportSchema,
  SuggestedActionSchema as _SuggestedActionSchema,
  SuggestedActionWriteSchema as _SuggestedActionWriteSchema,
} from "./resolution-report";
import { summarizeReportValidationIssues as _summarizeReportValidationIssues } from "./resolution-report-validation";
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
  isPublicLiveExecutionEligible as _isPublicLiveExecutionEligible,
  PUBLIC_TICKET_SUMMARY_MAX_LENGTH as _PUBLIC_TICKET_SUMMARY_MAX_LENGTH,
  PublicTicketContextSchema as _PublicTicketContextSchema,
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
import {
  ExecutionStageProgressListSchema as _ExecutionStageProgressListSchema,
  ExecutionStageProgressSchema as _ExecutionStageProgressSchema,
  ExecutionStageProgressStatusSchema as _ExecutionStageProgressStatusSchema,
  INVESTIGATION_EXECUTION_STAGE_ORDER as _INVESTIGATION_EXECUTION_STAGE_ORDER,
  InvestigationExecutionStageSchema as _InvestigationExecutionStageSchema,
  InvestigationRunStatusSchema as _InvestigationRunStatusSchema,
} from "./investigation-execution-stage";
import {
  INVESTIGATION_EVENT_LEGACY_TYPE_COUNT as _INVESTIGATION_EVENT_LEGACY_TYPE_COUNT,
  INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT as _INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT,
  InvestigationEventPayloadSchema as _InvestigationEventPayloadSchema,
  InvestigationEventRecordPayloadSchema as _InvestigationEventRecordPayloadSchema,
  InvestigationEventRecordSchema as _InvestigationEventRecordSchema,
  ReportValidationFailureCodeSchema as _ReportValidationFailureCodeSchema,
  ToolFailureCodeSchema as _ToolFailureCodeSchema,
  ToolRequestedRecordEventSchema as _ToolRequestedRecordEventSchema,
  ToolRequestedWriteEventSchema as _ToolRequestedWriteEventSchema,
  mapInvestigationEventToExecutionStage as _mapInvestigationEventToExecutionStage,
} from "./investigation-event";
import {
  hasCanonicalInvestigationLifecycleMarker as _hasCanonicalInvestigationLifecycleMarker,
  projectToLegacyAgentTraceEvent as _projectToLegacyAgentTraceEvent,
} from "./investigation-lifecycle-compatibility";
import {
  InvestigationEventContractError as _InvestigationEventContractError,
  deriveExecutionStageProgress as _deriveExecutionStageProgress,
} from "./investigation-stage-progress-reducer";

export const ApprovalDecisionSchema = _ApprovalDecisionSchema;
export const RecordApprovalDecisionInputSchema = _RecordApprovalDecisionInputSchema;
export const MAX_PROVIDER_TURNS = _MAX_PROVIDER_TURNS;
export const MAX_DIAGNOSTIC_TOOL_CALLS = _MAX_DIAGNOSTIC_TOOL_CALLS;
export const countDistinctEvidenceLocators = _countDistinctEvidenceLocators;
export const EvidenceLocatorSchema = _EvidenceLocatorSchema;
export const EvidenceSourceTypeSchema = _EvidenceSourceTypeSchema;
export const ContinuationReasonSchema = _ContinuationReasonSchema;
export const deriveInvestigationStopReason = _deriveInvestigationStopReason;
export const EvidenceAssessmentSchema = _EvidenceAssessmentSchema;
export const EvidenceStateSchema = _EvidenceStateSchema;
export const EvidenceReferenceSchema = _EvidenceReferenceSchema;
export const IncidentCategorySchema = _IncidentCategorySchema;
export const RecommendationDispositionSchema = _RecommendationDispositionSchema;
export const ResolutionReportSchema = _ResolutionReportSchema;
export const StoredResolutionReportSchema = _StoredResolutionReportSchema;
export const SuggestedActionSchema = _SuggestedActionSchema;
export const SuggestedActionWriteSchema = _SuggestedActionWriteSchema;
export const summarizeReportValidationIssues = _summarizeReportValidationIssues;
export const AgentProtocolErrorCodeSchema = _AgentProtocolErrorCodeSchema;
export const AgentTurnResultSchema = _AgentTurnResultSchema;
export const DiagnosticToolRequestSchema = _DiagnosticToolRequestSchema;
export const TokenUsageSchema = _TokenUsageSchema;
export const AgentOrchestratorErrorCodeSchema = _AgentOrchestratorErrorCodeSchema;
export const AgentTraceEventSchema = _AgentTraceEventSchema;
export const RetrievalSummaryEntrySchema = _RetrievalSummaryEntrySchema;
export const TicketContextSchema = _TicketContextSchema;
export const StoredTicketContextSchema = _StoredTicketContextSchema;
export const PublicTicketContextSchema = _PublicTicketContextSchema;
export const TICKET_ID_MAX_LENGTH = _TICKET_ID_MAX_LENGTH;
export const TICKET_SUMMARY_MIN_LENGTH = _TICKET_SUMMARY_MIN_LENGTH;
export const TICKET_SUMMARY_MAX_LENGTH = _TICKET_SUMMARY_MAX_LENGTH;
export const PUBLIC_TICKET_SUMMARY_MAX_LENGTH = _PUBLIC_TICKET_SUMMARY_MAX_LENGTH;
export const isLiveExecutionEligible = _isLiveExecutionEligible;
export const isPublicLiveExecutionEligible = _isPublicLiveExecutionEligible;
export const LIVE_RUN_IDEMPOTENCY_KEY_HEADER = _LIVE_RUN_IDEMPOTENCY_KEY_HEADER;
export const LiveRunIdempotencyKeySchema = _LiveRunIdempotencyKeySchema;
export const InvestigationExecutionStageSchema = _InvestigationExecutionStageSchema;
export const InvestigationRunStatusSchema = _InvestigationRunStatusSchema;
export const INVESTIGATION_EXECUTION_STAGE_ORDER = _INVESTIGATION_EXECUTION_STAGE_ORDER;
export const ExecutionStageProgressStatusSchema = _ExecutionStageProgressStatusSchema;
export const ExecutionStageProgressSchema = _ExecutionStageProgressSchema;
export const ExecutionStageProgressListSchema = _ExecutionStageProgressListSchema;
export const ToolFailureCodeSchema = _ToolFailureCodeSchema;
export const ReportValidationFailureCodeSchema = _ReportValidationFailureCodeSchema;
export const InvestigationEventPayloadSchema = _InvestigationEventPayloadSchema;
export const InvestigationEventRecordPayloadSchema = _InvestigationEventRecordPayloadSchema;
export const InvestigationEventRecordSchema = _InvestigationEventRecordSchema;
export const INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT = _INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT;
export const INVESTIGATION_EVENT_LEGACY_TYPE_COUNT = _INVESTIGATION_EVENT_LEGACY_TYPE_COUNT;
export const ToolRequestedRecordEventSchema = _ToolRequestedRecordEventSchema;
export const ToolRequestedWriteEventSchema = _ToolRequestedWriteEventSchema;
export const mapInvestigationEventToExecutionStage = _mapInvestigationEventToExecutionStage;
export const hasCanonicalInvestigationLifecycleMarker = _hasCanonicalInvestigationLifecycleMarker;
export const projectToLegacyAgentTraceEvent = _projectToLegacyAgentTraceEvent;
export const deriveExecutionStageProgress = _deriveExecutionStageProgress;
export const InvestigationEventContractError = _InvestigationEventContractError;

export type { ApprovalDecision, RecordApprovalDecisionInput } from "./agent-run-approval";
export type { EvidenceLocator } from "./evidence";
export type {
  ContinuationReason,
  EvidenceAssessment,
  EvidenceState,
  InvestigationStopReason,
} from "./evidence-assessment";
export type {
  EvidenceReference,
  IncidentCategory,
  RecommendationDisposition,
  ResolutionReport,
  StoredResolutionReport,
  SuggestedAction,
  SuggestedActionWrite,
} from "./resolution-report";
export type { ReportValidationIssue } from "./resolution-report-validation";
export type {
  AgentProtocolErrorCode,
  AgentTurnResult,
  DiagnosticToolRequest,
  TokenUsage,
} from "./agent-turn";
export type { AgentOrchestratorErrorCode } from "./agent-orchestrator";
export type { AgentTraceEvent, RetrievalSummaryEntry } from "./agent-trace-event";
export type { StoredTicketContext, TicketContext } from "./ticket-context";
export type {
  ExecutionStageProgress,
  ExecutionStageProgressList,
  ExecutionStageProgressStatus,
  InvestigationExecutionStage,
  InvestigationRunStatus,
} from "./investigation-execution-stage";
export type {
  InvestigationEventPayload,
  InvestigationEventRecord,
  InvestigationEventRecordPayload,
  InvestigationEventType,
  ReportValidationFailureCode,
  ToolFailureCode,
  ToolRequestedRecordEvent,
  ToolRequestedWriteEvent,
} from "./investigation-event";
export type {
  DeriveExecutionStageProgressInput,
  InvestigationEventContractErrorCode,
} from "./investigation-stage-progress-reducer";
