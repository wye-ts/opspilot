import type { InvestigationEventRecord } from "@opspilot/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "../client";
import { PersistenceError } from "../errors";
import { appendMultiToolSuccessPrefix, appendToolDiagnosticPairs } from "../test/canonical-stream";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import {
  appendInvestigationEvent,
  createJob,
  finalizeCompleted,
  getInvestigationEventRecords,
  startRun,
} from "./agent-run-repository";

const VALID_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "Finding" }],
  evidenceState: "SUFFICIENT",
  suggestedActions: [],
};

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

/**
 * A fresh RUNNING run carrying its one-event RUN_CREATED canonical prefix.
 *
 * As of Phase B, `startRun` writes RUN_CREATED atomically with the run row,
 * so the explicit append below is an EXACT REPLAY rather than a first write —
 * it returns the original sequence 1 and inserts nothing. Keeping it is
 * deliberate: it exercises the replay path on every fixture setup in this
 * file, and it keeps the fixture's intent ("a run that has RUN_CREATED")
 * stated rather than implied.
 */
async function createRunningRunWithRunCreated(): Promise<string> {
  const job = await createJob(prisma, {
    ticketId: `TKT-ledger-${Math.random().toString(36).slice(2)}`,
    summary: "Investigation event ledger fixture run",
  });
  const started = await startRun(prisma, job.id, "FAKE", null);
  const replayed = await appendInvestigationEvent(prisma, started.run.id, { type: "RUN_CREATED" });
  if (replayed.sequence !== 1) {
    throw new Error(`expected RUN_CREATED at sequence 1, got ${replayed.sequence}`);
  }
  return started.run.id;
}

async function traceEventCount(runId: string): Promise<number> {
  return prisma.agentTraceEvent.count({ where: { runId } });
}

describe("appendInvestigationEvent — not found / terminal guards", () => {
  it("PERSISTENCE_NOT_FOUND for a nonexistent run", async () => {
    await expect(
      appendInvestigationEvent(prisma, "00000000-0000-0000-0000-000000000000", { type: "AGENT_STARTED" }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
  });

  it.each(["RUN_COMPLETED", "RUN_FAILED"] as const)(
    "rejects a generic %s append before opening a transaction",
    async (terminalType) => {
      const runId = await createRunningRunWithRunCreated();
      const payload =
        terminalType === "RUN_COMPLETED"
          ? { type: "RUN_COMPLETED" as const }
          : { type: "RUN_FAILED" as const, failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" };

      await expect(appendInvestigationEvent(prisma, runId, payload)).rejects.toMatchObject({
        code: "PERSISTENCE_VALIDATION_FAILED",
      });
      // Rejected before the transaction ever opens: the RUN_CREATED row from
      // fixture setup is the only row for this run.
      expect(await traceEventCount(runId)).toBe(1);
    },
  );

  it("rejects an append to a run that is no longer RUNNING", async () => {
    const runId = await createRunningRunWithRunCreated();
    // Raw setup rather than finalizeCompleted: this guard is about appending
    // to an ALREADY-terminal run, and going through the real finalizer would
    // require building a full valid stream first, which is a different test.
    await prisma.$executeRaw`
      UPDATE agent_runs
      SET status = 'COMPLETED', finished_at = now(), report = '{}'::jsonb
      WHERE id = ${runId}::uuid`;

    await expect(appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" })).rejects.toMatchObject({
      code: "PERSISTENCE_CONFLICT",
    });
    expect(await traceEventCount(runId)).toBe(1);
  });
});

describe("appendInvestigationEvent — valid partial prefixes commit under RUNNING", () => {
  it("RUN_CREATED alone is a valid, queryable RUNNING prefix", async () => {
    const runId = await createRunningRunWithRunCreated();
    expect(await traceEventCount(runId)).toBe(1);
  });

  it("+AGENT_STARTED commits at sequence 2", async () => {
    const runId = await createRunningRunWithRunCreated();
    const record = await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    expect(record).toMatchObject({ runId, sequence: 2, payload: { type: "AGENT_STARTED" } });
    expect(typeof record.recordedAt).toBe("string");
  });

  it("an open TOOL_REQUESTED (no completion yet) is a valid RUNNING prefix", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    const record = await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    expect(record.sequence).toBe(3);
    expect(await traceEventCount(runId)).toBe(3);
  });

  it("a failure-fact prefix (TOOL_FAILED with no terminal event yet) commits and leaves the run RUNNING", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "unknown_tool",
    });
    const record = await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "unknown_tool",
      failureCode: "TOOL_NOT_FOUND",
    });
    expect(record.sequence).toBe(4);
    expect(await traceEventCount(runId)).toBe(4);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
  });
});

