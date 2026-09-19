import { describe, expect, it } from "vitest";

import { TICKET_COMBINATION_COUNT, generateTickets } from "./completion-rate-tickets";

/**
 * The defect these guard against: the measurement previously cycled five
 * hand-written tickets with `TICKETS[i % 5]`, so a 15-run round was five
 * tickets repeated three times while being reported as fifteen samples. A
 * completion rate computed over repeats overstates its own sample size.
 */
describe("generateTickets", () => {
  it("produces the requested number of tickets", () => {
    expect(generateTickets(15, 1)).toHaveLength(15);
  });

  it("never repeats a ticket within a round — the i % 5 defect", () => {
    const tickets = generateTickets(15, 20260919);
    expect(new Set(tickets.map((ticket) => ticket.summary)).size).toBe(15);
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(15);
  });

  it("never repeats even when the full combination space is drawn", () => {
    const tickets = generateTickets(TICKET_COMBINATION_COUNT, 7);
    expect(new Set(tickets.map((ticket) => ticket.summary)).size).toBe(TICKET_COMBINATION_COUNT);
  });

  it("refuses to exceed the combination space rather than silently repeating", () => {
    expect(() => generateTickets(TICKET_COMBINATION_COUNT + 1, 1)).toThrow(/exceeds/);
  });

  // Determinism matters because a recorded round has to be reproducible from
  // its seed — the run ledger in docs/reviews/48-... depends on it.
  it("is deterministic for a given seed", () => {
    expect(generateTickets(10, 42)).toEqual(generateTickets(10, 42));
  });

  it("produces different sets for different seeds", () => {
    const a = generateTickets(10, 1).map((ticket) => ticket.summary);
    const b = generateTickets(10, 2).map((ticket) => ticket.summary);
    expect(a).not.toEqual(b);
  });

  it("records the parameters that produced each ticket, for failure tracing", () => {
    for (const ticket of generateTickets(15, 3)) {
      expect(ticket.parameters.serviceSlug).toMatch(/^(notification|billing|auth)-service$/);
      // Long enough to clear TICKET_SUMMARY_MIN_LENGTH at the contract layer.
      expect(ticket.summary.trim().length).toBeGreaterThanOrEqual(15);
    }
  });

  it("covers more than one service across a round", () => {
    // A round that happened to draw a single service would measure that
    // service rather than the agent.
    const slugs = new Set(
      generateTickets(15, 20260919).map((ticket) => ticket.parameters.serviceSlug),
    );
    expect(slugs.size).toBeGreaterThan(1);
  });
});
