import {
  AgentOrchestratorErrorCodeSchema,
  AgentTraceEventSchema,
  ResolutionReportSchema,
  type AgentOrchestratorErrorCode,
  type AgentTraceEvent,
  type ResolutionReport,
} from "@opspilot/contracts";

import { PersistenceError } from "./errors";
import { FAILURE_DISPLAY_MESSAGES } from "./failure-messages";
import type {
  AgentJobRecord,
  AgentRunOutcome,
  AgentRunRecord,
  AgentRunStatus,
  ProviderMode,
  TicketContext,
} from "./types";
import { TicketContextSchema, validateOrThrow } from "./validation";

const AgentTraceEventArraySchema = AgentTraceEventSchema.array();

export function toTicketContextWrite(value: unknown): {
  ticketContext: TicketContext;
  externalTicketId: string;
} {
  const ticketContext = validateOrThrow(TicketContextSchema, value, "Ticket context");
  return { ticketContext, externalTicketId: ticketContext.ticketId };
}

export function fromTicketContextRead(value: unknown): TicketContext {
  return validateOrThrow(TicketContextSchema, value, "Stored ticket context");
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

export function fromTraceEventRows(
  rows: ReadonlyArray<{ sequenceNumber: number; payload: unknown }>,
): readonly AgentTraceEvent[] {
  // rows must already be ORDER BY sequence_number ASC from the query — this
  // function does not re-sort, it only revalidates each payload. A gap,
  // duplicate, zero, or non-one-based starting sequence indicates the
  // stored trace was never actually written by finalizeCompleted/
  // finalizeFailed (which always assigns exactly 1..N) — reject it rather
  // than silently returning a corrupt/partial trace.
  rows.forEach((row, index) => {
    if (row.sequenceNumber !== index + 1) {
      throw new PersistenceError(
        "PERSISTENCE_VALIDATION_FAILED",
        "Stored trace sequence is not contiguous starting at 1.",
      );
    }
  });
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
