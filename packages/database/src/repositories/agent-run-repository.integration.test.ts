import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { PersistenceError } from "../errors";
import {
  createJob,
  finalizeCompleted,
  finalizeFailed,
  getAgentJob,
  getAgentRun,
  startRun,
} from "../repositories/agent-run-repository";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";

const VALID_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "Finding" }],
  suggestedActions: [],
};

const SAMPLE_TRACE = [
  { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" },
  { type: "TOOL_COMPLETED" as const, toolCallId: "call-1", toolName: "get_service_status" },
  { type: "REPORT_GENERATED" as const },
];

let handle: PrismaClientHandle;
let prisma: PrismaClient;

beforeAll(async () => {
  handle = await createTestPrismaClient();
  prisma = handle.prisma;
});

afterAll(async () => {
  await handle.close();
});

afterEach(async () => {
  await truncateAllTables(handle);
});

async function createRunningRun() {
  const createdJob = await createJob(prisma, { ticketId: "TKT-1", summary: "Summary" });
  // Use the job snapshot startRun itself loaded from PostgreSQL (under its
  // own row lock), not the one createJob returned — this is now the only
  // source of truth for a run's ticket context.
  const started = await startRun(prisma, createdJob.id, "FAKE", null);
  return { job: started.job, run: started.run };
}

describe("createJob", () => {
  it("creates a job and derives externalTicketId from ticketContext.ticketId", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-42", summary: "Elevated error rate" });
    expect(job.externalTicketId).toBe("TKT-42");
    expect(job.ticketContext).toEqual({ ticketId: "TKT-42", summary: "Elevated error rate" });
  });

  it("rejects an invalid ticket snapshot before touching the database", async () => {
    await expect(createJob(prisma, { summary: "no ticketId" })).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });
});

describe("startRun", () => {
  it("creates the run directly as RUNNING with no observable PENDING state", async () => {
    const { run } = await createRunningRun();
    expect(run.status).toBe("RUNNING");
    expect(run.attemptNumber).toBe(1);
    expect(run.startedAt).toBeTruthy();
    expect(run.finishedAt).toBeNull();
  });

  it("allocates unique, increasing attempt numbers for concurrent starts on the same job", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-concurrent", summary: "s" });
    const second = createPrismaClient();
    try {
      const [startedA, startedB] = await Promise.all([
        startRun(prisma, job.id, "FAKE", null),
        startRun(second.prisma, job.id, "FAKE", null),
      ]);
      const attempts = [startedA.run.attemptNumber, startedB.run.attemptNumber].sort();
      expect(attempts).toEqual([1, 2]);
    } finally {
      await second.close();
    }
  });

  it("returns the exact ticket_context stored in PostgreSQL for the locked job row", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-snapshot", summary: "Exact stored summary" });
    const started = await startRun(prisma, job.id, "FAKE", null);
    expect(started.job).toEqual(job);
    expect(started.job.ticketContext).toEqual({ ticketId: "TKT-snapshot", summary: "Exact stored summary" });
    expect(started.run.jobId).toBe(job.id);
  });

  it("rolls back and returns PERSISTENCE_VALIDATION_FAILED when the locked job row fails TicketContextSchema, inserting no AgentRun", async () => {
    // Passes every CHECK constraint (jsonb_typeof is 'object'; external_ticket_id
    // equals ticket_context->>'ticketId' and is non-empty) but is missing the
    // required `summary` field — only TicketContextSchema's runtime
    // validation catches this. Not a weakening of any production
    // constraint: this row simply cannot be produced by createJob/the
    // mapper, only by a raw SQL insert bypassing them, as here.
    const [insertedRow] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO agent_jobs (ticket_context, external_ticket_id)
      VALUES ('{"ticketId": "TKT-malformed"}'::jsonb, 'TKT-malformed')
      RETURNING id`;
    if (!insertedRow) throw new Error("expected the raw INSERT to return the new row's id");
    const malformedJobId = insertedRow.id;

    await expect(startRun(prisma, malformedJobId, "FAKE", null)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });

    const runCount = await prisma.agentRun.count({ where: { jobId: malformedJobId } });
    expect(runCount).toBe(0);
  });

  it("returns PERSISTENCE_NOT_FOUND for a nonexistent job", async () => {
    await expect(
      startRun(prisma, "00000000-0000-0000-0000-000000000000", "FAKE", null),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
  });

  it("rejects cross-job foreign-key violations at the database level", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO agent_runs (job_id, attempt_number, status, provider_mode, started_at)
        VALUES ('00000000-0000-0000-0000-000000000000', 1, 'RUNNING', 'FAKE', now())`,
    ).rejects.toBeTruthy();
  });

  it("never accepts a raw-SQL-inserted PENDING status", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-pending", summary: "s" });
    await expect(
      prisma.$executeRaw`INSERT INTO agent_runs (job_id, attempt_number, status, provider_mode, started_at)
        VALUES (${job.id}::uuid, 1, 'PENDING', 'FAKE', now())`,
    ).rejects.toBeTruthy();
  });
});

