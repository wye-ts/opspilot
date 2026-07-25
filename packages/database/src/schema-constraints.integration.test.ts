import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "./client";
import { createJob, startRun } from "./repositories/agent-run-repository";
import { createTestPrismaClient, truncateAllTables } from "./test/test-db";

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
  "agent_trace_events_sequence_number_chk",
  "agent_trace_events_payload_is_object_chk",
  "agent_trace_events_event_type_chk",
  "agent_trace_events_event_type_matches_chk",
  "agent_run_approvals_decision_chk",
  "agent_run_approvals_reviewer_name_not_blank_chk",
] as const;

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

describe("named CHECK constraints", () => {
  it("all 14 approved constraints exist by exact name", async () => {
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
      WHERE contype = 'c' AND conname LIKE 'agent_%'`;
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual([...EXPECTED_CHECK_CONSTRAINT_NAMES].sort());
  });
});

describe("agent_run_approvals raw constraint violations", () => {
  async function createAnyRun() {
    const job = await createJob(prisma, { ticketId: "TKT-constraint-1", summary: "s" });
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