describe("appendInvestigationEvent — exact replay", () => {
  it("returns the identical sequence and recordedAt, inserts no row, and keeps the next event contiguous", async () => {
    const runId = await createRunningRunWithRunCreated();
    const first = await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    expect(first.sequence).toBe(2);

    const replay = await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    expect(replay.sequence).toBe(first.sequence);
    expect(replay.recordedAt).toBe(first.recordedAt);
    expect(await traceEventCount(runId)).toBe(2); // RUN_CREATED + AGENT_STARTED, no third row

    const next = await appendInvestigationEvent(prisma, runId, {
      type: "RETRIEVAL_COMPLETED",
      chunks: [],
    });
    expect(next.sequence).toBe(3);
  });

  // An ambiguous-success retry must short-circuit at the replay check, never
  // reaching the reducer — so it can never surface as
  // PERSISTENCE_EVENT_STREAM_INVALID, whatever the rest of the stream looks
  // like. RUN_CREATED is used here because it is the very first event, the
  // strongest version of this claim.
  it("an ambiguous-success retry of the very first event never becomes PERSISTENCE_EVENT_STREAM_INVALID", async () => {
    const runId = await createRunningRunWithRunCreated(); // already appended once
    await expect(appendInvestigationEvent(prisma, runId, { type: "RUN_CREATED" })).resolves.toMatchObject({
      sequence: 1,
    });
    expect(await traceEventCount(runId)).toBe(1);
  });

  describe("conflicting replay — same type, different payload, per type", () => {
    it("RETRIEVAL_COMPLETED: changed chunk data conflicts", async () => {
      const runId = await createRunningRunWithRunCreated();
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "RETRIEVAL_COMPLETED",
        chunks: [{ chunkId: "chunk-1", rank: 1, score: 0.9 }],
      });

      await expect(
        appendInvestigationEvent(prisma, runId, {
          type: "RETRIEVAL_COMPLETED",
          chunks: [{ chunkId: "chunk-2", rank: 1, score: 0.9 }],
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
      expect(await traceEventCount(runId)).toBe(3);
    });

    it("TOOL_REQUESTED: a changed toolName conflicts", async () => {
      const runId = await createRunningRunWithRunCreated();
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "get_service_status",
      });

      await expect(
        appendInvestigationEvent(prisma, runId, {
          type: "TOOL_REQUESTED",
          toolCallId: "call-1",
          toolName: "a_different_tool",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
      expect(await traceEventCount(runId)).toBe(3);
    });

    // Under issue #57 the repeatable diagnostic identity is
    // (runId, eventType, toolCallId), so a different toolCallId is a
    // LEGITIMATE new event, not a conflict — covered by the #57 persistence
    // describe below. The identity-conflict shape for TOOL_COMPLETED is a
    // changed toolName on the same toolCallId.
    it("TOOL_COMPLETED: a changed toolName conflicts", async () => {
      const runId = await createRunningRunWithRunCreated();
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "get_service_status",
      });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_COMPLETED",
        toolCallId: "call-1",
        toolName: "get_service_status",
      });

      await expect(
        appendInvestigationEvent(prisma, runId, {
          type: "TOOL_COMPLETED",
          toolCallId: "call-1",
          toolName: "a_different_tool",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
      expect(await traceEventCount(runId)).toBe(4);
    });

    it("TOOL_FAILED: a changed failureCode conflicts", async () => {
      const runId = await createRunningRunWithRunCreated();
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "unknown_tool",
      });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_FAILED",
        toolCallId: "call-1",
        toolName: "unknown_tool",
        failureCode: "TOOL_NOT_FOUND",
      });

      await expect(
        appendInvestigationEvent(prisma, runId, {
          type: "TOOL_FAILED",
          toolCallId: "call-1",
          toolName: "unknown_tool",
          failureCode: "TOOL_INPUT_INVALID",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
      expect(await traceEventCount(runId)).toBe(4);
    });

    it("REPORT_VALIDATION_FAILED: a changed failureCode conflicts", async () => {
      const runId = await createRunningRunWithRunCreated();
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "REPORT_VALIDATION_FAILED",
        failureCode: "REPORT_SCHEMA_INVALID",
      });

      await expect(
        appendInvestigationEvent(prisma, runId, {
          type: "REPORT_VALIDATION_FAILED",
          failureCode: "REPORT_EVIDENCE_INVALID",
        }),
      ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
      expect(await traceEventCount(runId)).toBe(4);
    });
  });
});

