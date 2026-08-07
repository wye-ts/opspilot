import {
  InvestigationEventPayloadSchema,
  isLiveExecutionEligible,
  type InvestigationEventRecord,
} from "@opspilot/contracts";

import type { PrismaClient } from "../client";
// NOTE: verified against the actual installed Prisma 7.9.0 `prisma-client`
// generator output during the Prisma scaffolding checkpoint — adjust this
// import if the generator's real `Prisma` namespace export differs.
import { Prisma } from "../generated/prisma-client/client";
import { normalizeDatabaseError, PersistenceError } from "../errors";
import { LiveRunAdmissionError } from "../live-run-errors";
import {
  buildOutcome,
  fromAgentJobRow,
  fromAgentRunRow,
  fromInvestigationEventRows,
  fromTraceEventRows,
  toFailureCodeWrite,
  toReportWrite,
  toTicketContextWrite,
} from "../mappers";
import type {
  AgentJobRecord,
  AgentRunRecord,
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  LiveRunStartResult,
  PersistedAgentJob,
  PersistedAgentRun,
  PersistedInvestigationState,
  ProviderMode,
  ReplayedLiveRun,
  RunProviderUsageWrite,
  StartedAgentRun,
} from "../types";
import { validateOrThrow } from "../validation";
import {
  allocateNextSequence,
  assertCanonicalStreamValid,
  findTerminalEventTypes,
  insertCanonicalEventRow,
  isTerminalEventType,
  readCanonicalStream,
  resolveCanonicalEventReplay,
  type TerminalEventType,
} from "./investigation-event-ledger";

/**
 * The canonical first event of every run, written inside the SAME
 * transaction that inserts the `agent_runs` row so neither can exist
 * without the other. Always sequence 1 — a brand-new run has no events.
 *
 * Deliberately NOT written via `appendInvestigationEvent`: that function
 * opens its own transaction and locks a run row that does not exist yet.
 * Run creation owns this event.
 */
const RUN_CREATED_PAYLOAD = { type: "RUN_CREATED" } as const;

async function insertRunCreatedEvent(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> {
  await insertCanonicalEventRow(tx, runId, 1, RUN_CREATED_PAYLOAD);
}

/**
 * Formats a PostgreSQL DATE as "YYYY-MM-DD" from its UTC components.
 *
 * UTC components, never the local ones. Verified empirically against this
 * project's Prisma 7.9.0 / PostgreSQL 16 pairing: a DATE column round-trips as a
 * `Date` at UTC midnight (`2026-07-29T00:00:00.000Z`) regardless of the process
 * timezone. So `getUTCDate()` reads back the stored calendar day in every
 * timezone, while `getDate()` would report the 28th for a row storing the 29th
 * anywhere west of UTC — silently reconciling the wrong day's budget on a
 * developer machine in US Pacific time.
 *
 * `toISOString().slice(0, 10)` would also be correct given that UTC-midnight
 * behaviour, but it encodes a dependency on the driver's choice of time-of-day.
 * Reading the calendar fields directly says what is actually meant.
 */
function toBudgetDateString(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The UTC calendar day, as the "YYYY-MM-DD" string a reservation is keyed on. */
export function currentBudgetDate(now: Date = new Date()): string {
  return toBudgetDateString(now);
}

export async function createJob(
  prisma: PrismaClient,
  ticketContextInput: unknown,
): Promise<AgentJobRecord> {
  const { ticketContext, externalTicketId } = toTicketContextWrite(ticketContextInput);
  try {
    const row = await prisma.agentJob.create({
      data: { ticketContext: ticketContext as unknown as Prisma.InputJsonObject, externalTicketId },
    });
    return fromAgentJobRow(row);
  } catch (error) {
    throw normalizeDatabaseError(error, "createJob");
  }
}

export async function startRun(
  prisma: PrismaClient,
  jobId: string,
  providerMode: ProviderMode,
  modelIdentifier: string | null,
): Promise<StartedAgentRun> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock order: AgentJob first (§ docs/11-agent-run-persistence.md) —
      // serializes concurrent startRun calls for the same job so attempt
      // numbers never collide. The FULL row is selected (not just id) and
      // is the only source of truth for this run's ticket context — a
      // caller-supplied job/ticketContext is never accepted (see
      // agent-run-service.ts and docs/11-agent-run-persistence.md): a
      // caller could otherwise combine one job's id with a different
      // job's ticket context.
      const jobRows = await tx.$queryRaw<
        { id: string; ticketContext: unknown; externalTicketId: string; createdAt: Date }[]
      >`
        SELECT id, ticket_context AS "ticketContext", external_ticket_id AS "externalTicketId",
               created_at AS "createdAt"
        FROM agent_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const [jobRow] = jobRows;
      if (!jobRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentJob ${jobId} not found`);
      }

      // Runtime-validate and map the locked job row BEFORE inserting the
      // AgentRun — if the stored snapshot fails TicketContextSchema, this
      // throws, the transaction rolls back, and no AgentRun is ever
      // created.
      const jobRecord = fromAgentJobRow(jobRow);

      const [maxAttemptRow] = await tx.$queryRaw<{ maxAttempt: number }[]>`
        SELECT COALESCE(MAX(attempt_number), 0)::int AS "maxAttempt"
        FROM agent_runs WHERE job_id = ${jobId}::uuid`;
      const nextAttempt = (maxAttemptRow?.maxAttempt ?? 0) + 1;

      // No PENDING row ever exists — created already RUNNING, in the same
      // transaction as the attempt-number allocation above, while the job
      // row remains locked.
      const runRow = await tx.agentRun.create({
        data: {
          jobId,
          attemptNumber: nextAttempt,
          status: "RUNNING",
          startedAt: new Date(),
          providerMode,
          modelIdentifier,
        },
      });

      // RUN_CREATED commits with the run itself: if this insert fails, the
      // AgentRun insert above rolls back with it, so there is never a run
      // without its first canonical event, nor an event without its run.
      await insertRunCreatedEvent(tx, runRow.id);

      return { jobRecord, runRow };
    });
    return { job: result.jobRecord, run: fromAgentRunRow(result.runRow) };
  } catch (error) {
    throw normalizeDatabaseError(error, "startRun");
  }
}

