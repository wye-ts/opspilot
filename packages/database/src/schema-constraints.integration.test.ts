import { AgentOrchestratorErrorCodeSchema } from "@opspilot/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "./client";
import { createJob, finalizeFailed, getAgentRun, startRun } from "./repositories/agent-run-repository";
import { appendFailurePrefix } from "./test/canonical-stream";
import { createTestPrismaClient, truncateAllTables } from "./test/test-db";

// The 13-member InvestigationEventRecordPayloadSchema vocabulary
// (@opspilot/contracts): the 12 canonical write-eligible types, in the
// order this migration's CHECK constraint lists them, plus the one legacy
// read-only type. Hardcoded here (mirroring EXPECTED_CHECK_CONSTRAINT_NAMES'
// own style above) rather than derived from the Zod discriminated union at
// runtime, so this test does not depend on internal Zod literal-extraction
// APIs that can change between versions.
const EXPECTED_CANONICAL_EVENT_TYPES = [
  "RUN_CREATED",
  "AGENT_STARTED",
  "RETRIEVAL_COMPLETED",
  "TOOL_REQUESTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "REPORT_GENERATION_STARTED",
  "REPORT_SUBMITTED",
  "REPORT_VALIDATED",
  "REPORT_VALIDATION_FAILED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "REPORT_GENERATED",
] as const;