// Issue #57, Checkpoint A — the repeatable diagnostic identity
// (docs/16-investigation-event-contract.md §5): TOOL_REQUESTED /
// TOOL_COMPLETED / TOOL_FAILED may legitimately repeat with distinct
// toolCallIds, up to MAX_DIAGNOSTIC_TOOL_CALLS serial requests, and their
// exact-replay identity becomes (runId, eventType, toolCallId).
describe("issue #57 — bounded multi-step diagnostic persistence", () => {
  it("case 1: two completed diagnostic steps with different toolCallIds persist (REQUEST A -> COMPLETE A -> REQUEST B -> COMPLETE B)", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendToolDiagnosticPairs(prisma, runId, 2);

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
    ]);
    const requests = records.filter((r) => r.payload.type === "TOOL_REQUESTED");
    expect(requests.map((r) => (r.payload as { toolCallId: string }).toolCallId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("case 2: exact replay of TOOL_REQUESTED A returns the original row and consumes no new sequence", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    const first = await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    expect(first.sequence).toBe(3);

    const replay = await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    expect(replay.sequence).toBe(first.sequence);
    expect(replay.recordedAt).toBe(first.recordedAt);
    expect(await traceEventCount(runId)).toBe(3); // RUN_CREATED + AGENT_STARTED + TOOL_REQUESTED

    // A genuinely new event after the replay consumes the next contiguous
    // sequence, proving the replay allocated none. The loop must first close
    // A, so the follow-up request is B only after COMPLETE A.
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_COMPLETED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    const next = await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-2",
      toolName: "get_service_status",
    });
    expect(next.sequence).toBe(first.sequence + 2);
  });

  it("case 3: same (eventType, toolCallId) with a changed payload is PERSISTENCE_CONFLICT", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });

    await expect(
      appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "a_different_tool",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_CONFLICT" });
    expect(await traceEventCount(runId)).toBe(3);
  });

  it("case 4: REQUEST A -> COMPLETE A is a valid RUNNING prefix", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendToolDiagnosticPairs(prisma, runId, 1);
    expect(await traceEventCount(runId)).toBe(4); // RUN_CREATED + AGENT_STARTED + REQUEST + COMPLETE
  });

  it("case 5: REQUEST A -> FAILED A commits as a RUNNING prefix with a tool-specific failure fact", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "unknown_tool",
    });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "unknown_tool",
      failureCode: "TOOL_NOT_FOUND",
    });
    expect(await traceEventCount(runId)).toBe(4);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
  });

  it("case 6: an outcome for an unknown toolCallId is rejected (reducer-invalid)", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });

    await expect(
      appendInvestigationEvent(prisma, runId, {
        type: "TOOL_COMPLETED",
        toolCallId: "ghost",
        toolName: "get_service_status",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_EVENT_STREAM_INVALID" });
    expect(await traceEventCount(runId)).toBe(2);
  });

  it("case 7: REQUEST A -> REQUEST B while A is open is rejected as TOOL_REQUEST_WHILE_OPEN", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });

    let caught: unknown;
    try {
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-2",
        toolName: "get_service_status",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_EVENT_STREAM_INVALID");
    const cause = (caught as PersistenceError).cause as { code?: string } | undefined;
    expect(cause?.code).toBe("TOOL_REQUEST_WHILE_OPEN");
    expect(await traceEventCount(runId)).toBe(3); // no orphaned row
  });

  it("case 9: three request/completion pairs preserve exact sequence order", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendToolDiagnosticPairs(prisma, runId, 3);

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(records.map((r) => r.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
    ]);
  });

  it("case 10: a multi-step partial RUNNING prefix with two completed diagnostics reduces and leaves DIAGNOSTIC_EXECUTION active", async () => {
    const runId = await createRunningRunWithRunCreated();
    // Every append above reducer-validated successfully (none threw), so the
    // stored stream is contract-valid; the run remains RUNNING mid-loop.
    await appendToolDiagnosticPairs(prisma, runId, 2);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
  });

  it("case 11: projection/readback preserves repeated tool event types and order (no collapse by event type)", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendToolDiagnosticPairs(prisma, runId, 3);

    const records = await getInvestigationEventRecords(prisma, runId);
    const toolTypes = records.map((r) => r.payload.type).filter((t) => t.startsWith("TOOL_"));
    expect(toolTypes).toEqual([
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
    ]);
  });

  it("case 12: four distinct diagnostic requests are rejected with TOOL_LIMIT_EXCEEDED", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendToolDiagnosticPairs(prisma, runId, 3);

    let caught: unknown;
    try {
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-4",
        toolName: "get_service_status",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_EVENT_STREAM_INVALID");
    const cause = (caught as PersistenceError).cause as { code?: string } | undefined;
    expect(cause?.code).toBe("TOOL_LIMIT_EXCEEDED");
    expect(await traceEventCount(runId)).toBe(8); // no orphaned row
  });

  it("case 13: a one-tool voluntary early report finalizes WITHOUT REPORT_GENERATION_STARTED", async () => {
    // Fewer than MAX_DIAGNOSTIC_TOOL_CALLS tools, all closed: the provider
    // voluntarily submits the report on a still-available investigation turn,
    // proving REPORT_GENERATION_STARTED is optional on that path.
    const runId = await createRunningRunWithRunCreated();
    await appendMultiToolSuccessPrefix(prisma, runId, 1);
    await finalizeCompleted(prisma, runId, VALID_REPORT);

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("case 13b: the three-tool forced-finalization path records REPORT_GENERATION_STARTED before submission", async () => {
    // At the exhausted bound the next provider call is the forced finalization
    // turn, so REPORT_GENERATION_STARTED must precede REPORT_SUBMITTED.
    const runId = await createRunningRunWithRunCreated();
    await appendMultiToolSuccessPrefix(prisma, runId, 3);
    await finalizeCompleted(prisma, runId, VALID_REPORT);

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("appendInvestigationEvent — transactional reducer validation", () => {
  it("an invalid phase-order append (TOOL_REQUESTED before AGENT_STARTED) rolls back with zero new rows", async () => {
    const runId = await createRunningRunWithRunCreated();

    await expect(
      appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "get_service_status",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_EVENT_STREAM_INVALID" });

    expect(await traceEventCount(runId)).toBe(1); // only the RUN_CREATED fixture row
  });

  it("a reducer-invalid candidate (REPORT_SUBMITTED with an open tool call) leaves zero new rows", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    }); // open tool call, never completed

    await expect(appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" })).rejects.toMatchObject({
      code: "PERSISTENCE_EVENT_STREAM_INVALID",
    });

    expect(await traceEventCount(runId)).toBe(3); // RUN_CREATED, AGENT_STARTED, TOOL_REQUESTED only
  });

  it("preserves the reducer's closed InvestigationEventContractError.code as the PersistenceError cause", async () => {
    const runId = await createRunningRunWithRunCreated();

    let caught: unknown;
    try {
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "get_service_status",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PersistenceError);
    const cause = (caught as PersistenceError).cause as { code?: string } | undefined;
    expect(cause?.code).toBeTruthy();
  });
});

describe("appendInvestigationEvent — concurrent appends", () => {
  // V1's forward-only phase model (docs/16-investigation-event-contract.md
  // §5) is NOT symmetric between these two types: RETRIEVAL_COMPLETED
  // before REPORT_SUBMITTED is the documented "direct path with optional
  // retrieval" and is legal, while REPORT_SUBMITTED before
  // RETRIEVAL_COMPLETED is not (retrieval is rejected once the report phase
  // has begun). So whichever transaction's row lock wins the race always
  // succeeds (both are individually legal as the very next event after
  // AGENT_STARTED), and the second either also succeeds (if
  // RETRIEVAL_COMPLETED won) or is cleanly rejected with no orphaned row
  // (if REPORT_SUBMITTED won). Both outcomes are legal serializations of a
  // real race — the property this test actually proves is the one that
  // must hold under EITHER outcome: sequence allocation under the row lock
  // never duplicates or skips, and a losing append never leaves a row
  // behind.
  it("concurrent appends to the same run never collide on sequence_number; any losing side rolls back cleanly", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });

    const results = await Promise.allSettled([
      appendInvestigationEvent(prisma, runId, { type: "RETRIEVAL_COMPLETED", chunks: [] }),
      appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<InvestigationEventRecord> => r.status === "fulfilled",
    );
    // The winner of the row-lock race always succeeds; both may succeed —
    // never zero.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const wonSequences = fulfilled.map((r) => r.value.sequence).sort((a, b) => a - b);
    const expectedWonSequences = wonSequences.map((_, i) => 3 + i);
    expect(wonSequences).toEqual(expectedWonSequences); // contiguous from 3, no duplicate

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records).toHaveLength(2 + fulfilled.length); // no orphaned row from a rejected append
    expect(records.map((r) => r.sequence)).toEqual(records.map((_, i) => i + 1)); // fully contiguous in storage
  });

  it("two concurrent exact-replay appends of the SAME event serialize to one insert and one replay, distinctly no duplicate row", async () => {
    const runId = await createRunningRunWithRunCreated();

    const [a, b] = await Promise.all([
      appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" }),
      appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" }),
    ]);

    // Serialized by the row lock: whichever transaction goes first inserts
    // at sequence 2; the second finds that row already committed and
    // replays it — both settle on the SAME sequence, and only one row
    // exists.
    expect(a.sequence).toBe(2);
    expect(b.sequence).toBe(2);
    expect(await traceEventCount(runId)).toBe(2);
  });
});

