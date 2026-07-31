import type { AgentTraceEvent } from "@opspilot/contracts";

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
  fromTraceEventRows,
  toFailureCodeWrite,
  toReportWrite,
  toTicketContextWrite,
  toTraceEventCreateInputs,
} from "../mappers";
import type {
  AgentJobRecord,
  AgentRunRecord,
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  PersistedAgentJob,
  PersistedAgentRun,
  ProviderMode,
  RunProviderUsageWrite,
  StartedAgentRun,
  StartedLiveRun,
} from "../types";

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
 *     2. count LIVE runs for the job           -> LIVE_RUN_ATTEMPT_LIMIT (429)
 *     3. reserve the UTC-day budget row        -> LIVE_RUN_BUDGET_EXHAUSTED (429)
 *     4. allocate attempt_number; INSERT the run
 *   COMMIT
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
  },
): Promise<StartedLiveRun> {
  const { jobId, modelIdentifier, maxLiveAttempts, budget } = params;

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

      // 2. Counted under the job lock, so the value cannot change between the
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

      // 3. Reserve the day. A single statement does insert-or-increment with the
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

      // 4. attempt_number counts ALL attempts, live and deterministic alike —
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
        },
      });

      return { jobRecord, runRow, reservationRow };
    });

    return {
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

async function finalizeTerminal(
  prisma: PrismaClient,
  runId: string,
  traceInput: readonly AgentTraceEvent[],
  terminal:
    | { readonly kind: "COMPLETED"; readonly report: unknown }
    | { readonly kind: "FAILED"; readonly code: unknown },
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  // 1. Runtime-validate before the transaction even begins — an invalid
  //    trace/outcome never touches the database.
  const traceCreateInputs = toTraceEventCreateInputs(traceInput, runId);
  const report = terminal.kind === "COMPLETED" ? toReportWrite(terminal.report) : null;
  const failureCode = terminal.kind === "FAILED" ? toFailureCodeWrite(terminal.code) : null;
  // Includes sequenceNumber alongside payload — comparing payload alone would
  // incorrectly accept a stored [1, 3] as a replay of an incoming [1, 2] when
  // the payloads happen to be in the same order.
  const incomingTraceJson = JSON.stringify(
    traceCreateInputs.map((t) => ({ sequenceNumber: t.sequenceNumber, payload: t.payload })),
  );

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

      if (currentStatus === "RUNNING") {
        await tx.agentTraceEvent.createMany({ data: traceCreateInputs });
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

      // Already terminal — exact-replay check. Comparison is evaluated by
      // Postgres JSONB/text equality, never JS string equality: object-key
      // order is normalized away by JSONB, and array element order (which
      // is what actually matters for trace ordering) is preserved. Each
      // stored element is compared as { sequenceNumber, payload } together
      // — payload-only comparison would miss a stored [1, 3] vs. an
      // incoming [1, 2] with identical payload order.
      const [comparison] = await tx.$queryRaw<
        { traceMatches: boolean; outcomeMatches: boolean }[]
      >`
        SELECT
          COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object('sequenceNumber', sequence_number, 'payload', payload)
                ORDER BY sequence_number
              ) FROM agent_trace_events WHERE run_id = ${runId}::uuid),
            '[]'::jsonb
          ) = ${incomingTraceJson}::jsonb AS "traceMatches",
          ${
            terminal.kind === "COMPLETED"
              ? Prisma.sql`(SELECT report FROM agent_runs WHERE id = ${runId}::uuid) IS NOT DISTINCT FROM ${JSON.stringify(report)}::jsonb`
              : Prisma.sql`(SELECT failure_code FROM agent_runs WHERE id = ${runId}::uuid) IS NOT DISTINCT FROM ${failureCode}`
          } AS "outcomeMatches"
      `;
      if (!comparison) {
        throw new PersistenceError(
          "PERSISTENCE_UNAVAILABLE",
          `finalize: replay-comparison query for AgentRun ${runId} returned no row`,
        );
      }

      const statusMatches =
        (terminal.kind === "COMPLETED" && currentStatus === "COMPLETED") ||
        (terminal.kind === "FAILED" && currentStatus === "FAILED");

      if (statusMatches && comparison.traceMatches && comparison.outcomeMatches) {
        // Idempotent success — no trace rows inserted, no columns updated, and
        // in particular usage is NOT rewritten. The first finalization's usage
        // is the authoritative record; a retry re-supplying the same snapshot
        // must be a no-op, and one supplying a different snapshot must not be
        // able to overwrite what the budget was already reconciled from.
        //
        // Usage is deliberately excluded from the replay comparison above: the
        // exact-replay contract is about the trace and the terminal outcome, and
        // failing a retry over a usage difference would strand a run that is
        // otherwise correctly finalized.
        return tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
      }
      throw new PersistenceError(
        "PERSISTENCE_CONFLICT",
        `AgentRun ${runId} is already terminal with a different trace and/or outcome`,
      );
    });
    return fromAgentRunRow(row);
  } catch (error) {
    throw normalizeDatabaseError(error, `finalize${terminal.kind === "COMPLETED" ? "Completed" : "Failed"}`);
  }
}

// `usage` is optional and omitted for FAKE, which is what leaves the six usage
// columns NULL for a deterministic run.
export function finalizeCompleted(
  prisma: PrismaClient,
  runId: string,
  trace: readonly AgentTraceEvent[],
  report: unknown,
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, trace, { kind: "COMPLETED", report }, usage);
}

// A FAILED live run persists its usage too: the tokens were spent whether or not
// the run produced a report, and a failure that is not accounted for is a
// failure that gets billed twice.
export function finalizeFailed(
  prisma: PrismaClient,
  runId: string,
  trace: readonly AgentTraceEvent[],
  code: unknown,
  usage?: RunProviderUsageWrite,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, trace, { kind: "FAILED", code }, usage);
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
          select: { sequenceNumber: true, payload: true },
        });
        return { run, traceRows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      job: fromAgentJobRow(result.run.job),
      run: fromAgentRunRow(result.run),
      trace: fromTraceEventRows(result.traceRows),
      outcome: buildOutcome(result.run),
    };
  } catch (error) {
    throw normalizeDatabaseError(error, "getAgentRun");
  }
}