/**
 * Creates a LIVE run, enforcing the per-job attempt limit and reserving the
 * day's budget, in ONE transaction with a fixed lock order.
 *
 *   BEGIN
 *     1. SELECT agent_jobs FOR UPDATE          -> PERSISTENCE_NOT_FOUND (404)
 *     2. replay lookup by client key           -> returns the EXISTING run, done
 *     3. stored context vs. current bounds     -> LIVE_RUN_CONTEXT_INVALID (422)
 *     4. count LIVE runs for the job           -> LIVE_RUN_ATTEMPT_LIMIT (429)
 *     5. reserve the UTC-day budget row        -> LIVE_RUN_BUDGET_EXHAUSTED (429)
 *     6. allocate attempt_number; INSERT the run with its client key
 *   COMMIT
 *
 * STEPS 2 AND 3 ARE BOTH BEFORE EVERY SIDE EFFECT — before the attempt count,
 * before the reservation, before the insert, and therefore before the provider
 * is ever constructed by the caller. A replay and a rejection each cost exactly
 * one locked read.
 *
 * STEP 2 IS THE SECOND KEY LOOKUP A LIVE REQUEST PERFORMS, and it is not
 * redundant. The API now runs a read-only `replayLiveRun` BEFORE the new-run
 * spend gates, so an already-created run can be recovered even when the day's
 * budget, the rate window, or the concurrency slot is closed. That first lookup
 * cannot decide the case where two requests carrying the SAME key both found
 * nothing and both went on to admission: only this one, under the lock that
 * serializes creation, can. The first lookup is an early exit; this one is the
 * guarantee.
 *
 * WHY THE REPLAY LOOKUP COMES FIRST, ahead of the context check. A replay
 * returns a run that already exists, which means the money was already spent (or
 * definitively not spent) by the attempt that created it. Refusing to hand that
 * row back because the job's stored summary fails today's bounds would strand a
 * paid run behind a rule that cannot change what it cost. Rejecting a NEW
 * execution and refusing to acknowledge a COMPLETED one are different acts; only
 * the first is what the bounds are for.
 *
 * Why the checks live INSIDE this transaction rather than in a cheap admission
 * query beforehand: a read-then-check ("count LIVE runs; if under the cap,
 * proceed") is a race, so the cap would not actually be a cap. Two concurrent
 * requests for a job's final allowed attempt both read the same count and both
 * proceed. Here they serialize on the AgentJob row lock, so exactly one wins.
 *
 * The properties this buys, none of which the cheaper design has:
 *   - a rejected attempt consumes NO budget reservation (same transaction, rolled back);
 *   - a request naming a nonexistent job consumes no reservation either, so the
 *     day's allowance cannot be drained by requests for jobs that do not exist;
 *   - a closed budget gate creates no AgentRun row.
 *
 * THE TRANSACTION COMMITS BEFORE ANY PROVIDER CALL. A 120-second orchestration
 * must never run while this transaction holds a lock on the AgentJob row and the
 * day's budget row — every other request for that job, and every live request
 * on the whole deployment, would block behind it.
 *
 * Lock order is global and fixed: AgentJob -> LiveRunBudget -> AgentRun insert.
 * One job row and one budget row per request, always in that order, so no
 * deadlock is possible between concurrent callers.
 *
 * FAKE keeps using startRun unchanged — two methods, no shared-path refactor.
 */