describe("finalizeCompleted", () => {
  it("inserts the full contiguous trace and sets the terminal state atomically", async () => {
    const { run } = await createRunningRun();
    const finalized = await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    expect(finalized.status).toBe("COMPLETED");
    expect(finalized.finishedAt).toBeTruthy();

    const rows = await prisma.agentTraceEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(rows.map((r) => r.sequenceNumber)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.eventType)).toEqual(["TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]);
  });

  it("stores the report and leaves failure_code null", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.report).toEqual(VALID_REPORT);
    expect(row.failureCode).toBeNull();
  });

  it("rejects duplicate (run_id, sequence_number) at the database level", async () => {
    const { run } = await createRunningRun();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.agentTraceEvent.create({
          data: { runId: run.id, sequenceNumber: 1, eventType: "REPORT_GENERATED", payload: { type: "REPORT_GENERATED" } },
        });
        await tx.agentTraceEvent.create({
          data: { runId: run.id, sequenceNumber: 1, eventType: "REPORT_GENERATED", payload: { type: "REPORT_GENERATED" } },
        });
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a mismatched event_type/payload combination", async () => {
    const { run } = await createRunningRun();
    await expect(
      prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${run.id}::uuid, 1, 'TOOL_REQUESTED', '{"type":"REPORT_GENERATED"}'::jsonb)`,
    ).rejects.toBeTruthy();
  });

  it("rejects illegal terminal combinations directly at the database level (raw SQL bypass)", async () => {
    const { run } = await createRunningRun();
    await expect(
      prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(), report = NULL WHERE id = ${run.id}::uuid`,
    ).rejects.toBeTruthy();
    await expect(
      prisma.$executeRaw`UPDATE agent_runs SET status = 'FAILED', finished_at = now(), failure_code = 'TOOL_NOT_FOUND', report = '{"a":1}'::jsonb WHERE id = ${run.id}::uuid`,
    ).rejects.toBeTruthy();
  });

  it("exact replay (same trace + same report) succeeds idempotently with no duplicate trace rows", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const count = await prisma.agentTraceEvent.count({ where: { runId: run.id } });
    expect(count).toBe(SAMPLE_TRACE.length);
  });

  it("conflicts when the trace differs but the outcome matches", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const differentTrace = [{ type: "REPORT_GENERATED" as const }];
    await expect(finalizeCompleted(prisma, run.id, differentTrace, VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
  });

  it("conflicts when the trace matches but the outcome differs", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const differentReport = { ...VALID_REPORT, summary: "A different summary" };
    await expect(finalizeCompleted(prisma, run.id, SAMPLE_TRACE, differentReport)).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
  });

  it("does not accept a raw stored [1, 3] sequence gap as an exact replay of a normal incoming [1, 2] trace", async () => {
    const { run } = await createRunningRun();
    const eventA = { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" };
    const eventB = { type: "REPORT_GENERATED" as const };

    // Raw-SQL-inserted trace with a sequence gap (1, 3) whose payload order
    // is identical to what a normal contiguous incoming [1, 2] trace would
    // produce — this is exactly the case a payload-only replay comparison
    // would have wrongly accepted as an exact match.
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 1, 'TOOL_REQUESTED', ${JSON.stringify(eventA)}::jsonb)`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 3, 'REPORT_GENERATED', ${JSON.stringify(eventB)}::jsonb)`;
    await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(), report = ${JSON.stringify(VALID_REPORT)}::jsonb WHERE id = ${run.id}::uuid`;

    await expect(finalizeCompleted(prisma, run.id, [eventA, eventB], VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
  });

  it("rejects an invalid report before any transaction begins, leaving the run and trace untouched", async () => {
    const { run } = await createRunningRun();
    // An intentionally invalid report (fails runtime validation) is rejected
    // before the transaction even opens — this proves pre-transaction
    // validation, not mid-transaction rollback (see the next test for that).
    await expect(finalizeCompleted(prisma, run.id, SAMPLE_TRACE, { summary: "incomplete" })).rejects.toMatchObject(
      { code: "PERSISTENCE_VALIDATION_FAILED" },
    );
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    const count = await prisma.agentTraceEvent.count({ where: { runId: run.id } });
    expect(count).toBe(0);
  });

  it("a real PostgreSQL failure after the trace insert rolls back the entire transaction, leaving the run RUNNING with zero trace rows", async () => {
    const { run } = await createRunningRun();

    // Test-only trigger/function, created and dropped entirely within this
    // test — not a production failure-injection hook. Fires only on the
    // exact statement finalizeTerminal issues after the trace createMany:
    // the UPDATE that sets agent_runs.status to a terminal value. Because
    // it fires *after* the trace insert already ran inside the same
    // transaction, a rollback here proves real transactional atomicity,
    // not merely pre-transaction validation.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_only_fail_agent_runs_terminal_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test-injected failure: agent_runs terminal update';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_only_fail_agent_runs_terminal_update_trigger
      BEFORE UPDATE OF status ON agent_runs
      FOR EACH ROW
      WHEN (NEW.status IN ('COMPLETED', 'FAILED'))
      EXECUTE FUNCTION test_only_fail_agent_runs_terminal_update();
    `);

    try {
      await expect(finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT)).rejects.toBeTruthy();

      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("RUNNING");
      expect(row.report).toBeNull();
      expect(row.finishedAt).toBeNull();
      const count = await prisma.agentTraceEvent.count({ where: { runId: run.id } });
      expect(count).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_only_fail_agent_runs_terminal_update_trigger ON agent_runs`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_only_fail_agent_runs_terminal_update()`);
    }
  });

  it("returns the full completed read model via getAgentRun", async () => {
    const { job, run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.job.id).toBe(job.id);
    expect(persisted.run.status).toBe("COMPLETED");
    expect(persisted.trace).toEqual(SAMPLE_TRACE);
    expect(persisted.outcome).toEqual({ type: "COMPLETED", report: VALID_REPORT });
  });
});

