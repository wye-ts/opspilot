import { z } from "zod";

import { AgentOrchestratorErrorCodeSchema } from "./agent-orchestrator";
import {
  ReportGeneratedTraceEventSchema,
  RetrievalCompletedTraceEventSchema,
  ToolCompletedTraceEventSchema,
  ToolRequestedTraceEventSchema,
} from "./agent-trace-event";
import { EvidenceAssessmentSchema } from "./evidence-assessment";
import {
  InvestigationExecutionStageSchema,
  type InvestigationExecutionStage,
} from "./investigation-execution-stage";

// Repository-evidenced subset of AgentOrchestratorErrorCodeSchema that a
// TOOL_FAILED event may carry — traced against the exact codes
// packages/agent-runtime/src/agent/agent-orchestrator.ts's tool-handling
// branch actually produces (TOOL_NOT_FOUND, TOOL_INPUT_INVALID,
// TOOL_EXECUTION_FAILED, TOOL_OUTPUT_INVALID). A report/provider/persistence
// failure code must never validate here.
export const ToolFailureCodeSchema = z.enum([
  "TOOL_NOT_FOUND",
  "TOOL_INPUT_INVALID",
  "TOOL_EXECUTION_FAILED",
  "TOOL_OUTPUT_INVALID",
]);

export type ToolFailureCode = z.infer<typeof ToolFailureCodeSchema>;

// Repository-evidenced subset for REPORT_VALIDATION_FAILED — the only two
// codes the orchestrator's report_submission branch ever produces before a
// report is accepted. A tool/provider failure code must never validate here.
export const ReportValidationFailureCodeSchema = z.enum([
  "REPORT_SCHEMA_INVALID",
  "REPORT_EVIDENCE_INVALID",
]);

export type ReportValidationFailureCode = z.infer<
  typeof ReportValidationFailureCodeSchema
>;

// ── The 12 new-write event types ────────────────────────────────────────
//
// Each branch is the PAYLOAD only — the immutable fact an
// orchestrator/service can construct before persistence exists at all. No
// runId, sequence, or recordedAt: those belong solely to
// InvestigationEventRecordSchema below, because recordedAt in particular
// (the database created_at) does not exist until a row is actually
// inserted, so it cannot be a required field on something emitted before
// that insert.
//
// RETRIEVAL_COMPLETED / TOOL_REQUESTED / TOOL_COMPLETED reuse the exact
// schema objects agent-trace-event.ts already exports, so the overlapping
// event types cannot structurally drift between the legacy trace contract
// and this one — the same object is referenced by both discriminated
// unions, not two independently authored copies of the same shape.

const RunCreatedEventSchema = z.object({ type: z.literal("RUN_CREATED") }).strict().readonly();

const AgentStartedEventSchema = z.object({ type: z.literal("AGENT_STARTED") }).strict().readonly();

const ToolFailedEventSchema = z
  .object({
    type: z.literal("TOOL_FAILED"),
    toolCallId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    failureCode: ToolFailureCodeSchema,
  })
  .strict()
  .readonly();

// Pushed immediately before the orchestrator's finalization-phase provider
// call — see packages/agent-runtime/src/agent/agent-orchestrator.ts, where
// `phase` is already computed as "FINALIZATION" for the last turn before
// that call is made (turnIndex === MAX_PROVIDER_TURNS - 1), the one
// deterministic point at which a report submission is guaranteed to be
// what's being requested. Never fires on the direct/no-tool path, where the
// very first, unconstrained turn produces the report — that path has no
// preceding long wait to announce (see docs/16-investigation-event-contract.md §5).
const ReportGenerationStartedEventSchema = z
  .object({ type: z.literal("REPORT_GENERATION_STARTED") })
  .strict()
  .readonly();

const ReportSubmittedEventSchema = z.object({ type: z.literal("REPORT_SUBMITTED") }).strict().readonly();

const ReportValidatedEventSchema = z.object({ type: z.literal("REPORT_VALIDATED") }).strict().readonly();

const ReportValidationFailedEventSchema = z
  .object({
    type: z.literal("REPORT_VALIDATION_FAILED"),
    failureCode: ReportValidationFailureCodeSchema,
  })
  .strict()
  .readonly();

