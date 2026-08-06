import {
  AgentOrchestratorErrorCodeSchema,
  AgentTraceEventSchema,
  hasCanonicalInvestigationLifecycleMarker,
  InvestigationEventPayloadSchema,
  InvestigationEventRecordSchema,
  projectToLegacyAgentTraceEvent,
  RecordApprovalDecisionInputSchema,
  ResolutionReportSchema,
  type AgentOrchestratorErrorCode,
  type AgentTraceEvent,
  type InvestigationEventPayload,
  type InvestigationEventRecord,
  type ResolutionReport,
} from "@opspilot/contracts";

import { PersistenceError } from "./errors";
import { FAILURE_DISPLAY_MESSAGES } from "./failure-messages";
import type {
  AgentJobRecord,
  AgentRunApprovalRecord,
  AgentRunApprovalView,
  AgentRunApprovalWrite,
  AgentRunOutcome,
  AgentRunRecord,
  AgentRunStatus,
  ProviderMode,
  TicketContext,
} from "./types";
import {
  AgentRunApprovalRowSchema,
  StoredTicketContextSchema,
  TicketContextSchema,
  validateOrThrow,
} from "./validation";

const AgentTraceEventArraySchema = AgentTraceEventSchema.array();

// The WRITE boundary: enforces the trimmed 15–2000 summary / ≤64 ticketId
// bounds and returns the NORMALIZED value, which is what actually gets stored.
export function toTicketContextWrite(value: unknown): {
  ticketContext: TicketContext;
  externalTicketId: string;
} {
  const ticketContext = validateOrThrow(TicketContextSchema, value, "Ticket context");
  return { ticketContext, externalTicketId: ticketContext.ticketId };
}

// The READ boundary: revalidates the stored snapshot against the looser
// StoredTicketContextSchema, deliberately NOT the write schema. A row accepted
// under the pre-milestone `min(1)` rule stays readable, and the value is
// returned exactly as persisted rather than re-normalized on the way out. See
// StoredTicketContextSchema in @opspilot/contracts.
export function fromTicketContextRead(value: unknown): TicketContext {
  return validateOrThrow(StoredTicketContextSchema, value, "Stored ticket context");
}

export function fromAgentJobRow(row: {
  id: string;
  ticketContext: unknown;
  externalTicketId: string;
  createdAt: Date;
}): AgentJobRecord {
  return {
    id: row.id,
    ticketContext: fromTicketContextRead(row.ticketContext),
    externalTicketId: row.externalTicketId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function fromAgentRunRow(row: {
  id: string;
  jobId: string;
  attemptNumber: number;
  status: string;
  providerMode: string;
  modelIdentifier: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  estimatedCostNanoUsd?: bigint | null;
  possibleUnobservedCost?: boolean | null;
}): AgentRunRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    attemptNumber: row.attemptNumber,
    status: row.status as AgentRunStatus,
    providerMode: row.providerMode as ProviderMode,
    modelIdentifier: row.modelIdentifier,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // Carried as a bigint all the way to the DTO boundary, which formats it to a
    // decimal string. It is never handed to JSON.stringify, which throws on one
    // — and that throw is a useful backstop rather than a hazard.
    estimatedCostNanoUsd: row.estimatedCostNanoUsd ?? null,
    // Absent or NULL means the run never recorded usage at all — every FAKE run,
    // and any run that has not finalized. `true` is the fail-closed reading:
    // "we cannot vouch for this figure". It costs nothing in practice, because a
    // row with no usage also has a null cost and is hidden on that basis alone;
    // it matters only if the two columns could ever disagree, and then hiding is
    // the answer that cannot mislead.
    possibleUnobservedCost: row.possibleUnobservedCost ?? true,
  };
}

export interface TraceEventCreateInput {
  runId: string;
  sequenceNumber: number;
  eventType: string;
  payload: AgentTraceEvent;
}

export function toTraceEventCreateInputs(
  trace: readonly AgentTraceEvent[],
  runId: string,
): TraceEventCreateInput[] {
  const validated = validateOrThrow(AgentTraceEventArraySchema, trace, "Trace events");
  return validated.map((event, index) => ({
    runId,
    sequenceNumber: index + 1,
    eventType: event.type,
    payload: event,
  }));
}

