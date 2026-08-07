import {
  deriveExecutionStageProgress,
  InvestigationEventContractError,
  type InvestigationEventPayload,
  type InvestigationEventRecord,
  type InvestigationRunStatus,
} from "@opspilot/contracts";

import type { Prisma } from "../generated/prisma-client/client";
import { PersistenceError } from "../errors";
import { fromInvestigationEventRows } from "../mappers";

/**
 * The two canonical event types that may only ever be written by the terminal
 * finalize transaction, atomically with the run's terminal status update. The
 * generic incremental append refuses them outright: a terminal event without
 * its matching status update is precisely the corruption
 * `finalizeTerminal`'s RUNNING-branch guard exists to detect and refuse.
 */
export const TERMINAL_EVENT_TYPES = ["RUN_COMPLETED", "RUN_FAILED"] as const;

export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

export function isTerminalEventType(eventType: string): eventType is TerminalEventType {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(eventType);
}

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

/**
 * Allocates this run's next canonical sequence number.
 *
 * `MAX(sequence_number) + 1` is safe here — and only here — because every
 * caller holds the `agent_runs` row lock for the duration of its
 * transaction, which serializes all appenders for that run. This is the same
 * pattern `startRun` already uses to allocate `attempt_number` under the
 * `agent_jobs` lock. `UNIQUE(run_id, sequence_number)` stands behind it as
 * defense in depth, not as the primary mechanism.
 */
export async function allocateNextSequence(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<number> {
  const [row] = await tx.$queryRaw<{ maxSequence: number }[]>`
    SELECT COALESCE(MAX(sequence_number), 0)::int AS "maxSequence"
    FROM agent_trace_events WHERE run_id = ${runId}::uuid`;
  return (row?.maxSequence ?? 0) + 1;
}

/**
 * Inserts one canonical event row and returns the database-generated
 * `created_at` that becomes its `recordedAt`. No application timestamp is
 * ever written.
 */
export async function insertCanonicalEventRow(
  tx: Prisma.TransactionClient,
  runId: string,
  sequenceNumber: number,
  payload: InvestigationEventPayload,
): Promise<{ sequenceNumber: number; createdAt: Date }> {
  return tx.agentTraceEvent.create({
    data: {
      runId,
      sequenceNumber,
      eventType: payload.type,
      payload: payload as unknown as Prisma.InputJsonObject,
    },
    select: { sequenceNumber: true, createdAt: true },
  });
}

/**
 * Re-reads the complete stored canonical stream for a run, in sequence
 * order, inside the caller's transaction.
 *
 * Deliberately a re-read rather than an in-memory accumulation: validation
 * must see exactly what is about to commit, including anything another
 * (serialized) writer committed before this transaction took the lock.
 */
export async function readCanonicalStream(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<readonly InvestigationEventRecord[]> {
  const rows = await tx.agentTraceEvent.findMany({
    where: { runId },
    orderBy: { sequenceNumber: "asc" },
    select: { sequenceNumber: true, payload: true, createdAt: true },
  });
  return fromInvestigationEventRows(runId, rows);
}

/**
 * Runs the #36 reducer over a candidate stream and translates any rejection
 * into `PERSISTENCE_EVENT_STREAM_INVALID`, so the caller's transaction rolls
 * back and the candidate commits zero rows.
 *
 * `now` is the latest stored `recordedAt` — ordering stays sequence-
 * authoritative; `now` only feeds the reducer's elapsed-time arithmetic,
 * which clamps negative skew to zero.
 *
 * The reducer's own closed `InvestigationEventContractError.code` is
 * preserved via `cause` for structured diagnostics. The thrown message names
 * only the run id and closed enum values — never a payload, prompt, report,
 * tool input, provider response, or secret.
 */
export function assertCanonicalStreamValid(
  events: readonly InvestigationEventRecord[],
  runStatus: InvestigationRunStatus,
  context: string,
): void {
  const latestRecordedAt = events[events.length - 1]?.recordedAt ?? new Date().toISOString();
  try {
    deriveExecutionStageProgress({ events, runStatus, now: latestRecordedAt });
  } catch (error) {
    const code = error instanceof InvestigationEventContractError ? ` (${error.code})` : "";
    throw new PersistenceError(
      "PERSISTENCE_EVENT_STREAM_INVALID",
      `${context}: the resulting canonical event stream is not valid for runStatus ${runStatus}${code}`,
      { cause: error },
    );
  }
}

/**
 * Which terminal event types are already stored for this run.
 *
 * Used by the terminal transaction for two different refusals that must not
 * be conflated: a terminal event present while the run is still `RUNNING`
 * (corruption — something wrote outside this repository), and both terminal
 * types present at once (corruption — a run cannot have both completed and
 * failed).
 */
export async function findTerminalEventTypes(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<TerminalEventType[]> {
  const rows = await tx.$queryRaw<{ eventType: string }[]>`
    SELECT event_type AS "eventType"
    FROM agent_trace_events
    WHERE run_id = ${runId}::uuid
      AND event_type IN ('RUN_COMPLETED', 'RUN_FAILED')
    ORDER BY event_type`;
  return rows.map((row) => row.eventType).filter(isTerminalEventType);
}