export async function startLiveRunWithAttemptLimit(
  prisma: PrismaClient,
  params: {
    readonly jobId: string;
    readonly modelIdentifier: string | null;
    readonly maxLiveAttempts: number;
    readonly budget: LiveRunBudgetReservationInput;
    /**
     * The caller's key for THIS request, required for every LIVE run. Repeating
     * it is what makes recovery safe; a fresh one is a new paid attempt by
     * definition. See @opspilot/contracts' LIVE_RUN_IDEMPOTENCY_KEY_HEADER.
     */
    readonly clientRequestId: string;
  },
): Promise<LiveRunStartResult> {
  const { jobId, modelIdentifier, maxLiveAttempts, budget, clientRequestId } = params;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Same lock, same reason, same source-of-truth guarantee as startRun:
      //    the locked row is the only place this run's ticket context comes from.
      const jobRows = await tx.$queryRaw<
        { id: string; ticketContext: unknown; externalTicketId: string; createdAt: Date }[]
      >`
        SELECT id, ticket_context AS "ticketContext", external_ticket_id AS "externalTicketId",
               created_at AS "createdAt"
        FROM agent_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const [jobRow] = jobRows;
      if (!jobRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentJob ${jobId} not found`);
      }

      const jobRecord = fromAgentJobRow(jobRow);

      // 2. REPLAY LOOKUP, under the same job lock that serializes creation.
      //
      //    The lock is what makes this correct rather than merely likely: two
      //    concurrent requests carrying the same key cannot both find nothing,
      //    because the second cannot read until the first has committed its
      //    insert. The partial unique index on (job_id, client_request_id) then
      //    stands behind that as a durable guarantee — see the migration.
      //
      //    Deliberately NOT filtered by provider_mode or status. The key is only
      //    ever written by the insert at the end of this function, so any row
      //    bearing it is a LIVE run this same path created; and a RUNNING row is
      //    the exact case this mechanism exists for — the provider executed and
      //    finalization failed. Returning it unchanged, and letting the caller's
      //    ordinary refresh observe its later state, is the entire point.
      const replayed = await tx.agentRun.findFirst({ where: { jobId, clientRequestId } });
      if (replayed) {
        return { kind: "replayed" as const, jobRecord, runRow: replayed };
      }

      // 3. STORED CONTEXT vs. CURRENT LIVE EXECUTION BOUNDS.
      //
      //    fromAgentJobRow above validated this row against the permissive
      //    StoredTicketContextSchema, which is right for a read: history stays
      //    readable. But this snapshot is about to be sent to a provider that
      //    CHARGES for it, and a job created before the 15..2000 rule existed
      //    would otherwise start a paid run with a summary no current caller is
      //    allowed to submit.
      //
      //    The test is CANONICAL FORM, not merely "parses". The value that
      //    reaches the provider is `jobRecord.ticketContext` — this stored
      //    snapshot, untouched — while the schema trims before it measures. A
      //    row padded with megabytes of whitespace around a valid 20-character
      //    summary would therefore satisfy a 15..2000 bound that was never
      //    applied to the string actually billed for. Requiring the stored value
      //    to already equal its parsed form makes the measured value and the
      //    sent value the same string. See isLiveExecutionEligible.
      //
      //    Placed here, under the lock and ahead of every side effect, so a
      //    rejection consumes no attempt, no reservation, and no provider call —
      //    the transaction simply rolls back. Nothing is truncated, padded, or
      //    rewritten to make a row fit, and nothing is written back: the run is
      //    refused and the row stays exactly as it is.
      //
      //    FAKE is unaffected and stays legacy-compatible. It goes through
      //    startRun, spends nothing, and has no reason to enforce an input rule
      //    retroactively.
      if (!isLiveExecutionEligible(jobRecord.ticketContext)) {
        throw new LiveRunAdmissionError("LIVE_RUN_CONTEXT_INVALID");
      }

      // 4. Counted under the job lock, so the value cannot change between the
      //    check and the insert below. Uses the agent_runs(job_id, provider_mode)
      //    index added in the same migration as live_run_budget.
      const [liveCountRow] = await tx.$queryRaw<{ liveRuns: number }[]>`
        SELECT count(*)::int AS "liveRuns"
        FROM agent_runs WHERE job_id = ${jobId}::uuid AND provider_mode = 'LIVE'`;
      const liveRuns = liveCountRow?.liveRuns ?? 0;
      if (liveRuns >= maxLiveAttempts) {
        // Rolls the whole transaction back — so this rejection consumes no
        // reservation, which is the entire point of doing it here.
        throw new LiveRunAdmissionError("LIVE_RUN_ATTEMPT_LIMIT");
      }

      // 5. Reserve the day. A single statement does insert-or-increment with the
      //    gate in its WHERE clause, so the read and the write cannot be
      //    separated by another transaction. Zero returned rows means the gate
      //    is closed — the run count is used up, the accumulated cost has
      //    crossed the ceiling, some earlier run's true cost is unknown, or an
      //    earlier reservation was never reconciled.
      //
      //    pricing_unknown_runs = 0 is required: an unknown cost is never
      //    treated as a known $0, so one unmeasurable run closes the cost gate
      //    for the rest of the day rather than letting spending continue blind.
      //
      //    runs_completed = runs_reserved is the FAIL-CLOSED LATCH, and it is
      //    the condition that makes the other two trustworthy. A reservation is
      //    committed BEFORE the provider runs; reconciliation adds the cost
      //    afterwards. If reconciliation fails, the row is left with
      //    runs_reserved > runs_completed and an estimated_cost_nano_usd that
      //    does not include the run that just happened — so the cost ceiling and
      //    the unknown-pricing gate would both be evaluated against figures that
      //    are known to be stale, and the day could keep admitting paid runs
      //    until only the hard run COUNT stopped it. The observed-estimate gate
      //    would have failed OPEN.
      //
      //    Requiring the counters to match makes an unreconciled reservation
      //    close the day by itself. The latch is the durable row, not process
      //    memory: it survives a restart and is shared by every instance, which
      //    an in-process flag would not be.
      //
      //    ON CONFLICT ... DO UPDATE with a WHERE is what makes a brand-new day
      //    and an existing day the same code path — and the INSERT arm is
      //    unaffected, so the first reservation of a new UTC day always
      //    succeeds even if yesterday's row is latched.
      const reservationRows = await tx.$queryRaw<{ budgetDate: Date; runsReserved: number }[]>`
        INSERT INTO live_run_budget (budget_date, runs_reserved, updated_at)
        VALUES (${budget.budgetDate}::date, 1, now())
        ON CONFLICT (budget_date) DO UPDATE
          SET runs_reserved = live_run_budget.runs_reserved + 1,
              updated_at = now()
          WHERE live_run_budget.runs_reserved < ${budget.dailyLimit}
            AND live_run_budget.estimated_cost_nano_usd < ${budget.costCeilingNanoUsd}
            AND live_run_budget.pricing_unknown_runs = 0
            AND live_run_budget.runs_completed = live_run_budget.runs_reserved
        RETURNING budget_date AS "budgetDate", runs_reserved AS "runsReserved"`;
      const [reservationRow] = reservationRows;
      if (!reservationRow) {
        throw new LiveRunAdmissionError("LIVE_RUN_BUDGET_EXHAUSTED");
      }

      // 6. attempt_number counts ALL attempts, live and deterministic alike —
      //    it is the run's ordinal within the job, not a live-only counter. The
      //    attempt LIMIT above counts only LIVE rows, which is why the two
      //    numbers legitimately differ.
      const [maxAttemptRow] = await tx.$queryRaw<{ maxAttempt: number }[]>`
        SELECT COALESCE(MAX(attempt_number), 0)::int AS "maxAttempt"
        FROM agent_runs WHERE job_id = ${jobId}::uuid`;
      const nextAttempt = (maxAttemptRow?.maxAttempt ?? 0) + 1;

      const runRow = await tx.agentRun.create({
        data: {
          jobId,
          attemptNumber: nextAttempt,
          status: "RUNNING",
          startedAt: new Date(),
          providerMode: "LIVE",
          modelIdentifier,
          // Written in the SAME statement that creates the run, inside the same
          // transaction as the reservation. There is no window in which a run
          // exists without its key: a crash between the two is impossible
          // because there are not two.
          clientRequestId,
        },
      });

      // Same atomicity guarantee as startRun. The REPLAYED branch above
      // returns before reaching this point and therefore writes no event —
      // correctly, because it creates no run.
      await insertRunCreatedEvent(tx, runRow.id);

      return { kind: "started" as const, jobRecord, runRow, reservationRow };
    });

    if (result.kind === "replayed") {
      return {
        outcome: "replayed",
        job: result.jobRecord,
        run: fromAgentRunRow(result.runRow),
      };
    }

    return {
      outcome: "started",
      job: result.jobRecord,
      run: fromAgentRunRow(result.runRow),
      reservation: {
        // Formatted from the DATE the database actually stored, not from the
        // input string, so reconciliation keys off the committed value.
        budgetDate: toBudgetDateString(result.reservationRow.budgetDate),
        runsReserved: result.reservationRow.runsReserved,
      },
    };
  } catch (error) {
    // A domain admission rejection is not a database failure and must not be
    // normalized into one — normalizeDatabaseError would turn it into a 503.
    if (error instanceof LiveRunAdmissionError) throw error;
    throw normalizeDatabaseError(error, "startLiveRunWithAttemptLimit");
  }
}

