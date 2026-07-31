import { describe, expect, it } from "vitest";

import { PersistenceError } from "./errors";
import {
  buildApprovalView,
  buildOutcome,
  fromAgentJobRow,
  fromAgentRunApprovalRow,
  fromAgentRunRow,
  fromFailureCodeRead,
  fromReportRead,
  fromTicketContextRead,
  fromTraceEventRows,
  toFailureCodeWrite,
  toRecordApprovalDecisionWrite,
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
      summary: "Summary of the reported problem",
    });
    expect(ticketContext).toEqual({ ticketId: "TKT-1", summary: "Summary of the reported problem" });
    expect(externalTicketId).toBe("TKT-1");
    expect(fromTicketContextRead(ticketContext)).toEqual(ticketContext);
  });

  it("normalizes on write: the stored value is the trimmed one", () => {
    const { ticketContext, externalTicketId } = toTicketContextWrite({
      ticketId: "  TKT-1  ",
      summary: "  Summary of the reported problem  ",
    });

    expect(ticketContext).toEqual({ ticketId: "TKT-1", summary: "Summary of the reported problem" });
    // externalTicketId is derived from the NORMALIZED ticketId, so the
    // generated column and the JSONB snapshot cannot disagree.
    expect(externalTicketId).toBe("TKT-1");
  });

  it("rejects a write whose trimmed summary is shorter than 15 characters", () => {
    expect(() => toTicketContextWrite({ ticketId: "TKT-1", summary: "too short" })).toThrow(
      PersistenceError,
    );
  });

  // The read path is looser than the write path on purpose: a row persisted
  // before the 15-character floor existed must stay readable rather than
  // becoming a 500. See StoredTicketContextSchema in @opspilot/contracts.
  it("reads back a stored row that the write path would now reject", () => {
    const legacyRow = { ticketId: "TKT-legacy", summary: "s" };

    expect(fromTicketContextRead(legacyRow)).toEqual(legacyRow);
    expect(() => toTicketContextWrite(legacyRow)).toThrow(PersistenceError);
  });

  it("returns a stored row verbatim rather than re-normalizing it on read", () => {
    const untrimmedRow = { ticketId: " TKT-1 ", summary: " padded stored summary " };

    expect(fromTicketContextRead(untrimmedRow)).toEqual(untrimmedRow);
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

  /**
   * The uncertainty flag has to reach the read model, or the API's DTO mapper has
   * no way to tell a complete cost from a lower bound and will publish both.
   */
  describe("possibleUnobservedCost", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
      startedAt,
      finishedAt: startedAt,
      createdAt: startedAt,
      estimatedCostNanoUsd: 17_956_000n,
      possibleUnobservedCost: false,
      ...overrides,
    });

    it("carries a false flag through unchanged", () => {
      expect(fromAgentRunRow(row()).possibleUnobservedCost).toBe(false);
    });

    it("carries a true flag through unchanged, alongside the observed lower bound", () => {
      const record = fromAgentRunRow(row({ possibleUnobservedCost: true }));

      expect(record.possibleUnobservedCost).toBe(true);
      // The bound is still returned — it is kept for audit, not discarded.
      expect(record.estimatedCostNanoUsd).toBe(17_956_000n);
    });

    it.each([
      ["a NULL column", { possibleUnobservedCost: null }],
      ["an absent property", {}],
    ])("fails closed for %s", (_label, overrides) => {
      // No recorded usage means no basis for vouching for a figure. Both of these
      // rows also have a null cost, so nothing is displayed either way — but the
      // reading that cannot mislead is the one to encode.
      const base = row({ estimatedCostNanoUsd: null });
      if (!("possibleUnobservedCost" in overrides)) delete (base as Record<string, unknown>).possibleUnobservedCost;

      expect(fromAgentRunRow({ ...base, ...overrides }).possibleUnobservedCost).toBe(true);
    });
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

describe("toRecordApprovalDecisionWrite", () => {
  it("parses a well-formed input and returns a matching AgentRunApprovalWrite", () => {
    const write = toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky" });
    expect(write.decision).toBe("APPROVED");
    expect(write.reviewerName).toBe("jacky");
  });

  it("rejects an unknown key", () => {
    expect(() =>
      toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky", extra: 1 }),
    ).toThrow(PersistenceError);
  });

  it("converts an absent note (undefined) to null — the one normalization point in this design", () => {
    const write = toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky" });
    expect(write.note).toBeNull();
  });

  it("preserves a present, already-trimmed note unchanged", () => {
    const write = toRecordApprovalDecisionWrite({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "Looks correct.",
    });
    expect(write.note).toBe("Looks correct.");
  });

  it("trims a present note with surrounding whitespace", () => {
    const write = toRecordApprovalDecisionWrite({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "  Looks correct.  ",
    });
    expect(write.note).toBe("Looks correct.");
  });

  it("throws PersistenceError for a non-object input", () => {
    expect(() => toRecordApprovalDecisionWrite(null)).toThrow(PersistenceError);
    expect(() => toRecordApprovalDecisionWrite("not an object")).toThrow(PersistenceError);
    expect(() => toRecordApprovalDecisionWrite([])).toThrow(PersistenceError);
  });

  it("throws PERSISTENCE_VALIDATION_FAILED with a fixed message, never leaking raw input", () => {
    let caught: unknown;
    try {
      toRecordApprovalDecisionWrite({ decision: "MAYBE", reviewerName: "leaked-secret-value" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_VALIDATION_FAILED");
    expect((caught as PersistenceError).message).not.toContain("leaked-secret-value");
  });
});

describe("fromAgentRunApprovalRow", () => {
  const decidedAt = new Date("2026-01-01T00:00:00.000Z");
  const validRow = {
    id: "8f14e45f-1234-4abc-8def-000000000000",
    runId: "8f14e45f-1234-4abc-8def-000000000001",
    decision: "APPROVED",
    reviewerName: "jacky",
    note: "Looks correct.",
    decidedAt,
  };

  it("maps a well-formed stored row to AgentRunApprovalRecord", () => {
    expect(fromAgentRunApprovalRow(validRow)).toEqual(validRow);
  });

  it("accepts a null note", () => {
    expect(fromAgentRunApprovalRow({ ...validRow, note: null }).note).toBeNull();
  });

  it("throws for an invalid id (not a UUID)", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, id: "not-a-uuid" })).toThrow(PersistenceError);
  });

  it("throws for an invalid runId (not a UUID)", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, runId: "not-a-uuid" })).toThrow(PersistenceError);
  });

  it("throws for an invalid decision", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, decision: "MAYBE" })).toThrow(PersistenceError);
  });

  it("throws for a blank reviewerName", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: "" })).toThrow(PersistenceError);
  });

  it("throws for reviewerName exceeding 100 characters", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: "a".repeat(101) })).toThrow(
      PersistenceError,
    );
  });

  it("throws for reviewerName with leading/trailing whitespace — must reject, not silently trim", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: " jacky " })).toThrow(PersistenceError);
  });

  it("does NOT throw for internal (non-leading/trailing) whitespace in reviewerName", () => {
    expect(fromAgentRunApprovalRow({ ...validRow, reviewerName: "jacky smith" }).reviewerName).toBe(
      "jacky smith",
    );
  });

  it("throws for a blank non-null note", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: "" })).toThrow(PersistenceError);
  });

  it("throws for note exceeding 1000 characters", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: "a".repeat(1001) })).toThrow(PersistenceError);
  });

  it("throws for note with leading/trailing whitespace", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: " note " })).toThrow(PersistenceError);
  });

  it("throws for a non-Date decidedAt", () => {
    expect(() =>
      fromAgentRunApprovalRow({ ...validRow, decidedAt: "2026-01-01T00:00:00.000Z" as unknown as Date }),
    ).toThrow(PersistenceError);
  });

  it("throws for an unknown stored key", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, extra: "unexpected" } as never)).toThrow(
      PersistenceError,
    );
  });
});

describe("buildApprovalView", () => {
  const record = {
    id: "8f14e45f-1234-4abc-8def-000000000000",
    runId: "8f14e45f-1234-4abc-8def-000000000001",
    decision: "APPROVED" as const,
    reviewerName: "jacky",
    note: null,
    decidedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("returns PENDING when eligible and no record exists", () => {
    expect(buildApprovalView("run-1", true, null)).toEqual({
      runId: "run-1",
      status: "PENDING",
      reviewerName: null,
      note: null,
      decidedAt: null,
    });
  });

  it("returns NOT_ELIGIBLE when not eligible and no record exists", () => {
    expect(buildApprovalView("run-1", false, null)).toEqual({
      runId: "run-1",
      status: "NOT_ELIGIBLE",
      reviewerName: null,
      note: null,
      decidedAt: null,
    });
  });

  it("returns the record's decision as status when a record is present", () => {
    expect(buildApprovalView("run-1", true, record)).toEqual({
      runId: "run-1",
      status: "APPROVED",
      reviewerName: "jacky",
      note: null,
      decidedAt: record.decidedAt,
    });
  });
});
