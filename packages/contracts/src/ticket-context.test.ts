import { describe, expect, it } from "vitest";

import { TicketContextSchema } from "./ticket-context";

const validTicketContext = {
  ticketId: "TICKET-2001",
  summary: "Elevated API error rate on billing-service",
} as const;

describe("TicketContextSchema", () => {
  it("accepts a valid ticketId and summary", () => {
    const result = TicketContextSchema.safeParse(validTicketContext);

    expect(result.success).toBe(true);
  });

  it("rejects a missing ticketId", () => {
    const { ticketId: _ticketId, ...withoutTicketId } = validTicketContext;
    const result = TicketContextSchema.safeParse(withoutTicketId);

    expect(result.success).toBe(false);
  });

  it("rejects a missing summary", () => {
    const { summary: _summary, ...withoutSummary } = validTicketContext;
    const result = TicketContextSchema.safeParse(withoutSummary);

    expect(result.success).toBe(false);
  });

  it("rejects an empty ticketId", () => {
    const result = TicketContextSchema.safeParse({ ...validTicketContext, ticketId: "" });

    expect(result.success).toBe(false);
  });

  it("rejects an empty summary", () => {
    const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: "" });

    expect(result.success).toBe(false);
  });

  it("rejects a non-string ticketId", () => {
    const result = TicketContextSchema.safeParse({ ...validTicketContext, ticketId: 2001 });

    expect(result.success).toBe(false);
  });

  it("rejects a non-string summary", () => {
    const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: null });

    expect(result.success).toBe(false);
  });

  it("rejects extra properties under strict mode", () => {
    const result = TicketContextSchema.safeParse({
      ...validTicketContext,
      priority: "HIGH",
    });

    expect(result.success).toBe(false);
  });
});