// A minimal, DB-CHECK-satisfying payload for each of the 13 types — only
// what agent_trace_events_event_type_matches_chk ("event_type" =
// "payload"->>'type'") and agent_trace_events_payload_is_object_chk (an
// object) require. Full application-level shape validation
// (InvestigationEventPayloadSchema) is covered separately by
// mappers.test.ts and is deliberately NOT what these DB-constraint tests
// are proving.
const SAMPLE_CANONICAL_PAYLOADS: Record<(typeof EXPECTED_CANONICAL_EVENT_TYPES)[number], object> = {
  RUN_CREATED: { type: "RUN_CREATED" },
  AGENT_STARTED: { type: "AGENT_STARTED" },
  RETRIEVAL_COMPLETED: { type: "RETRIEVAL_COMPLETED", chunks: [] },
  TOOL_REQUESTED: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
  TOOL_COMPLETED: { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
  TOOL_FAILED: {
    type: "TOOL_FAILED",
    toolCallId: "call-1",
    toolName: "get_service_status",
    failureCode: "TOOL_NOT_FOUND",
  },
  REPORT_GENERATION_STARTED: { type: "REPORT_GENERATION_STARTED" },
  REPORT_SUBMITTED: { type: "REPORT_SUBMITTED" },
  REPORT_VALIDATED: { type: "REPORT_VALIDATED" },
  REPORT_VALIDATION_FAILED: { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
  RUN_COMPLETED: { type: "RUN_COMPLETED" },
  RUN_FAILED: { type: "RUN_FAILED", failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" },
  REPORT_GENERATED: { type: "REPORT_GENERATED" },
};

// The authoritative check that every hand-authored CHECK constraint from the
// migration still exists — `prisma migrate diff` (db:migrate:drift) cannot
// see these at all, since Prisma's schema DSL does not model CHECK
// constraints (see docs/11-agent-run-persistence.md).
const EXPECTED_CHECK_CONSTRAINT_NAMES = [
  "agent_jobs_ticket_context_is_object_chk",
  "agent_jobs_external_ticket_id_matches_chk",
  "agent_runs_attempt_number_chk",
  "agent_runs_status_chk",
  "agent_runs_provider_mode_chk",
  "agent_runs_report_is_object_chk",
  "agent_runs_failure_code_chk",
  "agent_runs_terminal_outcome_chk",
  "agent_runs_usage_non_negative_chk",
  "agent_runs_pricing_status_chk",
  "agent_trace_events_sequence_number_chk",
  "agent_trace_events_payload_is_object_chk",
  "agent_trace_events_event_type_chk",
  "agent_trace_events_event_type_matches_chk",
  "agent_run_approvals_decision_chk",
  "agent_run_approvals_reviewer_name_not_blank_chk",
  "live_run_budget_runs_reserved_chk",
  "live_run_budget_runs_completed_chk",
  "live_run_budget_estimated_cost_nano_usd_chk",
  "live_run_budget_pricing_unknown_runs_chk",
  "live_run_budget_completed_within_reserved_chk",
  "live_run_budget_public_runs_reserved_chk",
  "live_run_budget_public_cost_nano_usd_chk",
  "live_run_budget_public_within_overall_chk",
] as const;

let handle: PrismaClientHandle;
let prisma: PrismaClient;

/**
 * A RUNNING run with an EMPTY event ledger.
 *
 * `startRun` now writes RUN_CREATED at sequence 1 (issue #37 Phase B), but
 * these tests exercise raw database constraints rather than lifecycle
 * behavior — they insert their own rows by hand, starting at sequence 1, and
 * one of them deliberately inserts a RUN_CREATED of its own. Clearing the
 * auto-written row keeps each test in full control of the ledger it is
 * asserting about, instead of having to work around a fixture row.
 */
async function createRunningRunId(): Promise<string> {
  const job = await createJob(prisma, {
    ticketId: `TKT-canonical-${Math.random().toString(36).slice(2)}`,
    summary: "Canonical event-type CHECK constraint fixture run",
  });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await prisma.$executeRaw`DELETE FROM agent_trace_events WHERE run_id = ${started.run.id}::uuid`;
  return started.run.id;
}

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

describe("named CHECK constraints", () => {
  it("all 21 approved constraints exist by exact name", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE contype = 'c'`;
    const names = new Set(rows.map((r) => r.conname));
    for (const expected of EXPECTED_CHECK_CONSTRAINT_NAMES) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("has no unexpected extra application-authored CHECK constraint", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND (conname LIKE 'agent_%' OR conname LIKE 'live_run_%')`;
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual([...EXPECTED_CHECK_CONSTRAINT_NAMES].sort());
  });
});

/**
 * Constraint NAMES existing is not the same as constraint CONTENTS being
 * correct, and the difference has already cost this schema a real defect: PR 6B1
 * added PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_CANCELLED to
 * AgentOrchestratorErrorCodeSchema so a live-provider failure could finalize as
 * FAILED, but left agent_runs_failure_code_chk listing only the original ten —
 * so every one of those writes would have been rejected by the database and the
 * run orphaned RUNNING anyway. The name-existence test above passed throughout.
 *
 * These tests compare the enum against the constraint's actual expression, which
 * is the only thing that can catch that class of drift.
 */
describe("CHECK constraint value lists match their TypeScript enums", () => {
  async function constraintValues(constraintName: string): Promise<string[]> {
    const [row] = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname = ${constraintName}`;
    if (!row) throw new Error(`constraint ${constraintName} not found`);

    // Every value in these constraints is a single-quoted SQL literal.
    return [...row.definition.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
  }

  it("agent_runs_failure_code_chk lists exactly AgentOrchestratorErrorCodeSchema's values", async () => {
    const expected = [...AgentOrchestratorErrorCodeSchema.options].sort();

    expect(await constraintValues("agent_runs_failure_code_chk")).toEqual(expected);
  });

  it("accepts every failure code the orchestrator can actually produce", async () => {
    // The end-to-end proof: each code is written through the real repository
    // path. A missing value in the CHECK fails here as a constraint violation.
    //
    // The persisted row is read back directly rather than asserted on
    // finalizeFailed's return value, because AgentRunRecord deliberately
    // excludes failure_code (it is part of AgentRunOutcome, not the summary).
    for (const code of AgentOrchestratorErrorCodeSchema.options) {
      const job = await createJob(prisma, {
        ticketId: `TKT-code-${code}`,
        summary: `Failure code coverage for ${code}`,
      });
      const started = await startRun(prisma, job.id, "LIVE", "claude-sonnet-5");

      // Each code needs the canonical prefix the runtime would really have
      // produced before failing that way — terminal finalization now
      // reducer-validates the whole stream before it will write the status.
      const failedStage = await appendFailurePrefix(prisma, started.run.id, code);
      const finalized = await finalizeFailed(prisma, started.run.id, code, failedStage);
      expect(finalized.status).toBe("FAILED");

      const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
      expect(row.failureCode).toBe(code);
    }
  });

  it("agent_runs_pricing_status_chk lists exactly the four pricing statuses", async () => {
    // Mirrors @opspilot/provider-claude's PricingStatus. Declared literally
    // here rather than imported, because packages/database must not depend on
    // the provider package (module-boundary.test.ts enforces that).
    expect(await constraintValues("agent_runs_pricing_status_chk")).toEqual(
      ["CURRENT", "INSUFFICIENT_USAGE_DETAIL", "STALE", "UNKNOWN_MODEL"].sort(),
    );
  });

  it("agent_runs_provider_mode_chk lists exactly the two provider modes", async () => {
    expect(await constraintValues("agent_runs_provider_mode_chk")).toEqual(["FAKE", "LIVE"]);
  });
});

describe("agent_run_approvals raw constraint violations", () => {
  async function createAnyRun() {
    const job = await createJob(prisma, { ticketId: "TKT-constraint-1", summary: "Constraint fixture run" });
    const started = await startRun(prisma, job.id, "FAKE", null);
    return started.run.id;
  }

  it("rejects a decision outside APPROVED/REJECTED (agent_run_approvals_decision_chk)", async () => {
    const runId = await createAnyRun();
    await expect(
      prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
        VALUES (${runId}::uuid, 'MAYBE', 'jacky')`,
    ).rejects.toBeTruthy();
  });

  it("rejects a blank reviewer_name (agent_run_approvals_reviewer_name_not_blank_chk)", async () => {
    const runId = await createAnyRun();
    await expect(
      prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
        VALUES (${runId}::uuid, 'APPROVED', '')`,
    ).rejects.toBeTruthy();
  });

  it("rejects a second row for the same run_id (agent_run_approvals_run_id_key unique index)", async () => {
    const runId = await createAnyRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${runId}::uuid, 'APPROVED', 'jacky')`;
    await expect(
      prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
        VALUES (${runId}::uuid, 'REJECTED', 'someone-else')`,
    ).rejects.toBeTruthy();
  });

  it("rejects an insert referencing a nonexistent run_id (agent_run_approvals_run_id_fkey)", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
        VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'APPROVED', 'jacky')`,
    ).rejects.toBeTruthy();
  });

  it("cascades: deleting the parent AgentRun deletes its agent_run_approvals row", async () => {
    const runId = await createAnyRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${runId}::uuid, 'APPROVED', 'jacky')`;
    const before = await prisma.agentRunApproval.count({ where: { runId } });
    expect(before).toBe(1);

    await prisma.$executeRaw`DELETE FROM agent_runs WHERE id = ${runId}::uuid`;

    const after = await prisma.agentRunApproval.count({ where: { runId } });
    expect(after).toBe(0);
  });
});

// Issue #37, Phase A — the widened agent_trace_events_event_type_chk and the
// new all-12 partial unique index
// (docs/reviews/21-issue-37-incremental-event-persistence-plan.md §3).
describe("agent_trace_events_event_type_chk — widened for the canonical lifecycle", () => {
  it("lists exactly the 13 InvestigationEventRecordPayloadSchema types", async () => {
    async function constraintValues(constraintName: string): Promise<string[]> {
      const [row] = await prisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname = ${constraintName}`;
      if (!row) throw new Error(`constraint ${constraintName} not found`);
      return [...row.definition.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
    }

    expect(await constraintValues("agent_trace_events_event_type_chk")).toEqual(
      [...EXPECTED_CANONICAL_EVENT_TYPES].sort(),
    );
  });

  it("accepts a row for every one of the 13 types on one run, each satisfying event_type_matches_chk", async () => {
    const runId = await createRunningRunId();

    for (const [index, eventType] of EXPECTED_CANONICAL_EVENT_TYPES.entries()) {
      await expect(
        prisma.$executeRaw`
          INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
          VALUES (
            ${runId}::uuid,
            ${index + 1},
            ${eventType},
            ${JSON.stringify(SAMPLE_CANONICAL_PAYLOADS[eventType])}::jsonb
          )`,
      ).resolves.toBeTruthy();
    }

    const count = await prisma.agentTraceEvent.count({ where: { runId } });
    expect(count).toBe(EXPECTED_CANONICAL_EVENT_TYPES.length);
  });

  it("rejects an event_type outside the 13-member vocabulary", async () => {
    const runId = await createRunningRunId();

    await expect(
      prisma.$executeRaw`
        INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${runId}::uuid, 1, 'NOT_A_REAL_EVENT_TYPE', '{"type":"NOT_A_REAL_EVENT_TYPE"}'::jsonb)`,
    ).rejects.toBeTruthy();
  });

  it("rejects event_type/payload.type mismatch even when both are individually legal (event_type_matches_chk)", async () => {
    const runId = await createRunningRunId();

    await expect(
      prisma.$executeRaw`
        INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (
          ${runId}::uuid, 1, 'TOOL_REQUESTED',
          '{"type":"TOOL_COMPLETED","toolCallId":"call-1","toolName":"get_service_status"}'::jsonb
        )`,
    ).rejects.toBeTruthy();
  });
});

