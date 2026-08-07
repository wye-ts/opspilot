import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { PersistenceError } from "../errors";
import {
  appendInvestigationEvent,
  createJob,
  finalizeCompleted,
  finalizeFailed,
  getAgentJob,
  getAgentRun,
  startRun,
} from "../repositories/agent-run-repository";
import {
  appendDirectSuccessPrefix,
  appendFailurePrefix,
  appendOneToolSuccessPrefix,
} from "../test/canonical-stream";
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
  const createdJob = await createJob(prisma, { ticketId: "TKT-1", summary: "Repository fixture run" });
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

  it("commits RUN_CREATED at sequence 1 in the same transaction as the run row", async () => {
    const { run } = await createRunningRun();
    const rows = await prisma.agentTraceEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sequenceNumber).toBe(1);
    expect(rows[0]?.eventType).toBe("RUN_CREATED");
    expect(rows[0]?.payload).toEqual({ type: "RUN_CREATED" });
    // recordedAt is the database's own created_at — never an application clock.
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  // Atomicity in the other direction: if the canonical event cannot be
  // written, the run must not exist either.
  it("rolls the run insert back when the RUN_CREATED insert fails", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-atomic", summary: "Run creation atomicity" });
    const runsBefore = await prisma.agentRun.count({ where: { jobId: job.id } });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_only_fail_run_created_event()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test-injected failure: RUN_CREATED insert';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_only_fail_run_created_event_trigger
      BEFORE INSERT ON agent_trace_events
      FOR EACH ROW
      WHEN (NEW.event_type = 'RUN_CREATED')
      EXECUTE FUNCTION test_only_fail_run_created_event();
    `);

    try {
      await expect(startRun(prisma, job.id, "FAKE", null)).rejects.toBeTruthy();
      expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(runsBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_only_fail_run_created_event_trigger ON agent_trace_events`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_only_fail_run_created_event()`);
    }
  });

  it("allocates unique, increasing attempt numbers for concurrent starts on the same job", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-concurrent", summary: "Concurrent fixture run" });
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

  it("rolls back and returns PERSISTENCE_VALIDATION_FAILED when the locked job row fails StoredTicketContextSchema, inserting no AgentRun", async () => {
    // Passes every CHECK constraint (jsonb_typeof is 'object'; external_ticket_id
    // equals ticket_context->>'ticketId' and is non-empty) but is missing the
    // required `summary` field — only StoredTicketContextSchema's runtime
    // validation catches this. Not a weakening of any production
    // constraint: this row simply cannot be produced by createJob/the
    // mapper, only by a raw SQL insert bypassing them, as here.
    //
    // A row with a SHORT summary is deliberately NOT a failure here: the read
    // path accepts what was legal when it was written (see
    // StoredTicketContextSchema). Only a structurally malformed row fails.
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
    const job = await createJob(prisma, { ticketId: "TKT-pending", summary: "Pending fixture run" });
    await expect(
      prisma.$executeRaw`INSERT INTO agent_runs (job_id, attempt_number, status, provider_mode, started_at)
        VALUES (${job.id}::uuid, 1, 'PENDING', 'FAKE', now())`,
    ).rejects.toBeTruthy();
  });
});

describe("finalizeCompleted", () => {
  it("appends RUN_COMPLETED and sets the terminal state atomically", async () => {
    const { run } = await createRunningRun();
    await appendOneToolSuccessPrefix(prisma, run.id);

    const finalized = await finalizeCompleted(prisma, run.id, VALID_REPORT);
    expect(finalized.status).toBe("COMPLETED");
    expect(finalized.finishedAt).toBeTruthy();

    const rows = await prisma.agentTraceEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequenceNumber: "asc" },
    });
    // RUN_CREATED was written with the run itself; the terminal event is the
    // last contiguous sequence. Nothing is batch-inserted at finalization
    // any more — every preceding event was already durable.
    expect(rows.map((r) => r.sequenceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.map((r) => r.eventType)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
  });

  it("commits a valid DIRECT (no-tool) success stream", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);

    const finalized = await finalizeCompleted(prisma, run.id, VALID_REPORT);
    expect(finalized.status).toBe("COMPLETED");

    const rows = await prisma.agentTraceEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(rows.map((r) => r.eventType)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
  });

  it("stores the report and leaves failure_code null", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.report).toEqual(VALID_REPORT);
    expect(row.failureCode).toBeNull();
  });

  // THE REDUCER GATE, in production: a run whose canonical stream does not
  // actually justify completion cannot be marked COMPLETED, and the refusal
  // leaves both the event and the status untouched.
  it("rejects a reducer-invalid terminal stream and rolls back the terminal event", async () => {
    const { run } = await createRunningRun();
    // RUN_CREATED only — no AGENT_STARTED / REPORT_SUBMITTED / REPORT_VALIDATED,
    // so strict completion is not satisfied.
    await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_EVENT_STREAM_INVALID",
    });

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    expect(row.report).toBeNull();
    expect(row.finishedAt).toBeNull();
    const count = await prisma.agentTraceEvent.count({ where: { runId: run.id } });
    expect(count).toBe(1); // RUN_CREATED only — no RUN_COMPLETED row left behind
  });

  it("rejects duplicate (run_id, sequence_number) at the database level", async () => {
    const { run } = await createRunningRun();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.agentTraceEvent.create({
          data: { runId: run.id, sequenceNumber: 9, eventType: "REPORT_GENERATED", payload: { type: "REPORT_GENERATED" } },
        });
        await tx.agentTraceEvent.create({
          data: { runId: run.id, sequenceNumber: 9, eventType: "REPORT_GENERATED", payload: { type: "REPORT_GENERATED" } },
        });
      }),
    ).rejects.toBeTruthy();
  });

  it("rejects a mismatched event_type/payload combination", async () => {
    const { run } = await createRunningRun();
    await expect(
      prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${run.id}::uuid, 2, 'TOOL_REQUESTED', '{"type":"REPORT_GENERATED"}'::jsonb)`,
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

  it("exact replay (same report) succeeds idempotently with no duplicate terminal event", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const afterFirst = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);

    expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(afterFirst);
  });

  it("conflicts when the stored terminal event matches but the report differs", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const differentReport = { ...VALID_REPORT, summary: "A different summary" };
    await expect(finalizeCompleted(prisma, run.id, differentReport)).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
  });

  // Corruption, not a replay decision: the terminal event and the terminal
  // status commit together, so observing one without the other means
  // something wrote outside this repository.
  it("rejects a RUNNING run that already carries a terminal event, without repairing it", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 5, 'RUN_COMPLETED', '{"type":"RUN_COMPLETED"}'::jsonb)`;

    await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_EVENT_STREAM_INVALID",
    });

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING"); // not promoted
    const terminalRows = await prisma.agentTraceEvent.count({
      where: { runId: run.id, eventType: "RUN_COMPLETED" },
    });
    expect(terminalRows).toBe(1); // no second terminal event inserted
  });

  it("rejects a terminal status carrying no terminal event", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(),
      report = ${JSON.stringify(VALID_REPORT)}::jsonb WHERE id = ${run.id}::uuid`;

    await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_EVENT_STREAM_INVALID",
    });
  });

  it("rejects a run carrying BOTH terminal events", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 5, 'RUN_COMPLETED', '{"type":"RUN_COMPLETED"}'::jsonb)`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${run.id}::uuid, 6, 'RUN_FAILED', '{"type":"RUN_FAILED","failureCode":"TOOL_NOT_FOUND","failedStage":"DIAGNOSTIC_EXECUTION"}'::jsonb)`;
    await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(),
      report = ${JSON.stringify(VALID_REPORT)}::jsonb WHERE id = ${run.id}::uuid`;

    await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toMatchObject({
      code: "PERSISTENCE_EVENT_STREAM_INVALID",
    });
  });

  // Codex Phase B review, finding M1: a terminal status whose SOLE stored
  // terminal event names the OPPOSITE outcome is stored-data corruption, not
  // an ordinary competing finalization request. This must be detected before
  // the incoming request is ever classified as a normal conflict — so both
  // the matching-outcome and opposite-outcome incoming requests must reject
  // identically, as PERSISTENCE_EVENT_STREAM_INVALID, never PERSISTENCE_CONFLICT.
  describe("stored status/terminal-event corruption (finding M1)", () => {
    async function createCorruptedTerminalRun(
      storedStatus: "COMPLETED" | "FAILED",
      storedEventType: "RUN_COMPLETED" | "RUN_FAILED",
    ) {
      const { run } = await createRunningRun();
      await appendDirectSuccessPrefix(prisma, run.id);
      const eventPayload =
        storedEventType === "RUN_COMPLETED"
          ? { type: "RUN_COMPLETED" }
          : { type: "RUN_FAILED", failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" };
      await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${run.id}::uuid, 5, ${storedEventType}, ${JSON.stringify(eventPayload)}::jsonb)`;
      if (storedStatus === "COMPLETED") {
        await prisma.$executeRaw`UPDATE agent_runs SET status = 'COMPLETED', finished_at = now(),
          report = ${JSON.stringify(VALID_REPORT)}::jsonb, failure_code = NULL WHERE id = ${run.id}::uuid`;
      } else {
        await prisma.$executeRaw`UPDATE agent_runs SET status = 'FAILED', finished_at = now(),
          report = NULL, failure_code = 'TOOL_NOT_FOUND' WHERE id = ${run.id}::uuid`;
      }
      return run.id;
    }

    it("stored COMPLETED + only RUN_FAILED, incoming finalizeCompleted -> PERSISTENCE_EVENT_STREAM_INVALID", async () => {
      const runId = await createCorruptedTerminalRun("COMPLETED", "RUN_FAILED");
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
      const eventCountBefore = await prisma.agentTraceEvent.count({ where: { runId } });

      await expect(finalizeCompleted(prisma, runId, VALID_REPORT)).rejects.toMatchObject({
        code: "PERSISTENCE_EVENT_STREAM_INVALID",
      });

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
      expect(after).toEqual(before); // no row/status/outcome modified
      expect(await prisma.agentTraceEvent.count({ where: { runId } })).toBe(eventCountBefore); // no second event
    });

    it("stored COMPLETED + only RUN_FAILED, incoming finalizeFailed -> PERSISTENCE_EVENT_STREAM_INVALID, not CONFLICT", async () => {
      const runId = await createCorruptedTerminalRun("COMPLETED", "RUN_FAILED");
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

      // Even though the incoming outcome matches the STORED EVENT, it must
      // still be rejected as corruption: the stored STATUS disagrees with
      // that same stored event, and stored-state integrity is checked first.
      await expect(
        finalizeFailed(prisma, runId, "TOOL_NOT_FOUND", "DIAGNOSTIC_EXECUTION"),
      ).rejects.toMatchObject({ code: "PERSISTENCE_EVENT_STREAM_INVALID" });

      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toEqual(before);
    });

    it("stored FAILED + only RUN_COMPLETED, incoming finalizeFailed -> PERSISTENCE_EVENT_STREAM_INVALID", async () => {
      const runId = await createCorruptedTerminalRun("FAILED", "RUN_COMPLETED");
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
      const eventCountBefore = await prisma.agentTraceEvent.count({ where: { runId } });

      await expect(
        finalizeFailed(prisma, runId, "TOOL_NOT_FOUND", "DIAGNOSTIC_EXECUTION"),
      ).rejects.toMatchObject({ code: "PERSISTENCE_EVENT_STREAM_INVALID" });

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
      expect(after).toEqual(before);
      expect(await prisma.agentTraceEvent.count({ where: { runId } })).toBe(eventCountBefore);
    });

    it("stored FAILED + only RUN_COMPLETED, incoming finalizeCompleted -> PERSISTENCE_EVENT_STREAM_INVALID, not CONFLICT", async () => {
      const runId = await createCorruptedTerminalRun("FAILED", "RUN_COMPLETED");
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

      await expect(finalizeCompleted(prisma, runId, VALID_REPORT)).rejects.toMatchObject({
        code: "PERSISTENCE_EVENT_STREAM_INVALID",
      });

      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toEqual(before);
    });

    it("healthy COMPLETED + incoming finalizeFailed -> ordinary PERSISTENCE_CONFLICT (regression: not over-classified as corruption)", async () => {
      const { run } = await createRunningRun();
      await appendDirectSuccessPrefix(prisma, run.id);
      await finalizeCompleted(prisma, run.id, VALID_REPORT);
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      const eventCountBefore = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

      await expect(
        finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", "DIAGNOSTIC_EXECUTION"),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after).toEqual(before);
      expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(eventCountBefore);
    });

    it("healthy FAILED + incoming finalizeCompleted -> ordinary PERSISTENCE_CONFLICT (regression: not over-classified as corruption)", async () => {
      const { run } = await createRunningRun();
      const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
      await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
      const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      const eventCountBefore = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

      await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toMatchObject({
        code: "PERSISTENCE_CONFLICT",
      });

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after).toEqual(before);
      expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(eventCountBefore);
    });
  });

  it("rejects an invalid report before any transaction begins, leaving the run and trace untouched", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    const before = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

    // An intentionally invalid report (fails runtime validation) is rejected
    // before the transaction even opens — this proves pre-transaction
    // validation, not mid-transaction rollback (see the next test for that).
    await expect(finalizeCompleted(prisma, run.id, { summary: "incomplete" })).rejects.toMatchObject(
      { code: "PERSISTENCE_VALIDATION_FAILED" },
    );
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
    expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(before);
  });

  it("a real PostgreSQL failure on the terminal update rolls back the terminal event too", async () => {
    const { run } = await createRunningRun();
    await appendDirectSuccessPrefix(prisma, run.id);
    const before = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

    // Test-only trigger/function, created and dropped entirely within this
    // test — not a production failure-injection hook. Fires only on the
    // exact statement finalizeTerminal issues after the terminal event
    // insert: the UPDATE that sets agent_runs.status to a terminal value.
    // Because it fires *after* that insert already ran inside the same
    // transaction, a rollback here proves real transactional atomicity of the
    // terminal event and the status update together.
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
      await expect(finalizeCompleted(prisma, run.id, VALID_REPORT)).rejects.toBeTruthy();

      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("RUNNING");
      expect(row.report).toBeNull();
      expect(row.finishedAt).toBeNull();
      // The RUN_COMPLETED insert rolled back with the failed UPDATE.
      expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(before);
      expect(
        await prisma.agentTraceEvent.count({ where: { runId: run.id, eventType: "RUN_COMPLETED" } }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_only_fail_agent_runs_terminal_update_trigger ON agent_runs`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_only_fail_agent_runs_terminal_update()`);
    }
  });

  it("returns the full completed read model via getAgentRun, projected to the legacy trace union", async () => {
    const { job, run } = await createRunningRun();
    await appendOneToolSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.job.id).toBe(job.id);
    expect(persisted.run.status).toBe("COMPLETED");
    // Lifecycle-only events stay hidden; REPORT_VALIDATED surfaces under its
    // long-standing legacy name. The visible shape is unchanged from before #37.
    expect(persisted.trace).toEqual(SAMPLE_TRACE);
    expect(persisted.outcome).toEqual({ type: "COMPLETED", report: VALID_REPORT });
  });
});