/**
 * The canonical-write mapping boundary (docs/reviews/21-...md §4/§7,
 * Phase A2). Accepts only `InvestigationEventPayload` — the 12 new-write
 * types — so a legacy `REPORT_GENERATED` payload is rejected here exactly
 * as it is rejected by `InvestigationEventPayloadSchema` itself: nothing can
 * construct a fresh legacy-typed canonical write.
 *
 * Deliberately produces no `recordedAt`: that value does not exist until a
 * row is actually inserted (the database's own `created_at`), so this
 * create-input shape has no field for an application-generated one to occupy.
 * It also carries nothing resembling `clientRequestId` — that concept
 * belongs to `agent_runs`, not to an individual ledger event.
 */
export interface InvestigationEventCreateInput {
  runId: string;
  sequenceNumber: number;
  eventType: string;
  payload: InvestigationEventPayload;
}

export function toInvestigationEventCreateInput(
  runId: string,
  sequenceNumber: number,
  payload: unknown,
): InvestigationEventCreateInput {
  const validated = validateOrThrow(InvestigationEventPayloadSchema, payload, "Investigation event payload");
  return { runId, sequenceNumber, eventType: validated.type, payload: validated };
}

/**
 * The canonical-read mapping boundary. `sequence` is the sole ordering key
 * (never `recordedAt`) and must be exactly contiguous `1..N` — a gap,
 * duplicate, zero, or non-one-based starting sequence means the stored rows
 * were never actually written by `appendInvestigationEvent`'s allocator,
 * which always assigns the next contiguous integer under the run's row
 * lock. Rejecting this here, before assembling any record, is what stops a
 * corrupt or partially-written stream from being silently read back as a
 * plausible-looking prefix.
 *
 * `recordedAt` is sourced ONLY from the row's own `created_at` — never from
 * an application clock read — matching `InvestigationEventRecordSchema`'s
 * documented meaning of "the database recording time".
 */
export function fromInvestigationEventRows(
  runId: string,
  rows: ReadonlyArray<{ sequenceNumber: number; payload: unknown; createdAt: Date }>,
): readonly InvestigationEventRecord[] {
  rows.forEach((row, index) => {
    if (row.sequenceNumber !== index + 1) {
      throw new PersistenceError(
        "PERSISTENCE_VALIDATION_FAILED",
        "Stored canonical event sequence is not contiguous starting at 1.",
      );
    }
  });
  return rows.map((row) =>
    validateOrThrow(
      InvestigationEventRecordSchema,
      {
        runId,
        sequence: row.sequenceNumber,
        recordedAt: row.createdAt.toISOString(),
        payload: row.payload,
      },
      `Investigation event record (sequence ${row.sequenceNumber})`,
    ),
  );
}

/**
 * Two read modes over one physical ledger (docs/reviews/21-...md §7):
 *
 *   canonical marker present -> project through projectToLegacyAgentTraceEvent,
 *                                dropping lifecycle-only nulls
 *   canonical marker absent  -> the original, byte-for-byte unchanged
 *                                AgentTraceEventSchema read path
 *
 * Raw `sequence_number` contiguity is enforced FIRST, on the raw rows,
 * before origin detection or projection ever run — a corrupt stored
 * sequence is rejected regardless of which format wrote it, and never
 * silently repaired by dropping the offending row instead of raising.
 *
 * The marker check needs only `sequence`/`payload.type` shape (see
 * `hasCanonicalInvestigationLifecycleMarker`'s own doc comment on why it is
 * deliberately defensive rather than schema-validating) — the loosely-typed
 * probe object below is never treated as a real `InvestigationEventRecord`;
 * `fromInvestigationEventRows` performs the real, fully-validated
 * conversion once a stream is confirmed canonical.
 */
