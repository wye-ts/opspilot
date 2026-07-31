import { z } from "zod";
import { describe, expect, it } from "vitest";

import { PersistenceError } from "./errors";
import {
  AgentRunApprovalRowSchema,
  StoredTicketContextSchema,
  TicketContextSchema,
  validateOrThrow,
} from "./validation";

describe("validateOrThrow", () => {
  const schema = z.object({ id: z.string().min(1) }).strict();

  it("returns the parsed value on success", () => {
    expect(validateOrThrow(schema, { id: "ok" }, "Thing")).toEqual({ id: "ok" });
  });

  it("throws PERSISTENCE_VALIDATION_FAILED with a fixed message on failure", () => {
    let caught: unknown;
    try {
      validateOrThrow(schema, { id: "" }, "Thing");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_VALIDATION_FAILED");
    expect((caught as PersistenceError).message).toBe("Thing failed contract validation.");
  });

  it("retains the Zod error only as the internal cause, never in .message", () => {
    let caught: unknown;
    try {
      validateOrThrow(schema, { id: "" }, "Thing");
    } catch (error) {
      caught = error;
    }
    const persistenceError = caught as PersistenceError;
    expect(persistenceError.cause).toBeInstanceOf(z.ZodError);
    expect(persistenceError.message).not.toMatch(/issues|path|code/i);
  });
});

describe("TicketContextSchema", () => {
  const validSummary = "Elevated error rate on billing";

  it("accepts the narrow { ticketId, summary } shape", () => {
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: validSummary }).success).toBe(true);
  });

  it("rejects extra fields (strict) and missing fields", () => {
    expect(
      TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: validSummary, extra: 1 }).success,
    ).toBe(false);
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1" }).success).toBe(false);
    expect(TicketContextSchema.safeParse({ ticketId: "", summary: validSummary }).success).toBe(false);
  });

  it("enforces the trimmed 15-character summary floor at the write boundary", () => {
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s" }).success).toBe(false);
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "   ".repeat(10) }).success).toBe(
      false,
    );
  });
});

describe("StoredTicketContextSchema", () => {
  it("accepts a row persisted before the write-path bounds existed", () => {
    // Re-exported here (not just from @opspilot/contracts) because this is the
    // schema the persistence read path actually uses — fromTicketContextRead.
    expect(StoredTicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s" }).success).toBe(true);
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s" }).success).toBe(false);
  });

  it("still rejects a malformed row", () => {
    expect(StoredTicketContextSchema.safeParse({ ticketId: "TKT-1" }).success).toBe(false);
    expect(StoredTicketContextSchema.safeParse({ ticketId: "", summary: "s" }).success).toBe(false);
    expect(
      StoredTicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("AgentRunApprovalRowSchema", () => {
  const validRow = {
    id: "8f14e45f-1234-4abc-8def-000000000000",
    runId: "8f14e45f-1234-4abc-8def-000000000001",
    decision: "APPROVED",
    reviewerName: "jacky",
    note: "Looks correct.",
    decidedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("accepts a valid row", () => {
    expect(AgentRunApprovalRowSchema.safeParse(validRow).success).toBe(true);
  });

  it("accepts a null note", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, note: null }).success).toBe(true);
  });

  it("rejects an invalid id/runId UUID", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, id: "not-a-uuid" }).success).toBe(false);
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, runId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an invalid decision", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, decision: "MAYBE" }).success).toBe(false);
  });

  it("rejects a blank reviewerName", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, reviewerName: "" }).success).toBe(false);
  });

  it("rejects reviewerName exceeding 100 characters", () => {
    expect(
      AgentRunApprovalRowSchema.safeParse({ ...validRow, reviewerName: "a".repeat(101) }).success,
    ).toBe(false);
  });

  it("rejects reviewerName with leading/trailing whitespace (does not normalize it)", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, reviewerName: " jacky " }).success).toBe(
      false,
    );
  });

  it("accepts internal whitespace in reviewerName", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, reviewerName: "jacky smith" }).success).toBe(
      true,
    );
  });

  it("rejects a blank non-null note", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, note: "" }).success).toBe(false);
  });

  it("rejects note exceeding 1000 characters", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, note: "a".repeat(1001) }).success).toBe(
      false,
    );
  });

  it("rejects note with leading/trailing whitespace (does not normalize it)", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, note: " note " }).success).toBe(false);
  });

  it("rejects a non-Date decidedAt", () => {
    expect(
      AgentRunApprovalRowSchema.safeParse({ ...validRow, decidedAt: "2026-01-01T00:00:00.000Z" }).success,
    ).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(AgentRunApprovalRowSchema.safeParse({ ...validRow, extra: "unexpected" }).success).toBe(false);
  });
});