describe("finalizeFailed", () => {
  it("stores the failure code and leaves report null", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    const finalized = await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
    expect(finalized.status).toBe("FAILED");
    // failureCode/report are intentionally not part of AgentRunRecord (see
    // types.ts) — they surface only via getAgentRun's AgentRunOutcome.
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.failureCode).toBe("TOOL_NOT_FOUND");
    expect(row.report).toBeNull();
  });

  it("persists RUN_FAILED carrying the exact failedStage the caller supplied", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    expect(failedStage).toBe("DIAGNOSTIC_EXECUTION");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);

    const terminalRow = await prisma.agentTraceEvent.findFirstOrThrow({
      where: { runId: run.id, eventType: "RUN_FAILED" },
    });
    expect(terminalRow.payload).toEqual({
      type: "RUN_FAILED",
      failureCode: "TOOL_NOT_FOUND",
      failedStage: "DIAGNOSTIC_EXECUTION",
    });
  });

  it("commits the pre-agent RETRIEVAL_PARAMS_INVALID exception stream (RUN_CREATED -> RUN_FAILED)", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "RETRIEVAL_PARAMS_INVALID");
    const finalized = await finalizeFailed(prisma, run.id, "RETRIEVAL_PARAMS_INVALID", failedStage);
    expect(finalized.status).toBe("FAILED");

    const rows = await prisma.agentTraceEvent.findMany({
      where: { runId: run.id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(rows.map((r) => r.eventType)).toEqual(["RUN_CREATED", "RUN_FAILED"]);
  });

  it("rejects a failedStage the stored stream does not support", async () => {
    const { run } = await createRunningRun();
    await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    // The stream shows DIAGNOSTIC_EXECUTION failing; claiming REPORT_GENERATION
    // would invent a phase the run never reached.
    await expect(
      finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", "REPORT_GENERATION"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_EVENT_STREAM_INVALID" });

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
  });

  it("exact replay (same code + same failedStage) succeeds idempotently", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
    const afterFirst = await prisma.agentTraceEvent.count({ where: { runId: run.id } });

    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);

    expect(await prisma.agentTraceEvent.count({ where: { runId: run.id } })).toBe(afterFirst);
  });

  it("conflicts on a different failure code", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
    await expect(
      finalizeFailed(prisma, run.id, "TOOL_EXECUTION_FAILED", failedStage),
    ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
  });

  it("conflicts on a replay that names a different failedStage", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
    // Same code, different stage — the stored terminal payload disagrees, so
    // the shared exact-replay helper refuses it.
    await expect(
      finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", "AGENT_ANALYSIS"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
  });

  it("returns the full failed read model with the fixed display message", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.outcome).toEqual({
      type: "FAILED",
      code: "TOOL_NOT_FOUND",
      message: "The requested diagnostic tool is not registered.",
    });
  });

  // The intentional, documented content divergence from pre-#37 behavior
  // (docs/reviews/21-...md §7): canonical persistence records TOOL_REQUESTED
  // before registry lookup, so the projected legacy trace now includes it —
  // while TOOL_FAILED itself stays hidden.
  it("projects TOOL_REQUESTED (but not TOOL_FAILED) for an early tool failure", async () => {
    const { run } = await createRunningRun();
    const failedStage = await appendFailurePrefix(prisma, run.id, "TOOL_NOT_FOUND");
    await finalizeFailed(prisma, run.id, "TOOL_NOT_FOUND", failedStage);

    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it("a completed-versus-failed race produces exactly one terminal winner", async () => {
    const { run } = await createRunningRun();
    // A prefix that legitimately supports EITHER outcome: the report was
    // submitted and validated (so completion is legal), and a provider
    // failure during REPORT_GENERATION is also legal at this point.
    await appendDirectSuccessPrefix(prisma, run.id);

    const second = createPrismaClient();
    try {
      const results = await Promise.allSettled([
        finalizeCompleted(prisma, run.id, VALID_REPORT),
        finalizeFailed(second.prisma, run.id, "PROVIDER_UNAVAILABLE", "REPORT_GENERATION"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(["COMPLETED", "FAILED"]).toContain(row.status);

      // Exactly one terminal event exists, matching the winning status.
      const terminalRows = await prisma.agentTraceEvent.findMany({
        where: { runId: run.id, eventType: { in: ["RUN_COMPLETED", "RUN_FAILED"] } },
      });
      expect(terminalRows).toHaveLength(1);
      expect(terminalRows[0]?.eventType).toBe(row.status === "COMPLETED" ? "RUN_COMPLETED" : "RUN_FAILED");
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
    await appendOneToolSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.trace.map((e) => e.type)).toEqual(["TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]);
  });

  it("returns a RUNNING run's PARTIAL projected trace mid-flight", async () => {
    const { run } = await createRunningRun();
    await appendInvestigationEvent(prisma, run.id, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });

    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.outcome).toEqual({ type: "RUNNING" });
    // The point of #37: a run is queryable before it terminates. Lifecycle-only
    // events stay hidden, so only the tool request surfaces.
    expect(persisted.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it("maps a structurally invalid stored payload to PERSISTENCE_VALIDATION_FAILED on read", async () => {
    const { run } = await createRunningRun();
    await prisma.$executeRaw`DELETE FROM agent_trace_events WHERE run_id = ${run.id}::uuid`;
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
    await prisma.$executeRaw`DELETE FROM agent_trace_events WHERE run_id = ${run.id}::uuid`;
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
    await appendOneToolSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);
    const persisted = await getAgentRun(prisma, run.id);
    expect(persisted.trace).toEqual(SAMPLE_TRACE);
  });
});

describe("getAgentJob", () => {
  it("returns the job snapshot with zero runs when no run has ever been started", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-zero-runs", summary: "No runs started yet" });
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
    await appendDirectSuccessPrefix(prisma, run.id);
    await finalizeCompleted(prisma, run.id, VALID_REPORT);

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
      await expect(createJob(unreachable.prisma, { ticketId: "TKT-1", summary: "Unreachable fixture run" })).rejects.toMatchObject(
        { code: "PERSISTENCE_UNAVAILABLE" },
      );
    } finally {
      await unreachable.close().catch(() => undefined);
    }
  });
});
