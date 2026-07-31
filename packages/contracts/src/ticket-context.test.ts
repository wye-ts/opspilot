import { describe, expect, it } from "vitest";

import {
  isLiveExecutionEligible,
  StoredTicketContextSchema,
  TICKET_ID_MAX_LENGTH,
  TICKET_SUMMARY_MAX_LENGTH,
  TICKET_SUMMARY_MIN_LENGTH,
  TicketContextSchema,
} from "./ticket-context";

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

  // The 15-character floor (docs/reviews/19-protected-live-claude-api-plan.md
  // §14). A LIVE run spends real money on this text, so a summary too short to
  // investigate is refused at the boundary rather than billed for.
  describe("summary length bounds", () => {
    it("rejects a 14-character summary", () => {
      const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: "a".repeat(14) });

      expect(result.success).toBe(false);
    });

    it("accepts a 15-character summary", () => {
      const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: "a".repeat(15) });

      expect(result.success).toBe(true);
    });

    it("accepts a 2000-character summary", () => {
      const result = TicketContextSchema.safeParse({
        ...validTicketContext,
        summary: "a".repeat(TICKET_SUMMARY_MAX_LENGTH),
      });

      expect(result.success).toBe(true);
    });

    it("rejects a 2001-character summary", () => {
      const result = TicketContextSchema.safeParse({
        ...validTicketContext,
        summary: "a".repeat(TICKET_SUMMARY_MAX_LENGTH + 1),
      });

      expect(result.success).toBe(false);
    });
  });

  // Trimming happens BEFORE the length checks, so the bounds are applied to
  // the trimmed value and the parsed output is what gets persisted. Nothing
  // downstream re-trims.
  describe("trimming", () => {
    it("rejects a whitespace-only summary", () => {
      const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: "          " });

      expect(result.success).toBe(false);
    });

    it("rejects a summary that is only long enough before trimming", () => {
      // 12 real characters padded to 20 — the padding must not buy it past the
      // 15-character floor.
      const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: "    abcdefghijkl    " });

      expect(result.success).toBe(false);
    });

    it("returns the summary trimmed so the trimmed value is what gets stored", () => {
      const result = TicketContextSchema.safeParse({
        ...validTicketContext,
        summary: "   Elevated API error rate on billing-service   ",
      });

      expect(result.success).toBe(true);
      expect(result.data?.summary).toBe("Elevated API error rate on billing-service");
    });

    it("returns the ticketId trimmed", () => {
      const result = TicketContextSchema.safeParse({ ...validTicketContext, ticketId: "  TICKET-2001  " });

      expect(result.success).toBe(true);
      expect(result.data?.ticketId).toBe("TICKET-2001");
    });

    it("accepts a 2000-character summary padded with whitespace, storing it trimmed", () => {
      const summary = "a".repeat(TICKET_SUMMARY_MAX_LENGTH);
      const result = TicketContextSchema.safeParse({ ...validTicketContext, summary: `  ${summary}  ` });

      expect(result.success).toBe(true);
      expect(result.data?.summary).toBe(summary);
    });
  });

  describe("ticketId length bounds", () => {
    it("accepts a 64-character ticketId", () => {
      const result = TicketContextSchema.safeParse({
        ...validTicketContext,
        ticketId: "T".repeat(TICKET_ID_MAX_LENGTH),
      });

      expect(result.success).toBe(true);
    });

    it("rejects a 65-character ticketId", () => {
      const result = TicketContextSchema.safeParse({
        ...validTicketContext,
        ticketId: "T".repeat(TICKET_ID_MAX_LENGTH + 1),
      });

      expect(result.success).toBe(false);
    });
  });

  it("exposes the bounds it enforces as named constants", () => {
    expect(TICKET_SUMMARY_MIN_LENGTH).toBe(15);
    expect(TICKET_SUMMARY_MAX_LENGTH).toBe(2000);
    expect(TICKET_ID_MAX_LENGTH).toBe(64);
  });
});