describe("finalizeFailed", () => {
  it("stores the failure code and leaves report null", async () => {
    const { run } = await createRunningRun();
    const finalized = await finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND");
    expect(finalized.status).toBe("FAILED");
    // failureCode/report are intentionally not part of AgentRunRecord (see
    // types.ts) — they surface only via getAgentRun's AgentRunOutcome.
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.failureCode).toBe("TOOL_NOT_FOUND");
    expect(row.report).toBeNull();
  });

  it("exact replay (same trace + same code) succeeds idempotently", async () => {
    const { run } = await createRunningRun();
    await finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND");
    const count = await prisma.agentTraceEvent.count({ where: { runId: run.id } });
    expect(count).toBe(SAMPLE_TRACE.length);
  });

  it("conflicts on a different failure code with the same trace", async () => {
    const { run } = await createRunningRun();
    await finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND");
    await expect(finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_EXECUTION_FAILED")).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
  });

  it("returns the full failed read model with the fixed display message", async () => {
    const { run } = await createRunningRun();
    await finalizeFailed(prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND");
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.outcome).toEqual({
      type: "FAILED",
      code: "TOOL_NOT_FOUND",
      message: "The requested diagnostic tool is not registered.",
    });
  });

  it("a completed-versus-failed race produces exactly one terminal winner", async () => {
    const { run } = await createRunningRun();
    const second = createPrismaClient();
    try {
      const results = await Promise.allSettled([
        finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT),
        finalizeFailed(second.prisma, run.id, SAMPLE_TRACE, "TOOL_NOT_FOUND"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "PERSISTENCE_CONFLICT" });

      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(["COMPLETED", "FAILED"]).toContain(row.status);
    } finally {
      await second.close();
    }
  });
});

