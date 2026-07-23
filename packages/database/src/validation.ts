import { z, type ZodType } from "zod";

import { PersistenceError } from "./errors";

// No exported ticket-context contract exists yet (see
// apps/worker/src/providers/llm-provider.ts's local TicketContextEntry
// interface, which additionally carries a role discriminant that is not
// meaningful as a standalone persisted shape — every row in agent_jobs is a
// ticket context by definition). This is the narrowest schema matching the
// real { ticketId, summary } input, not a duplicate of a broader product
// model.
export const TicketContextSchema = z
  .object({
    ticketId: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

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