/**
 * Finds the run a client key already names on a job — and does NOTHING else.
 *
 * A read-only sibling of `startLiveRunWithAttemptLimit`, existing so that
 * RECOVERING an existing request and ADMITTING a new paid one can be separated in
 * the caller. The API used to run every new-run spend gate (rate limit, advisory
 * budget, concurrency lease) before it ever reached the transaction that performs
 * the key lookup, which made the documented 200 replay unreachable in exactly the
 * situations it exists for: a request whose original attempt consumed the final
 * daily reservation, or left the day latched, could never be recovered, because
 * the gate its own original attempt closed answered first.
 *
 *   BEGIN
 *     1. SELECT agent_jobs FOR UPDATE       -> PERSISTENCE_NOT_FOUND (404)
 *     2. SELECT the LIVE run bearing the key
 *   COMMIT
 *
 * THE JOB LOCK IS THE POINT, and an unlocked SELECT would not do. A recovery
 * racing its own original request must not be able to read past it while that
 * request's transaction is still open: it would see no row, conclude "nothing was
 * created", and go on to admit a second paid execution. Taking the SAME AgentJob
 * lock the creating transaction holds makes the two serialize, so the recovery
 * either waits and then sees the committed row, or waits and then correctly sees
 * nothing because the original rolled back.
 *
 * NO WRITE OF ANY KIND. No attempt count, no reservation, no insert, no status
 * change — which is what makes it safe to run before the spend gates rather than
 * after them. A missing job is reported as PERSISTENCE_NOT_FOUND, exactly as the
 * creating transaction reports it, so a request naming a job that does not exist
 * gets the same 404 whichever path answered it.
 *
 * The `providerMode` filter restates an invariant rather than adding one: the key
 * column is only ever written by the insert at the end of
 * `startLiveRunWithAttemptLimit`, so every row bearing a key is already a LIVE
 * run. Saying so here means this query cannot start returning something else if
 * that ever changes.
 *
 * Status is deliberately NOT consulted. RUNNING, COMPLETED and FAILED all replay
 * identically — a RUNNING row is the normal shape of the case this mechanism
 * exists for (the provider executed and finalization failed), and re-running the
 * agent because a row looks unfinished is precisely the duplicate charge the key
 * prevents.
 */
export async function replayLiveRun(
  prisma: PrismaClient,
  params: { readonly jobId: string; readonly clientRequestId: string },
): Promise<ReplayedLiveRun | null> {
  const { jobId, clientRequestId } = params;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Same lock, same order, same source-of-truth guarantee as the creating
      // transaction — see startLiveRunWithAttemptLimit step 1.
      const jobRows = await tx.$queryRaw<
        { id: string; ticketContext: unknown; externalTicketId: string; createdAt: Date }[]
      >`
        SELECT id, ticket_context AS "ticketContext", external_ticket_id AS "externalTicketId",
               created_at AS "createdAt"
        FROM agent_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const [jobRow] = jobRows;
      if (!jobRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentJob ${jobId} not found`);
      }

      // Validated against the PERMISSIVE stored schema, like every other read.
      // A replay must stay readable for a job today's input rules would refuse:
      // the run it returns was already created, and possibly already paid for, so
      // a rule about what may START cannot change what a finished run cost. The
      // strict LIVE eligibility check belongs to new execution only, and lives in
      // startLiveRunWithAttemptLimit.
      const jobRecord = fromAgentJobRow(jobRow);

      const runRow = await tx.agentRun.findFirst({
        where: { jobId, clientRequestId, providerMode: "LIVE" },
      });

      return runRow === null ? null : { jobRecord, runRow };
    });

    if (result === null) return null;
    return {
      outcome: "replayed",
      job: result.jobRecord,
      run: fromAgentRunRow(result.runRow),
    };
  } catch (error) {
    throw normalizeDatabaseError(error, "replayLiveRun");
  }
}

/**
 * Adds a finished run's observed usage to the day it RESERVED against.
 *
 * A separate autocommit statement, deliberately not part of the run's own
 * finalization transaction: the budget must stay durable even when finalizing
 * the run itself failed. A run that spent tokens has to be accounted for whether
 * or not its trace could be written.
 *
 * `budgetDate` comes from the reservation, never from a fresh clock read — see
 * LiveRunBudgetReservationInput. Reservations are never released once committed:
 * a leaked reservation costs the demo one run out of ten, while releasing one
 * for a request that did spend money costs real dollars.
 *
 * An unknown or possibly-unobserved cost contributes ZERO to the cost total and
 * increments `pricing_unknown_runs`, which closes the cost gate for the rest of
 * that UTC day. It is never recorded as a known free run.
 *
 * IF THIS CALL FAILS, the row is left with `runs_reserved > runs_completed`. That
 * mismatch is not merely an accounting blemish — it is the fail-closed LATCH read
 * by both the reservation statement and `isLiveRunBudgetOpen`, and it closes the
 * day to further LIVE runs until the counters agree again.
 *
 * The precise distinction, because the earlier reasoning here was wrong: the
 * daily RUN COUNT is still correct after a failed reconciliation, because
 * `runs_reserved` was incremented before execution and is never decremented. The
 * COST ACCOUNTING is not: `estimated_cost_nano_usd` and `pricing_unknown_runs`
 * are missing a run that already executed. Continuing to admit runs against those
 * stale figures would let the observed-estimate gate fail OPEN, with only the
 * hard run count left to stop the day. Hence the latch.
 */
