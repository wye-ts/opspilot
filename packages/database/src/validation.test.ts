import { z } from "zod";
import { describe, expect, it } from "vitest";

import { PersistenceError } from "./errors";
import { TicketContextSchema, validateOrThrow } from "./validation";

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
  it("accepts the narrow { ticketId, summary } shape", () => {
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s" }).success).toBe(true);
  });

  it("rejects extra fields (strict) and missing fields", () => {
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1", summary: "s", extra: 1 }).success).toBe(
      false,
    );
    expect(TicketContextSchema.safeParse({ ticketId: "TKT-1" }).success).toBe(false);
    expect(TicketContextSchema.safeParse({ ticketId: "", summary: "s" }).success).toBe(false);
  });
});
