import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "./client";
import { createTestPrismaClient } from "./test/test-db";

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

describe("named CHECK constraints", () => {
  it("all 12 approved constraints exist by exact name", async () => {
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