const RunCompletedEventSchema = z.object({ type: z.literal("RUN_COMPLETED") }).strict().readonly();

// The full AgentOrchestratorErrorCodeSchema union is deliberately used here,
// unlike TOOL_FAILED/REPORT_VALIDATION_FAILED above — a run can fail for
// any reason the orchestrator recognizes (provider, tool, report, or
// retrieval), so RUN_FAILED is the one terminal catch-all, not a narrow
// subset.
//
// THERE IS NO free-form `failureMessage` FIELD, deliberately. A persisted,
// browser-readable lifecycle event carries only a closed-enum code and the
// stage it failed in; a `.max(500)` string field would have been an
// unbounded channel for whatever a future caller happened to pass —
// provider text, an authorization header, a stack trace — and `.strict()`
// alone cannot make free text safe. Safe user-facing wording is derived
// from `failureCode` through a fixed mapping at the API/UI boundary (the
// existing FAILURE_DISPLAY_MESSAGES pattern in packages/database), never
// carried in the event itself. A test asserts a credential-bearing
// `failureMessage` is rejected by this schema.
const RunFailedEventSchema = z
  .object({
    type: z.literal("RUN_FAILED"),
    failureCode: AgentOrchestratorErrorCodeSchema,
    failedStage: InvestigationExecutionStageSchema,
  })
  .strict()
  .readonly();

// The 12 new-write branches, defined once and reused by both the
// write-eligible payload union and the wider read/record union below — so
// neither list can drift out of sync with the other.
const NEW_WRITE_EVENT_BRANCHES = [
  RunCreatedEventSchema,
  AgentStartedEventSchema,
  RetrievalCompletedTraceEventSchema,
  ToolRequestedTraceEventSchema,
  ToolCompletedTraceEventSchema,
  ToolFailedEventSchema,
  ReportGenerationStartedEventSchema,
  ReportSubmittedEventSchema,
  ReportValidatedEventSchema,
  ReportValidationFailedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
] as const;

// Shared TOOL_REQUESTED field shape for the canonical write/record split
// (Issue #58 §5.3, resolves P1-5), derived from ToolRequestedTraceEventSchema
// itself via .unwrap() rather than re-declared — so the `type`/`toolCallId`/
// `toolName` bounds have exactly one owner (agent-trace-event.ts) and cannot
// drift from the legacy trace object the way a hand-authored copy could.
const ToolRequestedTraceEventBaseSchema = ToolRequestedTraceEventSchema.unwrap();

// RECORD/READ only (Checkpoint A): assessment OPTIONAL so every #57-and-earlier
// TOOL_REQUESTED row, which never carried one, stays readable. The WRITE side
// (NEW_WRITE_EVENT_BRANCHES) deliberately still uses the unchanged
// ToolRequestedTraceEventSchema until Checkpoint B, when the orchestrator
// starts supplying `assessment` on every emission — the write-required schema
// and the producer change can only land together.
export const ToolRequestedRecordEventSchema = ToolRequestedTraceEventBaseSchema
  .extend({ assessment: EvidenceAssessmentSchema.optional() })
  .readonly();

export type ToolRequestedRecordEvent = z.infer<typeof ToolRequestedRecordEventSchema>;

// The write-eligible payload contract: exactly the 12 new-write types.
// REPORT_GENERATED is deliberately NOT a member — an orchestrator/service
// emitting a new canonical event stream can never construct one (see
// docs/16-investigation-event-contract.md §5's "do not write REPORT_GENERATED
// for new canonical event streams"), enforced here structurally rather than
// only by convention.
export const InvestigationEventPayloadSchema = z.discriminatedUnion(
  "type",
  NEW_WRITE_EVENT_BRANCHES,
);

export type InvestigationEventPayload = z.infer<typeof InvestigationEventPayloadSchema>;

export type InvestigationEventType = InvestigationEventPayload["type"];

