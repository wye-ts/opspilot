import type { InvestigationEventPayload } from "@opspilot/contracts";

import type { Prisma } from "../generated/prisma-client/client";
import { PersistenceError } from "../errors";

/**
 * The all-12 exact-replay policy (docs/reviews/21-issue-37-incremental-event-
 * persistence-plan.md §4), shared by BOTH write paths — the generic
 * incremental append (`appendInvestigationEvent`) and, in a later phase, the
 * terminal transaction (`finalizeTerminal`) — so there is exactly one replay
 * rule for every canonical event type, never two subtly different ones.
 *
 * A transaction can commit and STILL leave the caller with an ambiguous
 * driver/network failure before it observes the returned row. A retry of
 * that exact append must return the original row rather than create a
 * second candidate event the reducer would then reject — this applies to
 * every one of the 12 canonical write-eligible types (TOOL_REQUESTED and
 * TOOL_COMPLETED exactly as much as REPORT_SUBMITTED, arguably more, since
 * those retries follow real side-effecting work), which is why this is not
 * scoped to only the lifecycle-singleton subset.
 */
export type CanonicalEventReplay =
  | { readonly kind: "replay"; readonly sequenceNumber: number; readonly createdAt: Date }
  | { readonly kind: "absent" };

/**
 * Resolves whether `payload` is an exact replay of an already-stored event
 * of the same type on this run, a genuinely new event, or a conflicting
 * retry.
 *
 *   no stored row for (runId, payload.type)          -> "absent": proceed to allocate/insert
 *   stored row, payload JSONB-equal to the candidate  -> "replay": return the original,
 *                                                         insert nothing, consume no sequence
 *   stored row, payload NOT equal to the candidate    -> PERSISTENCE_CONFLICT, insert nothing
 *
 * Comparison happens in PostgreSQL via `IS NOT DISTINCT FROM`, not in
 * JavaScript — the same reasoning `finalizeTerminal`'s existing exact-replay
 * check already relies on: JSONB equality normalizes object key order away
 * (which does not matter) while preserving element/array order (which
 * does), and a raw string comparison would not. The candidate payload
 * passed in must already be the validated, normalized value
 * (`InvestigationEventPayloadSchema`-parsed) — the JSONB compared here is
 * therefore the identical value that would have been inserted, so a retry
 * cannot silently succeed against a subtly different `toolCallId`,
 * `toolName`, or failure code.
 *
 * MUST be called inside the same transaction that holds the run row's
 * `FOR UPDATE` lock, and before any sequence allocation — the lock is what
 * makes "no stored row" a fact rather than a race, and calling this before
 * allocation is what makes a replay consume no sequence number.
 */
export async function resolveCanonicalEventReplay(
  tx: Prisma.TransactionClient,
  runId: string,
  payload: InvestigationEventPayload,
): Promise<CanonicalEventReplay> {
  const candidateJson = JSON.stringify(payload);

  const rows = await tx.$queryRaw<
    { sequenceNumber: number; createdAt: Date; payloadMatches: boolean }[]
  >`
    SELECT sequence_number AS "sequenceNumber", created_at AS "createdAt",
           (payload IS NOT DISTINCT FROM ${candidateJson}::jsonb) AS "payloadMatches"
    FROM agent_trace_events
    WHERE run_id = ${runId}::uuid AND event_type = ${payload.type}`;
  const [row] = rows;

  if (!row) return { kind: "absent" };

  if (!row.payloadMatches) {
    throw new PersistenceError(
      "PERSISTENCE_CONFLICT",
      `AgentTraceEvent ${payload.type} already exists for run ${runId} with a different payload`,
    );
  }

  return { kind: "replay", sequenceNumber: row.sequenceNumber, createdAt: row.createdAt };
}
