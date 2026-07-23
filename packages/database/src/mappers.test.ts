import { describe, expect, it } from "vitest";

import { PersistenceError } from "./errors";
import {
  buildOutcome,
  fromAgentJobRow,
  fromAgentRunRow,
  fromFailureCodeRead,
  fromReportRead,
  fromTicketContextRead,
  fromTraceEventRows,
  toFailureCodeWrite,
  toReportWrite,
  toTicketContextWrite,
  toTraceEventCreateInputs,
} from "./mappers";

const VALID_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "Finding" }],
  suggestedActions: [],
};

describe("toTicketContextWrite / fromTicketContextRead", () => {
  it("round-trips a valid ticket context and derives externalTicketId", () => {
    const { ticketContext, externalTicketId } = toTicketContextWrite({
      ticketId: "TKT-1",
      summary: "Summary",
    });
    expect(ticketContext).toEqual({ ticketId: "TKT-1", summary: "Summary" });
    expect(externalTicketId).toBe("TKT-1");
    expect(fromTicketContextRead(ticketContext)).toEqual(ticketContext);
  });

  it("throws PERSISTENCE_VALIDATION_FAILED with a fixed message for an invalid ticket context", () => {
    let caught: unknown;
    try {
      toTicketContextWrite({ summary: "no ticketId" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_VALIDATION_FAILED");
    expect((caught as PersistenceError).message).toBe("Ticket context failed contract validation.");
  });

  it("never leaks the raw invalid value or Zod issue text into the thrown message", () => {
    let caught: unknown;
    try {
      toTicketContextWrite({ ticketId: "leaked-secret-value", extra: "unexpected" });
    } catch (error) {
      caught = error;
    }
    expect((caught as PersistenceError).message).not.toContain("leaked-secret-value");
    expect((caught as PersistenceError).message).not.toContain("unexpected");
  });
});

describe("fromAgentJobRow", () => {
  it("maps a Prisma row into an AgentJobRecord", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const record = fromAgentJobRow({
      id: "job-1",
      ticketContext: { ticketId: "TKT-1", summary: "Summary" },
      externalTicketId: "TKT-1",
      createdAt,
    });
    expect(record).toEqual({
      id: "job-1",
      ticketContext: { ticketId: "TKT-1", summary: "Summary" },
      externalTicketId: "TKT-1",
      createdAt: createdAt.toISOString(),
    });
  });
});

describe("fromAgentRunRow", () => {
  it("maps a Prisma row into an AgentRunRecord", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const record = fromAgentRunRow({
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt,
      finishedAt: null,
      createdAt: startedAt,
    });
    expect(record.status).toBe("RUNNING");
    expect(record.startedAt).toBe(startedAt.toISOString());
    expect(record.finishedAt).toBeNull();
  });
});

describe("toTraceEventCreateInputs / fromTraceEventRows", () => {
  const trace = [
    { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" },
    { type: "TOOL_COMPLETED" as const, toolCallId: "call-1", toolName: "get_service_status" },
    { type: "REPORT_GENERATED" as const },
  ];

  it("assigns contiguous 1-based sequence numbers matching array index", () => {
    const inputs = toTraceEventCreateInputs(trace, "run-1");
    expect(inputs.map((i) => i.sequenceNumber)).toEqual([1, 2, 3]);
    expect(inputs.every((i) => i.runId === "run-1")).toBe(true);
    expect(inputs.map((i) => i.eventType)).toEqual(["TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]);
  });

  it("throws PERSISTENCE_VALIDATION_FAILED for a malformed event", () => {
    expect(() => toTraceEventCreateInputs([{ type: "TOOL_REQUESTED" } as never], "run-1")).toThrow(
      PersistenceError,
    );
  });

  it("revalidates and preserves order when reading rows back", () => {
    const rows = trace.map((payload, i) => ({ sequenceNumber: i + 1, payload }));
    expect(fromTraceEventRows(rows)).toEqual(trace);
  });
});

describe("toReportWrite / fromReportRead", () => {
  it("round-trips a valid report", () => {
    const report = toReportWrite(VALID_REPORT);
    expect(fromReportRead(report)).toEqual(report);
  });

  it("rejects an invalid report", () => {
    expect(() => toReportWrite({ summary: "missing required fields" })).toThrow(PersistenceError);
  });
});

describe("toFailureCodeWrite / fromFailureCodeRead", () => {
  it("round-trips a valid failure code", () => {
    expect(toFailureCodeWrite("TOOL_NOT_FOUND")).toBe("TOOL_NOT_FOUND");
    expect(fromFailureCodeRead("TOOL_NOT_FOUND")).toBe("TOOL_NOT_FOUND");
  });

  it("rejects an unknown failure code", () => {
    expect(() => toFailureCodeWrite("NOT_A_REAL_CODE")).toThrow(PersistenceError);
  });
});

describe("buildOutcome", () => {
  it("builds a RUNNING outcome", () => {
    expect(buildOutcome({ status: "RUNNING", report: null, failureCode: null })).toEqual({ type: "RUNNING" });
  });

  it("builds a COMPLETED outcome with the report", () => {
    expect(buildOutcome({ status: "COMPLETED", report: VALID_REPORT, failureCode: null })).toEqual({
      type: "COMPLETED",
      report: VALID_REPORT,
    });
  });

  it("builds a FAILED outcome with the fixed display message for the code", () => {
    const outcome = buildOutcome({ status: "FAILED", report: null, failureCode: "TOOL_NOT_FOUND" });
    expect(outcome).toEqual({
      type: "FAILED",
      code: "TOOL_NOT_FOUND",
      message: "The requested diagnostic tool is not registered.",
    });
  });
});
