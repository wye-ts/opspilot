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
 * Issue #39 — the PUBLIC LIVE trial's stricter summary ceiling. The floor
 * (15) is unchanged and shared with the private bound; only the ceiling
 * tightens, from 2000 to 300, per the confirmed public-trial policy
 * (docs/reviews/23-issue-39-public-live-trial-plan.md). Not configurable —
 * see PUBLIC_TRIAL_DEFAULTS in apps/api's run-execution-config.ts for the
 * sibling policy numbers that are equally fixed.
 */
export const PUBLIC_TICKET_SUMMARY_MAX_LENGTH = 300;

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
 * Issue #39 — the PUBLIC-trial write boundary: identical to
 * `TicketContextSchema` except the summary ceiling is 300, not 2000. Used
 * only by `isPublicLiveExecutionEligible` below, at LIVE-execution time —
 * job CREATION (`POST /v1/agent-jobs`) always validates against the shared
 * `TicketContextSchema`, regardless of which provider mode a caller later
 * requests, since a job's eventual provider mode is not known when it is
 * created.
 */
export const PublicTicketContextSchema = z
  .object({
    ticketId: z.string().trim().min(1).max(TICKET_ID_MAX_LENGTH),
    summary: z.string().trim().min(TICKET_SUMMARY_MIN_LENGTH).max(PUBLIC_TICKET_SUMMARY_MAX_LENGTH),
  })
  .strict();

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

/**
 * Whether a STORED ticket context may be sent to the PAID provider path.
 *
 * The split this closes, stated plainly:
 *
 *   stored-read compatibility  →  permissive  (StoredTicketContextSchema)
 *   LIVE execution eligibility →  current bounds (TicketContextSchema)
 *
 * StoredTicketContextSchema stays permissive for exactly the reasons documented
 * above it, and that is correct for a GET. But `startLiveRunWithAttemptLimit`
 * reads the very same stored snapshot and hands it to a provider that charges
 * for it — so a job created before the 15..2000 rule existed could start a LIVE
 * run with a summary that no current caller is allowed to submit. A tightened
 * input rule must not invalidate history, and it must not be bypassable either;
 * those are two different requirements and they need two different checks.
 *
 * Deliberately a PREDICATE over the stored value rather than a transform. It
 * answers eligibility and returns nothing: an ineligible context is refused, not
 * truncated to fit, padded to reach the floor, or quietly rewritten. Silently
 * editing the text a paid run is billed for would be worse than refusing it.
 *
 * CANONICAL FORM IS REQUIRED, not merely parseability — and the difference is a
 * real hole, not a nicety. `TicketContextSchema` TRIMS before it measures, and
 * the repository sends the STORED value to the provider, not the schema's parsed
 * output. So `"    " * 50_000 + "Elevated error rate" + "    " * 50_000` parses
 * happily against the 15..2000 rule while the prompt actually billed for is
 * hundreds of kilobytes. Checking `safeParse().success` alone therefore enforced
 * a bound on a value nobody was going to send.
 *
 * Requiring the stored value to already EQUAL the parsed result closes that by
 * construction: what the bounds were measured against and what the provider
 * receives become the same string, so the check cannot be about a different
 * value than the run. Any row that would have to be normalized to qualify is
 * refused instead of normalized.
 *
 * Only NEW executions are held to this. Historical reads stay permissive and
 * byte-for-byte (StoredTicketContextSchema), and an existing run is still
 * replayable — see the ordering note in the repository transaction.
 */
export function isLiveExecutionEligible(context: StoredTicketContext): boolean {
  const parsed = TicketContextSchema.safeParse(context);
  return (
    parsed.success &&
    parsed.data.ticketId === context.ticketId &&
    parsed.data.summary === context.summary
  );
}

/**
 * Issue #39 — the PUBLIC-trial counterpart to `isLiveExecutionEligible`,
 * identical in every respect (same canonical-form requirement, same
 * predicate-not-transform contract, same "only new executions are held to
 * this" scope) except the summary ceiling: 300 characters, not 2000. A job
 * whose stored summary satisfies the private 15..2000 bound but exceeds 300
 * is eligible for a PRIVATE, token-authenticated LIVE run and NOT eligible
 * for a PUBLIC trial run of the same job — the two checks are not
 * interchangeable, and the repository selects between them by path (see
 * agent-run-repository.ts's `startLiveRunWithAttemptLimit`).
 */
export function isPublicLiveExecutionEligible(context: StoredTicketContext): boolean {
  const parsed = PublicTicketContextSchema.safeParse(context);
  return (
    parsed.success &&
    parsed.data.ticketId === context.ticketId &&
    parsed.data.summary === context.summary
  );
}
