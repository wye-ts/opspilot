import {
  ApprovalDecisionSchema,
  StoredTicketContextSchema as _StoredTicketContextSchema,
  TicketContextSchema as _TicketContextSchema,
} from "@opspilot/contracts";
import { z, type ZodType } from "zod";

import { PersistenceError } from "./errors";

// TicketContextSchema now lives in @opspilot/contracts (a shared domain
// contract used by the API request shape, this persistence layer, and the
// orchestrator's ticket_context conversation entry alike) — re-exported here
// as a plain const (not `export { TicketContextSchema }`, which compiles to
// a live-binding getter that Vite-node's CJS interop does not reliably
// forward — see packages/agent-runtime/src/index.ts) for backward
// compatibility of existing internal import sites.
export const TicketContextSchema = _TicketContextSchema;

// The stored-row counterpart. Applies to reads only — see the schema's own
// doc comment in @opspilot/contracts for why the write bounds (trimmed
// summary 15–2000, ticketId ≤ 64) must not be enforced against rows that were
// already persisted under the older, looser rule.
export const StoredTicketContextSchema = _StoredTicketContextSchema;

export function validateOrThrow<T>(schema: ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Fixed, safe message only — result.error.issues (and therefore the raw
    // invalid value it may echo) is retained solely as PersistenceError's
    // internal `cause`, never surfaced in `.message`.
    throw new PersistenceError(
      "PERSISTENCE_VALIDATION_FAILED",
      `${context} failed contract validation.`,
      { cause: result.error },
    );
  }
  return result.data;
}

// Revalidates a stored agent_run_approvals row on every read. This schema
// VALIDATES, it does not NORMALIZE: a stored value with leading/trailing
// whitespace (e.g. " jacky ") must be rejected, not silently trimmed back to
// "jacky" — trimming here would mask exactly the kind of write-path bug or
// manual-INSERT corruption this schema exists to catch. Request-time
// normalization (RecordApprovalDecisionInputSchema, @opspilot/contracts)
// still uses .trim() — that is a different concern (normalizing a fresh
// caller's input), not this one (revalidating what is already stored).
const isCanonicallyTrimmed = (value: string): boolean => value === value.trim();

const CanonicalReviewerNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isCanonicallyTrimmed, { message: "reviewerName must not have leading or trailing whitespace" });

const CanonicalNoteSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(isCanonicallyTrimmed, { message: "note must not have leading or trailing whitespace" });

export const AgentRunApprovalRowSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    decision: ApprovalDecisionSchema,
    reviewerName: CanonicalReviewerNameSchema,
    note: z.union([z.null(), CanonicalNoteSchema]),
    decidedAt: z.date(),
  })
  .strict();
