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

describe("service coverage holds across seeds, not just one", () => {
  // seed 0 / count 5 produced five tickets on notification-service. The
  // existing diversity test passed because it only ever ran one seed — a test
  // that exercises a single input cannot report the property it claims.
  const SEEDS = [0, 1, 2, 3, 7, 42, 999, 20260919];

  it.each(SEEDS)("covers every service at count 5 (seed %i)", (seed) => {
    const services = new Set(generateTickets(5, seed).map((t) => t.parameters.serviceSlug));
    expect(services.size).toBe(3);
  });

  it.each(SEEDS)("covers every service at count 15 (seed %i)", (seed) => {
    const services = new Set(generateTickets(15, seed).map((t) => t.parameters.serviceSlug));
    expect(services.size).toBe(3);
  });

  // Coverage must not come at the cost of the properties already relied on.
  it.each(SEEDS)("stays distinct and reproducible (seed %i)", (seed) => {
    const first = generateTickets(15, seed);
    const keys = new Set(first.map((t) => JSON.stringify(t.parameters)));
    expect(keys.size).toBe(15);
    expect(generateTickets(15, seed)).toEqual(first);
  });

  it("still differs between seeds", () => {
    const a = generateTickets(15, 1).map((t) => JSON.stringify(t.parameters));
    const b = generateTickets(15, 2).map((t) => JSON.stringify(t.parameters));
    expect(a).not.toEqual(b);
  });
});