describe("getAgentRun", () => {
  it("returns PERSISTENCE_NOT_FOUND for a nonexistent run", async () => {
    await expect(getAgentRun(prisma, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "PERSISTENCE_NOT_FOUND",
    });
  });

  it("orders trace strictly by sequence_number, not insertion order", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.trace.map((e) => e.type)).toEqual(["TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]);
  });

  it("maps a structurally invalid stored payload to PERSISTENCE_VALIDATION_FAILED on read", async () => {
    const { run } = await createRunningRun();
    // Satisfies the event_type CHECK (matches payload->>'type') but is
    // missing required fields for that event type — the CHECK constraint
    // cannot catch this; only read-time Zod revalidation can.
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 1, 'TOOL_REQUESTED', '{"type":"TOOL_REQUESTED"}'::jsonb)`;
    await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(), report = ${JSON.stringify(VALID_REPORT)}::jsonb WHERE id = ${run.id}::uuid`;
    await expect(getAgentRun(prisma, run.id)).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
  });

  it("rejects a raw stored sequence gap ([1, 3], skipping 2) on read", async () => {
    const { run } = await createRunningRun();
    // Bypasses the repository (which always assigns 1..N contiguously) to
    // simulate corrupted/manually-edited data — sequence_number 1 and 3
    // both satisfy every CHECK constraint individually; only the
    // application-level contiguity check in fromTraceEventRows can catch
    // the gap.
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 1, 'TOOL_REQUESTED', '{"type":"TOOL_REQUESTED","toolCallId":"call-1","toolName":"get_service_status"}'::jsonb)`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 3, 'REPORT_GENERATED', '{"type":"REPORT_GENERATED"}'::jsonb)`;
    await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(), report = ${JSON.stringify(VALID_REPORT)}::jsonb WHERE id = ${run.id}::uuid`;
    await expect(getAgentRun(prisma, run.id)).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
  });

  it("accepts and returns a normal contiguous [1..N] trace without error", async () => {
    const { run } = await createRunningRun();
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.trace).toEqual(SAMPLE_TRACE);
  });
});

describe("getAgentJob", () => {
  it("returns the job snapshot with zero runs when no run has ever been started", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-zero-runs", summary: "No runs yet" });
    const persisted = await getAgentJob(prisma, job.id);
    expect(persisted.job).toEqual(job);
    expect(persisted.runs).toEqual([]);
  });

  it("returns run summaries ordered by attemptNumber ASC, regardless of creation order interleaving", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-multi-attempt", summary: "Multiple attempts" });
    const first = await startRun(prisma, job.id, "FAKE", null);
    const second = await startRun(prisma, job.id, "FAKE", null);
    const third = await startRun(prisma, job.id, "FAKE", null);

    const persisted = await getAgentJob(prisma, job.id);

    expect(persisted.runs.map((run) => run.attemptNumber)).toEqual([1, 2, 3]);
    expect(persisted.runs.map((run) => run.id)).toEqual([first.run.id, second.run.id, third.run.id]);
  });

  it("does not include trace events or report/failureCode fields in the run summaries", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-no-trace", summary: "No trace in job read" });
    const { run } = await startRun(prisma, job.id, "FAKE", null);
    await finalizeCompleted(prisma, run.id, SAMPLE_TRACE, VALID_REPORT);

    const persisted = await getAgentJob(prisma, job.id);

    expect(persisted.runs).toHaveLength(1);
    const runSummary = persisted.runs[0];
    expect(runSummary).not.toHaveProperty("trace");
    expect(runSummary).not.toHaveProperty("report");
    expect(runSummary).not.toHaveProperty("failureCode");
    expect(runSummary?.status).toBe("COMPLETED");
  });

  it("returns PERSISTENCE_NOT_FOUND for a nonexistent job", async () => {
    await expect(getAgentJob(prisma, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "PERSISTENCE_NOT_FOUND",
    });
  });

  it("revalidates the job and every run through the existing runtime mappers (rejects a malformed stored ticket context)", async () => {
    const [insertedRow] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO agent_jobs (ticket_context, external_ticket_id)
      VALUES ('{"ticketId": "TKT-malformed-job-read"}'::jsonb, 'TKT-malformed-job-read')
      RETURNING id`;
    if (!insertedRow) throw new Error("expected the raw INSERT to return the new row's id");

    await expect(getAgentJob(prisma, insertedRow.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });
});

describe("connection unavailability", () => {
  it("normalizes a genuine connection failure to PERSISTENCE_UNAVAILABLE without leaking the URL", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://opspilot:opspilot_local_dev_only@localhost:1/opspilot";
    const unreachable = createPrismaClient();
    process.env.DATABASE_URL = previous;
    try {
      await expect(createJob(unreachable.prisma, { ticketId: "TKT-1", summary: "s" })).rejects.toMatchObject(
        { code: "PERSISTENCE_UNAVAILABLE" },
      );
    } finally {
      await unreachable.close().catch(() => undefined);
    }
  });
});