export async function reconcileLiveRunBudget(
  prisma: PrismaClient,
  reservation: LiveRunBudgetReservation,
  usage: RunProviderUsageWrite,
): Promise<void> {
  const costIsKnown = usage.estimatedCostNanoUsd !== null && !usage.possibleUnobservedCost;
  const observedNanoUsd = costIsKnown ? (usage.estimatedCostNanoUsd as bigint) : 0n;
  const unknownIncrement = costIsKnown ? 0 : 1;

  try {
    await prisma.$executeRaw`
      UPDATE live_run_budget
         SET runs_completed = runs_completed + 1,
             estimated_cost_nano_usd = estimated_cost_nano_usd + ${observedNanoUsd},
             pricing_unknown_runs = pricing_unknown_runs + ${unknownIncrement},
             updated_at = now()
       WHERE budget_date = ${reservation.budgetDate}::date`;
  } catch (error) {
    throw normalizeDatabaseError(error, "reconcileLiveRunBudget");
  }
}

/**
 * Whether a new LIVE run could be reserved right now, without reserving one.
 *
 * Read-only and deliberately advisory: it powers `/v1/capabilities` and the
 * cheap pre-check, never enforcement. The authoritative gate is the WHERE clause
 * inside startLiveRunWithAttemptLimit's reservation statement, which is the only
 * place that can decide this without a race.
 *
 * A missing row means the day has not started yet, which is open by definition.
 *
 * Every condition here MIRRORS the authoritative statement's WHERE clause,
 * including the runs_completed = runs_reserved latch. The two are allowed to
 * disagree only in the harmless direction — advisory says open, the transaction
 * still refuses — and keeping them in step is what stops `/v1/capabilities` from
 * advertising AVAILABLE for a day that every reservation would be rejected on.
 *
 * The caller learns only `false`. Which condition closed the day — count,
 * ceiling, unknown pricing, or an unreconciled reservation — is never
 * distinguishable from the outside; see the capabilities controller's opacity
 * contract.
 */
export async function isLiveRunBudgetOpen(
  prisma: PrismaClient,
  budget: LiveRunBudgetReservationInput,
): Promise<boolean> {
  try {
    const [row] = await prisma.$queryRaw<
      {
        runsReserved: number;
        runsCompleted: number;
        estimatedCostNanoUsd: bigint;
        pricingUnknownRuns: number;
      }[]
    >`
      SELECT runs_reserved AS "runsReserved",
             runs_completed AS "runsCompleted",
             estimated_cost_nano_usd AS "estimatedCostNanoUsd",
             pricing_unknown_runs AS "pricingUnknownRuns"
      FROM live_run_budget WHERE budget_date = ${budget.budgetDate}::date`;

    if (!row) return true;

    return (
      row.runsReserved < budget.dailyLimit &&
      row.estimatedCostNanoUsd < budget.costCeilingNanoUsd &&
      row.pricingUnknownRuns === 0 &&
      // The fail-closed latch. An outstanding reservation means the cost figures
      // above are stale by a run that has already executed, so they cannot be
      // trusted to gate another one.
      row.runsCompleted === row.runsReserved
    );
  } catch (error) {
    throw normalizeDatabaseError(error, "isLiveRunBudgetOpen");
  }
}

/**
 * Phase A — INERT. Nothing in the production start/orchestrator/finalize
 * path calls this yet; it is validated end-to-end by repository integration
 * tests only, so a later phase can wire it into the real orchestrator
 * emission points without redesigning the write itself
 * (docs/reviews/21-issue-37-incremental-event-persistence-plan.md §4/§8).
 *
 * Appends exactly one canonical lifecycle event to `runId`'s ledger, inside
 * one transaction:
 *
 *   1. lock the agent_runs row FOR UPDATE
 *        missing            -> PERSISTENCE_NOT_FOUND
 *        status <> RUNNING  -> PERSISTENCE_CONFLICT (nothing may follow a terminal event)
 *   2. resolveCanonicalEventReplay — the all-12 exact-replay policy
 *        replay   -> return the original record; insert nothing, consume no sequence
 *        conflict -> PERSISTENCE_CONFLICT, nothing inserted
 *   3. allocate COALESCE(MAX(sequence_number), 0) + 1, still under the run-row lock
 *   4. insert, using the database's own created_at for recordedAt
 *   5. re-read the full canonical stream in sequence order
 *   6. deriveExecutionStageProgress({ events, runStatus: "RUNNING", now: latestRecordedAt })
 *        throws -> roll back the whole transaction (including the insert),
 *                  translate to PERSISTENCE_EVENT_STREAM_INVALID
 *   7. commit only if the reducer accepted the resulting stream
 *
 * Handles only the TEN non-terminal canonical types. RUN_COMPLETED and
 * RUN_FAILED are rejected outright, before the transaction even opens — see
 * TERMINAL_EVENT_TYPES above.
 *
 * UNIQUE(run_id, sequence_number) remains as defense in depth: the run-row
 * lock is what makes the allocation race-free, not the constraint.
 */
