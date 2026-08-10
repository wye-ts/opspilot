import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient, PrismaClientHandle } from "../client";
import { createJob, startLiveRunWithAttemptLimit } from "./agent-run-repository";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import type { LiveRunBudgetReservationInput, PublicTrialReservationInput } from "../types";

/**
 * The durable per-visitor half of the PUBLIC trial's daily gate (issue #39):
 * `live_run_visitor_usage` is insert-only, keyed on `(visitor_id, usage_date)`,
 * and its primary key IS the one-per-visitor-per-day limit — there is no
 * counter column and no `visitorDailyLimit` to configure. These tests drive
 * the real repository transaction against PostgreSQL, not a mocked read.
 *
 * Generous overall/public budget ceilings throughout, so the visitor gate is
 * always the thing under test — never a coincidental overall-count refusal.
 */

const CEILING = 1_000_000_000n; // $1.00

function budget(budgetDate: string): LiveRunBudgetReservationInput {
  return { budgetDate, dailyLimit: 100, costCeilingNanoUsd: CEILING };
}

function trial(visitorId: string): PublicTrialReservationInput {
  return { visitorId, publicDailyLimit: 5, publicCostCeilingNanoUsd: CEILING };
}

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
  await prisma.$executeRaw`DELETE FROM live_run_budget`;
  await prisma.$executeRaw`DELETE FROM live_run_visitor_usage`;
});

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `Visitor usage coverage for ${ticketId}` });
}

describe("live_run_visitor_usage — insert-only per-visitor daily gate", () => {
  it("reserves the first PUBLIC run for a visitor on a given UTC day", async () => {
    const visitorId = randomUUID();
    const job = await newJob("TKT-visitor-first");

    const result = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget("2026-08-01"),
      clientRequestId: randomUUID(),
      publicTrial: trial(visitorId),
    });

    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") throw new Error("unreachable");
    expect(result.reservation.isPublic).toBe(true);

    const [row] = await prisma.$queryRaw<{ visitorId: string }[]>`
      SELECT visitor_id AS "visitorId" FROM live_run_visitor_usage
      WHERE visitor_id = ${visitorId}::uuid AND usage_date = '2026-08-01'::date`;
    expect(row?.visitorId).toBe(visitorId);
  });

  it("rejects a second PUBLIC reservation for the same visitor on the same UTC day", async () => {
    const visitorId = randomUUID();
    const jobA = await newJob("TKT-visitor-repeat-a");
    const jobB = await newJob("TKT-visitor-repeat-b");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: jobA.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget("2026-08-01"),
      clientRequestId: randomUUID(),
      publicTrial: trial(visitorId),
    });

    // A DIFFERENT job — proving the gate is keyed on the visitor, not the job
    // (see docs/reviews/23-issue-39-public-live-trial-plan.md §8): a new job
    // cannot be used to sidestep an already-used daily trial.
    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: jobB.id,
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget("2026-08-01"),
        clientRequestId: randomUUID(),
        publicTrial: trial(visitorId),
      }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_VISITOR_QUOTA_EXHAUSTED" });

    // No second AgentRun was created for the refused job.
    expect(await prisma.agentRun.count({ where: { jobId: jobB.id } })).toBe(0);
    // And the row itself was never touched a second time — still exactly one
    // row for this visitor on this day.
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM live_run_visitor_usage
      WHERE visitor_id = ${visitorId}::uuid`;
    expect(rows[0]?.count).toBe(1n);
  });

  it("reserves again for the same visitor on a new UTC day", async () => {
    const visitorId = randomUUID();
    const jobA = await newJob("TKT-visitor-newday-a");
    const jobB = await newJob("TKT-visitor-newday-b");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: jobA.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget("2026-08-01"),
      clientRequestId: randomUUID(),
      publicTrial: trial(visitorId),
    });

    const second = await startLiveRunWithAttemptLimit(prisma, {
      jobId: jobB.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget("2026-08-02"),
      clientRequestId: randomUUID(),
      publicTrial: trial(visitorId),
    });

    expect(second.outcome).toBe("started");

    const rows = await prisma.$queryRaw<{ usageDate: Date }[]>`
      SELECT usage_date AS "usageDate" FROM live_run_visitor_usage
      WHERE visitor_id = ${visitorId}::uuid ORDER BY usage_date ASC`;
    expect(rows).toHaveLength(2);
  });

  it("leaves the private token LIVE path untouched — no visitor row at all", async () => {
    const job = await newJob("TKT-visitor-private");

    const result = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget("2026-08-01"),
      clientRequestId: randomUUID(),
    });

    expect(result.outcome).toBe("started");
    if (result.outcome !== "started") throw new Error("unreachable");
    expect(result.reservation.isPublic).toBe(false);

    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM live_run_visitor_usage`;
    expect(rows[0]?.count).toBe(0n);
  });
});
