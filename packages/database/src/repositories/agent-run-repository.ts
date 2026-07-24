import type { AgentTraceEvent } from "@opspilot/contracts";

import type { PrismaClient } from "../client";
// NOTE: verified against the actual installed Prisma 7.9.0 `prisma-client`
// generator output during the Prisma scaffolding checkpoint — adjust this
// import if the generator's real `Prisma` namespace export differs.
import { Prisma } from "../generated/prisma-client/client";
import { normalizeDatabaseError, PersistenceError } from "../errors";
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
  PersistedAgentJob,
  PersistedAgentRun,
  ProviderMode,
  StartedAgentRun,
} from "../types";

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

async function finalizeTerminal(
  prisma: PrismaClient,
  runId: string,
  traceInput: readonly AgentTraceEvent[],
  terminal:
    | { readonly kind: "COMPLETED"; readonly report: unknown }
    | { readonly kind: "FAILED"; readonly code: unknown },
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
            },
          });
        }
        return tx.agentRun.update({
          where: { id: runId },
          data: { status: "FAILED", failureCode, finishedAt: new Date() },
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
        // Idempotent success — no trace rows inserted, no columns updated.
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

export function finalizeCompleted(
  prisma: PrismaClient,
  runId: string,
  trace: readonly AgentTraceEvent[],
  report: unknown,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, trace, { kind: "COMPLETED", report });
}

export function finalizeFailed(
  prisma: PrismaClient,
  runId: string,
  trace: readonly AgentTraceEvent[],
  code: unknown,
): Promise<AgentRunRecord> {
  return finalizeTerminal(prisma, runId, trace, { kind: "FAILED", code });
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
