import { AgentOrchestratorErrorCodeSchema } from "@opspilot/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "./client";
import { createJob, finalizeFailed, startRun } from "./repositories/agent-run-repository";
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

      const finalized = await finalizeFailed(
        prisma,
        started.run.id,
        [{ type: "REPORT_GENERATED" }],
        code,
      );
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
