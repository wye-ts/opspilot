import { z } from "zod";

// Bounds for the request/write boundary (docs/reviews/19-protected-live-claude-api-plan.md
// §14). The summary floor exists because a LIVE run spends real money on
// whatever text it is given: a two-character summary cannot produce a
// meaningful investigation, so it is refused before a provider call rather
// than billed for. The ceiling bounds the input side of the token budget
// alongside the existing 32 KB body cap.
export const TICKET_ID_MAX_LENGTH = 64;
export const TICKET_SUMMARY_MIN_LENGTH = 15;
export const TICKET_SUMMARY_MAX_LENGTH = 2000;

/**
 * The REQUEST/WRITE boundary schema — what a caller may submit, and what gets
 * persisted.
 *
 * `.trim()` runs BEFORE the length checks, so `min`/`max` see the trimmed
 * value and the parsed output is already normalized. Trimming happens exactly
 * once, here; nothing downstream re-trims, and what `createJob` persists is
 * this schema's output rather than the caller's raw text.
 *
 * This schema deliberately does NOT validate stored rows — see
 * StoredTicketContextSchema below for why those are a different concern.
 */
export const TicketContextSchema = z
  .object({
    ticketId: z.string().trim().min(1).max(TICKET_ID_MAX_LENGTH),
    summary: z.string().trim().min(TICKET_SUMMARY_MIN_LENGTH).max(TICKET_SUMMARY_MAX_LENGTH),
  })
  .strict();

export type TicketContext = z.infer<typeof TicketContextSchema>;

/**
 * The READ boundary schema — revalidates a `ticket_context` JSONB snapshot
 * already stored in PostgreSQL.
 *
 * Deliberately looser than TicketContextSchema, and deliberately separate from
 * it. Two distinct reasons:
 *
 *  1. **Rows written before the bounds existed must stay readable.** Every
 *     `agent_jobs` row created before this milestone was accepted under
 *     `summary: min(1)`. Applying the 15-character floor on the read path
 *     would turn each of those into PERSISTENCE_VALIDATION_FAILED — a 500 on
 *     `GET /v1/agent-runs/:id` and on `startRun` — retroactively breaking
 *     already-persisted demo data that was valid when it was written. A
 *     tightened *input* rule must never invalidate history.
 *
 *  2. **A read revalidates; it does not normalize.** This schema has no
 *     `.trim()`, so a stored value is returned exactly as persisted rather
 *     than silently rewritten on its way out. Renormalizing here would mask
 *     precisely the write-path bug or manual INSERT that revalidation exists
 *     to catch, and would make the value a caller reads differ from the value
 *     on disk.
 *
 * This mirrors the split the approval path already draws between
 * RecordApprovalDecisionInputSchema (request-time, trims) and
 * AgentRunApprovalRowSchema (stored-row, validates canonical form without
 * normalizing) — see packages/database/src/validation.ts.
 */
export const StoredTicketContextSchema = z
  .object({
    ticketId: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export type StoredTicketContext = z.infer<typeof StoredTicketContextSchema>;
