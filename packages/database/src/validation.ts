import { TicketContextSchema as _TicketContextSchema } from "@opspilot/contracts";
import type { ZodType } from "zod";

import { PersistenceError } from "./errors";

// TicketContextSchema now lives in @opspilot/contracts (a shared domain
// contract used by the API request shape, this persistence layer, and the
// orchestrator's ticket_context conversation entry alike) — re-exported here
// as a plain const (not `export { TicketContextSchema }`, which compiles to
// a live-binding getter that Vite-node's CJS interop does not reliably
// forward — see packages/agent-runtime/src/index.ts) for backward
// compatibility of existing internal import sites.
export const TicketContextSchema = _TicketContextSchema;

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