// The read path is deliberately looser than the write path. These tests pin
// that asymmetry so a future "consistency" cleanup that collapses the two
// schemas fails loudly instead of retroactively invalidating stored rows.
describe("StoredTicketContextSchema", () => {
  it("accepts a stored summary shorter than the write-path floor", () => {
    const result = StoredTicketContextSchema.safeParse({ ticketId: "TICKET-1", summary: "Elevated errors" });

    expect(result.success).toBe(true);
  });

  it("accepts a stored one-character summary, which the write path rejects", () => {
    const row = { ticketId: "TICKET-1", summary: "s" };

    expect(StoredTicketContextSchema.safeParse(row).success).toBe(true);
    expect(TicketContextSchema.safeParse(row).success).toBe(false);
  });

  it("accepts a stored ticketId longer than the write-path maximum", () => {
    const row = { ticketId: "T".repeat(TICKET_ID_MAX_LENGTH + 1), summary: "Elevated API error rate" };

    expect(StoredTicketContextSchema.safeParse(row).success).toBe(true);
    expect(TicketContextSchema.safeParse(row).success).toBe(false);
  });

  it("returns a stored value verbatim rather than normalizing it", () => {
    // A read revalidates; it does not rewrite. Trimming here would hide the
    // write-path bug or manual INSERT that produced the untrimmed value.
    const result = StoredTicketContextSchema.safeParse({ ticketId: " TICKET-1 ", summary: " padded " });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ticketId: " TICKET-1 ", summary: " padded " });
  });

  it("still rejects a row missing summary", () => {
    const result = StoredTicketContextSchema.safeParse({ ticketId: "TICKET-1" });

    expect(result.success).toBe(false);
  });

  it("still rejects an empty stored summary", () => {
    const result = StoredTicketContextSchema.safeParse({ ticketId: "TICKET-1", summary: "" });

    expect(result.success).toBe(false);
  });

  it("still rejects extra properties under strict mode", () => {
    const result = StoredTicketContextSchema.safeParse({
      ticketId: "TICKET-1",
      summary: "Elevated errors",
      priority: "HIGH",
    });

    expect(result.success).toBe(false);
  });
});

/**
 * LIVE EXECUTION ELIGIBILITY — the predicate that decides whether a STORED row
 * may start a NEW paid run.
 *
 * The rule is CANONICAL FORM, not parseability, and the distinction is the whole
 * point. `TicketContextSchema` trims before it measures, while the repository
 * sends the stored snapshot to the provider — so a `safeParse().success` check
 * bounds a string that is not the one being billed for. Requiring equality with
 * the parsed result makes those two the same string.
 */
describe("isLiveExecutionEligible", () => {
  it("admits a value that is already canonical", () => {
    expect(
      isLiveExecutionEligible({ ticketId: "TICKET-1", summary: "Elevated API error rate" }),
    ).toBe(true);
  });

  it("admits the exact boundary lengths", () => {
    expect(
      isLiveExecutionEligible({ ticketId: "T", summary: "y".repeat(TICKET_SUMMARY_MIN_LENGTH) }),
    ).toBe(true);
    expect(
      isLiveExecutionEligible({
        ticketId: "z".repeat(TICKET_ID_MAX_LENGTH),
        summary: "y".repeat(TICKET_SUMMARY_MAX_LENGTH),
      }),
    ).toBe(true);
  });

  it("refuses a summary below the floor or above the ceiling", () => {
    expect(isLiveExecutionEligible({ ticketId: "T", summary: "Disk full" })).toBe(false);
    expect(
      isLiveExecutionEligible({ ticketId: "T", summary: "y".repeat(TICKET_SUMMARY_MAX_LENGTH + 1) }),
    ).toBe(false);
  });

  it("refuses a padded summary whose TRIMMED value would be valid", () => {
    // The hole a parse-only check left open: valid once trimmed, and the value
    // actually sent is the padded original.
    expect(
      isLiveExecutionEligible({ ticketId: "T", summary: "  Elevated API error rate  " }),
    ).toBe(false);
  });

  it("refuses arbitrarily large padding around valid content", () => {
    const padded = `${" ".repeat(50_000)}Elevated API error rate${" ".repeat(50_000)}`;
    expect(padded.trim().length).toBeGreaterThanOrEqual(TICKET_SUMMARY_MIN_LENGTH);
    expect(isLiveExecutionEligible({ ticketId: "T", summary: padded })).toBe(false);
  });

  it("refuses a padded ticket id", () => {
    expect(
      isLiveExecutionEligible({ ticketId: " TICKET-1 ", summary: "Elevated API error rate" }),
    ).toBe(false);
  });

  it("refuses a trailing newline", () => {
    // Invisible in any UI and invisible to a character counter, but it is still
    // a byte the provider would be sent and a byte the bound never saw.
    expect(
      isLiveExecutionEligible({ ticketId: "T", summary: "Elevated API error rate\n" }),
    ).toBe(false);
  });

  it("agrees with the write schema on every value the write schema accepts unchanged", () => {
    // The invariant that keeps the two rules from drifting: anything a current
    // caller can submit and have stored verbatim is, by definition, eligible.
    for (const summary of ["Elevated API error rate", "y".repeat(TICKET_SUMMARY_MIN_LENGTH)]) {
      const parsed = TicketContextSchema.parse({ ticketId: "TICKET-1", summary });
      expect(isLiveExecutionEligible(parsed)).toBe(true);
    }
  });
});