export async function appendInvestigationEvent(
  prisma: PrismaClient,
  runId: string,
  payload: unknown,
): Promise<InvestigationEventRecord> {
  // Validate BEFORE the transaction opens — an invalid write never touches
  // the database (the same house rule every other toXWrite mapper in this
  // package follows).
  const validated = validateOrThrow(InvestigationEventPayloadSchema, payload, "Investigation event payload");

  if (isTerminalEventType(validated.type)) {
    throw new PersistenceError(
      "PERSISTENCE_VALIDATION_FAILED",
      `appendInvestigationEvent must not be used to write ${validated.type}; it is owned exclusively by the terminal finalize transaction.`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const [runRow] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`;
      if (!runRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
      }
      if (runRow.status !== "RUNNING") {
        throw new PersistenceError(
          "PERSISTENCE_CONFLICT",
          `AgentRun ${runId} is not RUNNING; no further canonical event may be appended to it`,
        );
      }

      const replay = await resolveCanonicalEventReplay(tx, runId, validated);
      if (replay.kind === "replay") {
        // No insert, no sequence consumption — the ambiguous-success-retry
        // case never reaches allocation, let alone the reducer, so it can
        // never surface as PERSISTENCE_EVENT_STREAM_INVALID.
        return {
          runId,
          sequence: replay.sequenceNumber,
          recordedAt: replay.createdAt.toISOString(),
          payload: validated,
        };
      }

      const nextSequence = await allocateNextSequence(tx, runId);
      const inserted = await insertCanonicalEventRow(tx, runId, nextSequence, validated);

      // Re-read the full canonical stream and run it through the SAME
      // reducer the terminal transaction uses — an invalid candidate stream
      // must never become durably observable, even transiently, and
      // re-reading (rather than appending to an in-memory list) is what
      // makes this check see exactly what is about to commit. A rejection
      // rolls back the insert above, so the candidate leaves zero new rows.
      assertCanonicalStreamValid(
        await readCanonicalStream(tx, runId),
        "RUNNING",
        `Appending ${validated.type} to AgentRun ${runId}`,
      );

      return {
        runId,
        sequence: inserted.sequenceNumber,
        recordedAt: inserted.createdAt.toISOString(),
        payload: validated,
      };
    });
  } catch (error) {
    throw normalizeDatabaseError(error, "appendInvestigationEvent");
  }
}

/**
 * Phase A — repository-only, matching `appendInvestigationEvent`: no HTTP
 * endpoint, no DTO, no controller. Reads the full canonical stream for
 * `runId` in sequence order — including a mid-flight RUNNING run's partial
 * prefix, which is the direct proof of #37's headline acceptance criterion
 * (a run is queryable before it terminates).
 *
 * `RepeatableRead`, matching `getAgentRun`'s own consistency guarantee.
 * Every row is revalidated against `InvestigationEventRecordSchema` and
 * contiguity is re-checked on every read (`fromInvestigationEventRows`),
 * independent of what the write path already enforced.
 */
export async function getInvestigationEventRecords(
  prisma: PrismaClient,
  runId: string,
): Promise<readonly InvestigationEventRecord[]> {
  try {
    const rows = await prisma.$transaction(
      async (tx) => {
        const runRow = await tx.agentRun.findUnique({ where: { id: runId }, select: { id: true } });
        if (!runRow) {
          throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
        }
        return tx.agentTraceEvent.findMany({
          where: { runId },
          orderBy: { sequenceNumber: "asc" },
          select: { sequenceNumber: true, payload: true, createdAt: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return fromInvestigationEventRows(runId, rows);
  } catch (error) {
    throw normalizeDatabaseError(error, "getInvestigationEventRecords");
  }
}

/**
 * One RepeatableRead snapshot of a job plus its latest run (by
 * MAX(attemptNumber)), the legacy trace projection, the run outcome, and the
 * raw canonical event records — all from a single consistent database read.
 *
 * A two-call read (getAgentJob then getAgentRun/getInvestigationEventRecords
 * in separate transactions) can pair `runStatus: "RUNNING"` with a stream
 * that already contains `RUN_COMPLETED`; the shared reducer rejects that pair
 * with `RUN_STATUS_MISMATCH`. This single-snapshot read prevents that.
 *
 * `run` / `outcome` are `null` and `trace` / `events` are `[]` when the job
 * has no run yet — the window between `createAgentJob` resolving and the
 * run-creation transaction committing is real and expected.
 *
 * `events` carries the raw, fully-validated record for EVERY row this run
 * has — canonical or legacy — via `fromInvestigationEventRows`, which is
 * safe for both: `InvestigationEventRecordSchema`'s payload union is a
 * strict superset of the 4 legacy `AgentTraceEventSchema` types (the same
 * shared schema objects, plus `REPORT_GENERATED` as the one permanently
 * accepted legacy read-compat type — see investigation-event.ts). The
 * canonical-vs-legacy VERDICT is deliberately not decided here: the client
 * calls the exported `hasCanonicalInvestigationLifecycleMarker(events)`
 * itself, exactly the same defensive probe `fromTraceEventRows` uses for
 * `trace` — one public/client boundary decides the distinction, not a
 * server-side gate that could disagree with it.
 */
export async function getInvestigationState(
  prisma: PrismaClient,
  jobId: string,
): Promise<PersistedInvestigationState> {
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const jobRow = await tx.agentJob.findUnique({ where: { id: jobId } });
        if (!jobRow) {
          throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentJob ${jobId} not found`);
        }

        // Latest attempt only — there is no at-most-one-RUNNING-run invariant
        // (docs/16 §8), so the caller additionally applies a minAttemptNumber
        // floor during a retry.
        const runRow = await tx.agentRun.findFirst({
          where: { jobId },
          orderBy: { attemptNumber: "desc" },
        });

        if (!runRow) {
          return { jobRow, runRow: null, traceRows: [] };
        }

        const traceRows = await tx.agentTraceEvent.findMany({
          where: { runId: runRow.id },
          orderBy: { sequenceNumber: "asc" },
          select: { sequenceNumber: true, payload: true, createdAt: true },
        });

        return { jobRow, runRow, traceRows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const job = fromAgentJobRow(result.jobRow);

    if (!result.runRow) {
      return { job, run: null, trace: [], outcome: null, events: [] };
    }

    const run = fromAgentRunRow(result.runRow);
    const trace = fromTraceEventRows(run.id, result.traceRows);
    const outcome = buildOutcome(result.runRow);

    // Every row this run has, canonical or legacy, fully validated. See the
    // doc comment above: the record payload union is a strict superset of
    // the legacy trace-event union, so this never throws on a genuinely
    // legacy stream — only on rows that fail EITHER schema (already rejected
    // above by `fromTraceEventRows`) or a contiguity violation. An empty row
    // set (job with no run) already returned above, so result.traceRows is
    // non-empty here.
    const events = fromInvestigationEventRows(run.id, result.traceRows);

    return { job, run, trace, outcome, events };
  } catch (error) {
    throw normalizeDatabaseError(error, "getInvestigationState");
  }
}