// The 12 new-write types plus the one permanently accepted legacy
// read-compat type. Used only by InvestigationEventRecordSchema below —
// never by InvestigationEventPayloadSchema — because a persisted/read
// record may legitimately be a pre-#37 legacy row, but nothing should ever
// construct a fresh REPORT_GENERATED payload going forward.
//
// The read-side TOOL_REQUESTED slot uses ToolRequestedRecordEventSchema
// (assessment OPTIONAL, Issue #58 Checkpoint A) — a stored record may carry an
// assessment from a future write, and a pre-#58 row without one stays readable
// because the field is optional. The WRITE side (NEW_WRITE_EVENT_BRANCHES,
// InvestigationEventPayloadSchema) keeps the unchanged legacy trace object
// until Checkpoint B. RETRIEVAL_COMPLETED and TOOL_COMPLETED still reuse the
// exact legacy schema objects byte-for-byte, so those two slots cannot drift
// at all. TOOL_REQUESTED intentionally cannot stay byte-identical once it
// carries canonical assessment metadata the legacy trace object never had —
// but its `type`/`toolCallId`/`toolName` bounds are still single-sourced,
// derived via ToolRequestedTraceEventSchema.unwrap().extend(...) rather than
// re-declared, so only the added `assessment` field can differ.
const INVESTIGATION_EVENT_RECORD_BRANCHES = [
  RunCreatedEventSchema,
  AgentStartedEventSchema,
  RetrievalCompletedTraceEventSchema,
  ToolRequestedRecordEventSchema,
  ToolCompletedTraceEventSchema,
  ToolFailedEventSchema,
  ReportGenerationStartedEventSchema,
  ReportSubmittedEventSchema,
  ReportValidatedEventSchema,
  ReportValidationFailedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  ReportGeneratedTraceEventSchema,
] as const;

export const InvestigationEventRecordPayloadSchema = z.discriminatedUnion(
  "type",
  INVESTIGATION_EVENT_RECORD_BRANCHES,
);

export type InvestigationEventRecordPayload = z.infer<
  typeof InvestigationEventRecordPayloadSchema
>;

// The persisted/read event record — payload plus the three facts that only
// exist once a row has actually been written. Nested (`payload`), not
// flattened, matching the repository's own existing convention for the
// legacy trace contract (packages/database/src/mappers.ts's
// TraceEventCreateInput: `{ runId, sequenceNumber, eventType, payload }`).
//
// recordedAt is the database created_at / recording time — honestly named,
// not occurredAt: see docs/16-investigation-event-contract.md §4 for why
// (batch-written legacy rows share one coarse value per run; only
// incremental per-event writes from #37 make it a meaningfully precise
// per-event time). Ordering is always by `sequence`, never by recordedAt.
export const InvestigationEventRecordSchema = z
  .object({
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    recordedAt: z.string().datetime(),
    payload: InvestigationEventRecordPayloadSchema,
  })
  .strict()
  .readonly();

export type InvestigationEventRecord = z.infer<typeof InvestigationEventRecordSchema>;

// The exhaustive, corrected taxonomy count: 12 new-write types + 1 legacy
// read-compat type. Exported as a literal constant so tests/docs assert
// against one source instead of re-counting union members by hand.
export const INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT = 12;
export const INVESTIGATION_EVENT_LEGACY_TYPE_COUNT = 1;

/**
 * Maps an investigation event (canonical or legacy) to the execution stage it
 * belongs to.
 *
 * Returns `null` for terminal events (RUN_COMPLETED, RUN_FAILED) and for the
 * legacy read-compat REPORT_GENERATED type — none of these map to an execution
 * stage row.
 */
export function mapInvestigationEventToExecutionStage(
  payload: InvestigationEventRecordPayload,
): InvestigationExecutionStage | null {
  switch (payload.type) {
    case "RUN_CREATED":
      return "INVESTIGATION_CREATED";
    case "AGENT_STARTED":
    case "RETRIEVAL_COMPLETED":
      return "AGENT_ANALYSIS";
    case "TOOL_REQUESTED":
    case "TOOL_COMPLETED":
    case "TOOL_FAILED":
      return "DIAGNOSTIC_EXECUTION";
    case "REPORT_GENERATION_STARTED":
    case "REPORT_SUBMITTED":
    case "REPORT_VALIDATED":
    case "REPORT_VALIDATION_FAILED":
      return "REPORT_GENERATION";
    case "RUN_COMPLETED":
    case "RUN_FAILED":
    case "REPORT_GENERATED":
      return null;
  }
}