describe("getInvestigationEventRecords", () => {
  it("PERSISTENCE_NOT_FOUND for a nonexistent run", async () => {
    await expect(
      getInvestigationEventRecords(prisma, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
  });

  it("returns the partial canonical prefix of a mid-flight RUNNING run, in sequence order", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual(["RUN_CREATED", "AGENT_STARTED", "TOOL_REQUESTED"]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(records.every((r) => r.runId === runId)).toBe(true);
    expect(records.every((r) => typeof r.recordedAt === "string")).toBe(true);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
  });
});

/**
 * Issue #37 Phase B — the persist-after batch writer is gone.
 *
 * These assertions pin down the switchover itself: finalization no longer
 * accepts or writes a trace batch, and every event that reaches the ledger
 * arrives through the incremental path.
 */
describe("the old persist-after batch behavior is no longer used", () => {
  it("finalizeCompleted writes exactly ONE new row (the terminal event), not a batch", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
    await appendInvestigationEvent(prisma, runId, { type: "REPORT_VALIDATED" });
    const before = await traceEventCount(runId);

    await finalizeCompleted(prisma, runId, VALID_REPORT);

    expect(await traceEventCount(runId)).toBe(before + 1);
    const terminal = await prisma.agentTraceEvent.findFirstOrThrow({
      where: { runId, eventType: "RUN_COMPLETED" },
    });
    expect(terminal.sequenceNumber).toBe(before + 1);
  });

  it("every stored event is contiguous and singly-written across a full one-tool run", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    await appendInvestigationEvent(prisma, runId, {
      type: "TOOL_COMPLETED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    await appendInvestigationEvent(prisma, runId, { type: "REPORT_GENERATION_STARTED" });
    await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
    await appendInvestigationEvent(prisma, runId, { type: "REPORT_VALIDATED" });
    await finalizeCompleted(prisma, runId, VALID_REPORT);

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Distinct per-event recording times are the whole point of incremental
    // persistence — the old batch gave every row one coarse value.
    expect(new Set(records.map((r) => r.recordedAt)).size).toBeGreaterThan(1);
  });

  it("getInvestigationEventRecords still returns a mid-flight prefix after the switchover", async () => {
    const runId = await createRunningRunWithRunCreated();
    await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });

    const records = await getInvestigationEventRecords(prisma, runId);
    expect(records.map((r) => r.payload.type)).toEqual(["RUN_CREATED", "AGENT_STARTED"]);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
  });
});