/**
 * The one place a run becomes terminal — and the one place a terminal
 * canonical event is written.
 *
 * Phase B replaces the old persist-after batch (`createMany` of the whole
 * in-memory trace) with canonical terminal persistence: every preceding
 * event was already appended incrementally during execution, so all that
 * remains is the terminal fact itself, written atomically with the status
 * update.
 *
 * RUNNING, in one transaction:
 *
 *   1. lock the agent_runs row FOR UPDATE
 *   2. refuse corruption: a terminal event already present while the run is
 *      still RUNNING means something wrote outside this repository — never
 *      promote the status, never insert a second terminal event, never treat
 *      it as a replay whatever its payload says
 *   3. allocate the next sequence
 *   4. insert RUN_COMPLETED / RUN_FAILED
 *   5. re-read the complete canonical stream
 *   6. reducer-validate it against the TARGET terminal status
 *   7. only then update status / report | failure_code / usage / finished_at
 *   8. any failure rolls back the event AND the run update together
 *
 * That ordering is what makes the production invariant true rather than
 * merely tested: a terminal database row can never commit with a
 * reducer-invalid canonical stream.
 *
 * ALREADY TERMINAL — exact replay, using the SAME all-12 replay helper the
 * incremental append uses. There is no second, terminal-only replay policy.
 */