describe("agent_trace_events_run_id_canonical_event_type_key — all-12 partial unique index", () => {
  it("exists by exact name", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'agent_trace_events_run_id_canonical_event_type_key'`;
    expect(rows).toHaveLength(1);
  });

  it("rejects a raw duplicate canonical event type for the same run", async () => {
    const runId = await createRunningRunId();

    await prisma.$executeRaw`
      INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${runId}::uuid, 1, 'AGENT_STARTED', '{"type":"AGENT_STARTED"}'::jsonb)`;

    await expect(
      prisma.$executeRaw`
        INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${runId}::uuid, 2, 'AGENT_STARTED', '{"type":"AGENT_STARTED"}'::jsonb)`,
    ).rejects.toBeTruthy();
  });

  it("does not constrain the legacy REPORT_GENERATED type (excluded from the partial index)", async () => {
    const runId = await createRunningRunId();

    await prisma.$executeRaw`
      INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${runId}::uuid, 1, 'REPORT_GENERATED', '{"type":"REPORT_GENERATED"}'::jsonb)`;

    // A second REPORT_GENERATED row for the same run is not rejected by this
    // index — it is excluded from the WHERE clause entirely, since it is
    // legacy read-only and this migration is only about the 12 canonical
    // write-eligible types.
    await expect(
      prisma.$executeRaw`
        INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
        VALUES (${runId}::uuid, 2, 'REPORT_GENERATED', '{"type":"REPORT_GENERATED"}'::jsonb)`,
    ).resolves.toBeTruthy();
  });
});

describe("historical legacy rows remain readable after the switchover", () => {
  // Pre-#37 runs were written by the old persist-after batch and carry NO
  // RUN_CREATED marker. They must keep reading back verbatim through the
  // legacy branch of fromTraceEventRows — the canonical projection must not
  // touch them.
  it("a raw historical 4-type legacy trace still reads back unchanged", async () => {
    const job = await createJob(prisma, { ticketId: "TKT-legacy-historical", summary: "Legacy read path" });
    const started = await startRun(prisma, job.id, "FAKE", null);

    // Simulate a pre-#37 row set exactly: no RUN_CREATED, contiguous from 1.
    await prisma.$executeRaw`DELETE FROM agent_trace_events WHERE run_id = ${started.run.id}::uuid`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${started.run.id}::uuid, 1, 'TOOL_REQUESTED',
              '{"type":"TOOL_REQUESTED","toolCallId":"call-1","toolName":"get_service_status"}'::jsonb)`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${started.run.id}::uuid, 2, 'TOOL_COMPLETED',
              '{"type":"TOOL_COMPLETED","toolCallId":"call-1","toolName":"get_service_status"}'::jsonb)`;
    await prisma.$executeRaw`INSERT INTO agent_trace_events (run_id, sequence_number, event_type, payload)
      VALUES (${started.run.id}::uuid, 3, 'REPORT_GENERATED', '{"type":"REPORT_GENERATED"}'::jsonb)`;

    const persisted = await getAgentRun(prisma, started.run.id);
    expect(persisted.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });
});