export function fromTraceEventRows(
  runId: string,
  rows: ReadonlyArray<{ sequenceNumber: number; payload: unknown; createdAt: Date }>,
): readonly AgentTraceEvent[] {
  rows.forEach((row, index) => {
    if (row.sequenceNumber !== index + 1) {
      throw new PersistenceError(
        "PERSISTENCE_VALIDATION_FAILED",
        "Stored trace sequence is not contiguous starting at 1.",
      );
    }
  });

  const markerProbe = rows.map((row) => ({
    sequence: row.sequenceNumber,
    payload: row.payload,
  })) as unknown as readonly InvestigationEventRecord[];

  if (hasCanonicalInvestigationLifecycleMarker(markerProbe)) {
    const records = fromInvestigationEventRows(runId, rows);
    const projected: AgentTraceEvent[] = [];
    for (const record of records) {
      const legacyEvent = projectToLegacyAgentTraceEvent(record);
      if (legacyEvent !== null) projected.push(legacyEvent);
    }
    return projected;
  }

  return rows.map((row) =>
    validateOrThrow(AgentTraceEventSchema, row.payload, `Trace event (sequence ${row.sequenceNumber})`),
  );
}

export function toReportWrite(value: unknown): ResolutionReport {
  return validateOrThrow(ResolutionReportSchema, value, "Resolution report");
}

export function fromReportRead(value: unknown): ResolutionReport {
  return validateOrThrow(ResolutionReportSchema, value, "Stored resolution report");
}

export function toFailureCodeWrite(value: unknown): AgentOrchestratorErrorCode {
  return validateOrThrow(AgentOrchestratorErrorCodeSchema, value, "Failure code");
}

export function fromFailureCodeRead(value: unknown): AgentOrchestratorErrorCode {
  return validateOrThrow(AgentOrchestratorErrorCodeSchema, value, "Stored failure code");
}

export function buildOutcome(row: {
  status: string;
  report: unknown;
  failureCode: string | null;
}): AgentRunOutcome {
  if (row.status === "COMPLETED") {
    return { type: "COMPLETED", report: fromReportRead(row.report) };
  }
  if (row.status === "FAILED") {
    const code = fromFailureCodeRead(row.failureCode);
    return { type: "FAILED", code, message: FAILURE_DISPLAY_MESSAGES[code] };
  }
  return { type: "RUNNING" };
}

// The SOLE parse boundary for the approval write path. Accepts `unknown`, not
// a pre-typed RecordApprovalDecisionParams — this function IS the runtime
// validation boundary, not a post-parse formatter. Reuses validateOrThrow
// exactly like every other toXWrite mapper in this file, so a Zod failure
// becomes PersistenceError("PERSISTENCE_VALIDATION_FAILED",
// "Approval decision input failed contract validation.", { cause }) — not a
// raw, unnormalized ZodError. The repository calls only this function and
// never separately parses RecordApprovalDecisionInputSchema itself.
export function toRecordApprovalDecisionWrite(input: unknown): AgentRunApprovalWrite {
  const parsed = validateOrThrow(RecordApprovalDecisionInputSchema, input, "Approval decision input");
  return {
    decision: parsed.decision,
    reviewerName: parsed.reviewerName,
    note: parsed.note ?? null, // the one and only undefined -> null conversion
  };
}

// Revalidates a stored row on every read (INSERT...RETURNING, the
// replay-match read inside recordApprovalDecision, and getApprovalDecision's
// read alike). z.infer<typeof AgentRunApprovalRowSchema> is structurally
// identical to AgentRunApprovalRecord, so this is a direct pass-through of
// the parsed value.
export function fromAgentRunApprovalRow(row: {
  id: string;
  runId: string;
  decision: string;
  reviewerName: string;
  note: string | null;
  decidedAt: Date;
}): AgentRunApprovalRecord {
  return validateOrThrow(AgentRunApprovalRowSchema, row, "Stored agent run approval");
}

// Assembles the GET-time (and POST-response-time) read model. `eligible` is
// always computed by the caller from the same agent_runs read that produced
// (or didn't produce) `record` — this function does not re-derive it.
export function buildApprovalView(
  runId: string,
  eligible: boolean,
  record: AgentRunApprovalRecord | null,
): AgentRunApprovalView {
  if (record) {
    return {
      runId,
      status: record.decision,
      reviewerName: record.reviewerName,
      note: record.note,
      decidedAt: record.decidedAt,
    };
  }
  return { runId, status: eligible ? "PENDING" : "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null };
}