async function finalizeTerminal(
  prisma: PrismaClient,
  runId: string,
  terminal:
    | { readonly kind: "COMPLETED"; readonly report: unknown }
    | { readonly kind: "FAILED"; readonly code: unknown; readonly failedStage: unknown },
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  // Runtime-validate before the transaction begins — an invalid outcome
  // never touches the database. Validating the canonical payload here also
  // validates failureCode/failedStage against the contract's closed enums,
  // so a bogus stage can never reach an INSERT.
  const report = terminal.kind === "COMPLETED" ? toReportWrite(terminal.report) : null;
  const failureCode = terminal.kind === "FAILED" ? toFailureCodeWrite(terminal.code) : null;
  const terminalPayload = validateOrThrow(
    InvestigationEventPayloadSchema,
    terminal.kind === "COMPLETED"
      ? { type: "RUN_COMPLETED" }
      : { type: "RUN_FAILED", failureCode, failedStage: terminal.failedStage },
    "Terminal investigation event payload",
  );
  const targetStatus = terminal.kind === "COMPLETED" ? "COMPLETED" : "FAILED";

  // Absent for a FAKE run, so the six usage columns are never mentioned in the
  // UPDATE at all and stay NULL. An explicit `{ inputTokens: null, ... }` would
  // work too, but building the object only when there is usage to write keeps
  // "no measurement was taken" visible in the code rather than encoded as a
  // wall of nulls.
  const usageWriteData =
    usage === undefined
      ? {}
      : {
          providerCallsObserved: usage.providerCallsObserved,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostNanoUsd: usage.estimatedCostNanoUsd,
          pricingStatus: usage.pricingStatus,
          possibleUnobservedCost: usage.possibleUnobservedCost,
        };

  try {
    const row = await prisma.$transaction(async (tx) => {
      const [runRow] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`;
      if (!runRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
      }
      const currentStatus = runRow.status;
      const storedTerminalTypes = await findTerminalEventTypes(tx, runId);

      if (currentStatus === "RUNNING") {
        // A terminal event on a RUNNING run is unreachable through this
        // code — the two commit together — so observing one means the row
        // was written by something else. Refuse rather than repair: promoting
        // the status would vouch for a history nobody can vouch for, and a
        // second terminal event would make the stream permanently invalid.
        if (storedTerminalTypes.length > 0) {
          throw new PersistenceError(
            "PERSISTENCE_EVENT_STREAM_INVALID",
            `AgentRun ${runId} is RUNNING but already carries a terminal canonical event`,
          );
        }

        const nextSequence = await allocateNextSequence(tx, runId);
        await insertCanonicalEventRow(tx, runId, nextSequence, terminalPayload);

        assertCanonicalStreamValid(
          await readCanonicalStream(tx, runId),
          targetStatus,
          `Finalizing AgentRun ${runId} as ${targetStatus}`,
        );

        if (terminal.kind === "COMPLETED") {
          return tx.agentRun.update({
            where: { id: runId },
            data: {
              status: "COMPLETED",
              report: report as Prisma.InputJsonValue,
              finishedAt: new Date(),
              // Written in the SAME statement that sets the terminal status —
              // never a second UPDATE afterwards. A follow-up patch could fail
              // on its own and leave a finalized run whose usage disagrees with
              // what the budget was reconciled from.
              ...usageWriteData,
            },
          });
        }
        return tx.agentRun.update({
          where: { id: runId },
          data: { status: "FAILED", failureCode, finishedAt: new Date(), ...usageWriteData },
        });
      }

      // ── Already terminal ────────────────────────────────────────────
      // Stored-state INTEGRITY is established completely before the
      // incoming request is consulted at all — a corrupted stored state must
      // never be classified as an ordinary conflict with whatever the caller
      // happened to ask for (Codex Phase B review, finding M1). A terminal
      // status with no terminal event, with BOTH terminal events, or whose
      // sole terminal event disagrees with the stored status are each stored
      // corruption — never a replay decision, and never something to repair.
      if (storedTerminalTypes.length === 0) {
        throw new PersistenceError(
          "PERSISTENCE_EVENT_STREAM_INVALID",
          `AgentRun ${runId} is ${currentStatus} but carries no terminal canonical event`,
        );
      }
      if (storedTerminalTypes.length > 1) {
        throw new PersistenceError(
          "PERSISTENCE_EVENT_STREAM_INVALID",
          `AgentRun ${runId} carries both RUN_COMPLETED and RUN_FAILED`,
        );
      }

      // The stored status and the stored terminal event must name the SAME
      // outcome. `COMPLETED` with a lone `RUN_FAILED` row (or the symmetric
      // `FAILED` with a lone `RUN_COMPLETED` row) is exactly the corruption
      // this guards against — checked here, before any comparison against
      // the incoming request, so it can never be misread as "the caller
      // asked for the opposite outcome."
      const requiredStoredEventType: TerminalEventType =
        currentStatus === "COMPLETED" ? "RUN_COMPLETED" : "RUN_FAILED";
      if (storedTerminalTypes[0] !== requiredStoredEventType) {
        throw new PersistenceError(
          "PERSISTENCE_EVENT_STREAM_INVALID",
          `AgentRun ${runId} is ${currentStatus} but its stored terminal event is ${storedTerminalTypes[0]}`,
        );
      }

      // Stored-state integrity is now established. Reducer-validate the
      // complete stored stream against the STORED status — independent of
      // what the incoming request asks for — before deciding whether that
      // request is a replay or a genuine conflict.
      assertCanonicalStreamValid(
        await readCanonicalStream(tx, runId),
        currentStatus === "COMPLETED" ? "COMPLETED" : "FAILED",
        `Replaying terminal finalization of AgentRun ${runId}`,
      );

      // Only now is the incoming request compared against the (known-healthy)
      // stored outcome.
      const statusMatches =
        (terminal.kind === "COMPLETED" && currentStatus === "COMPLETED") ||
        (terminal.kind === "FAILED" && currentStatus === "FAILED");
      if (!statusMatches) {
        // A completed-vs-failed race: the loser observes the winner's
        // terminal status and must never overwrite it. Reachable only for a
        // HEALTHY stored state — corruption was already refused above.
        throw new PersistenceError(
          "PERSISTENCE_CONFLICT",
          `AgentRun ${runId} is already ${currentStatus}; cannot finalize it as ${targetStatus}`,
        );
      }

      // The SAME exact-replay policy the incremental append uses. Given the
      // two checks above, `terminalPayload.type` and `storedTerminalTypes[0]`
      // are now guaranteed equal, so the lookup always finds the stored row —
      // "absent" is unreachable here and kept only as a defensive invariant
      // guard, matching the reducer's own unreachable-but-asserted branches.
      // A same-type payload that disagrees — a different failureCode or
      // failedStage — throws PERSISTENCE_CONFLICT from inside the helper.
      const replay = await resolveCanonicalEventReplay(tx, runId, terminalPayload);
      if (replay.kind === "absent") {
        throw new PersistenceError(
          "PERSISTENCE_EVENT_STREAM_INVALID",
          `AgentRun ${runId}: stored terminal event type matched but the exact-replay lookup found no row (internal invariant violated)`,
        );
      }

      const [comparison] = await tx.$queryRaw<{ outcomeMatches: boolean }[]>`
        SELECT ${
          terminal.kind === "COMPLETED"
            ? Prisma.sql`(SELECT report FROM agent_runs WHERE id = ${runId}::uuid) IS NOT DISTINCT FROM ${JSON.stringify(report)}::jsonb`
            : Prisma.sql`(SELECT failure_code FROM agent_runs WHERE id = ${runId}::uuid) IS NOT DISTINCT FROM ${failureCode}`
        } AS "outcomeMatches"`;
      if (!comparison) {
        throw new PersistenceError(
          "PERSISTENCE_UNAVAILABLE",
          `finalize: replay-comparison query for AgentRun ${runId} returned no row`,
        );
      }
      if (!comparison.outcomeMatches) {
        throw new PersistenceError(
          "PERSISTENCE_CONFLICT",
          `AgentRun ${runId} is already terminal with a different outcome`,
        );
      }

      // Idempotent success — no rows inserted, no columns updated, and in
      // particular usage is NOT rewritten. The first finalization's usage is
      // the authoritative record; a retry re-supplying the same snapshot must
      // be a no-op, and one supplying a different snapshot must not be able to
      // overwrite what the budget was already reconciled from.
      //
      // Usage is deliberately excluded from the replay comparison: the
      // exact-replay contract is about the terminal event and the terminal
      // outcome, and failing a retry over a usage difference would strand a
      // run that is otherwise correctly finalized.
      return tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    });
    return fromAgentRunRow(row);
  } catch (error) {
    throw normalizeDatabaseError(error, `finalize${terminal.kind === "COMPLETED" ? "Completed" : "Failed"}`);
  }
}

// `usage` is optional and omitted for FAKE, which is what leaves the six usage
// columns NULL for a deterministic run.
//
// The `trace` parameter is GONE as of Phase B: every event preceding the
// terminal one was already persisted incrementally during execution, so
// there is no batch left to hand over.
export function finalizeCompleted(
  prisma: PrismaClient,
  runId: string,
  report: unknown,
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, { kind: "COMPLETED", report }, usage);
}

// A FAILED live run persists its usage too: the tokens were spent whether or not
// the run produced a report, and a failure that is not accounted for is a
// failure that gets billed twice.
//
// `failedStage` is supplied by the orchestrator result rather than inferred
// here — persistence must never guess which stage a run died in.
export function finalizeFailed(
  prisma: PrismaClient,
  runId: string,
  code: unknown,
  failedStage: unknown,
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, { kind: "FAILED", code, failedStage }, usage);
}

// Explicit interactive transaction with RepeatableRead — not a bare Prisma
// nested `include` — so the job row and its run rows are guaranteed to be
// read from one consistent snapshot under concurrent writes, matching
// getAgentRun's own consistency guarantee below. Never returns trace events
// or reports: this is a job-summary read model only (see
// docs/11-agent-run-persistence.md); callers use getAgentRun for a single
// run's full detail.
export async function getAgentJob(prisma: PrismaClient, jobId: string): Promise<PersistedAgentJob> {
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const jobRow = await tx.agentJob.findUnique({ where: { id: jobId } });
        if (!jobRow) {
          throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentJob ${jobId} not found`);
        }
        const runRows = await tx.agentRun.findMany({
          where: { jobId },
          orderBy: { attemptNumber: "asc" },
        });
        return { jobRow, runRows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      job: fromAgentJobRow(result.jobRow),
      runs: result.runRows.map(fromAgentRunRow),
    };
  } catch (error) {
    throw normalizeDatabaseError(error, "getAgentJob");
  }
}

export async function getAgentRun(prisma: PrismaClient, runId: string): Promise<PersistedAgentRun> {
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const run = await tx.agentRun.findUnique({ where: { id: runId }, include: { job: true } });
        if (!run) {
          throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
        }
        const traceRows = await tx.agentTraceEvent.findMany({
          where: { runId },
          orderBy: { sequenceNumber: "asc" },
          select: { sequenceNumber: true, payload: true, createdAt: true },
        });
        return { run, traceRows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      job: fromAgentJobRow(result.run.job),
      run: fromAgentRunRow(result.run),
      trace: fromTraceEventRows(runId, result.traceRows),
      outcome: buildOutcome(result.run),
    };
  } catch (error) {
    throw normalizeDatabaseError(error, "getAgentRun");
  }
}
