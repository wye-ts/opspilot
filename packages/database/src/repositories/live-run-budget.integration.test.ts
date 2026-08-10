import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { LiveRunAdmissionError } from "../live-run-errors";
import {
  createJob,
  currentBudgetDate,
  finalizeCompleted,
  finalizeFailed,
  getAgentRun,
  isLiveRunBudgetOpen,
  reconcileLiveRunBudget,
  startLiveRunWithAttemptLimit as startLiveRunKeyed,
  startRun,
} from "./agent-run-repository";
import { appendDirectSuccessPrefix, appendFailurePrefix } from "../test/canonical-stream";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import type {
  LiveRunBudgetReservationInput,
  RunProviderUsageWrite,
  StartedLiveRun,
} from "../types";

/**
 * The keyed transaction, with a FRESH client key per call.
 *
 * Every test below that calls this twice means "two separate requests" — the
 * attempt limit, the budget gate, the latch. Reusing one key across those calls
 * would make the second an idempotent REPLAY and quietly turn assertions about
 * limits into assertions about nothing. Generating a key per call keeps each of
 * those tests testing what it always tested.
 *
 * It also NARROWS to StartedLiveRun and throws otherwise, which is what keeps
 * `started.reservation` typed. A replay reaching here would mean a key was
 * accidentally shared, and failing loudly is better than a confusing type error
 * sixty call sites away. The replay path has its own tests, which call
 * `startLiveRunKeyed` directly with a deliberately repeated key.
 */
async function startLiveRunWithAttemptLimit(
  client: PrismaClient,
  params: Omit<Parameters<typeof startLiveRunKeyed>[1], "clientRequestId"> & {
    readonly clientRequestId?: string;
  },
): Promise<StartedLiveRun> {
  const result = await startLiveRunKeyed(client, { clientRequestId: randomUUID(), ...params });
  if (result.outcome !== "started") {
    throw new Error("expected a started run — a replay here means a client key was reused");
  }
  return result;
}

const BUDGET_DATE = "2026-07-29";
const CEILING = 1_000_000_000n; // $1.00


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

function budget(overrides: Partial<LiveRunBudgetReservationInput> = {}): LiveRunBudgetReservationInput {
  return { budgetDate: BUDGET_DATE, dailyLimit: 10, costCeilingNanoUsd: CEILING, ...overrides };
}

function usage(overrides: Partial<RunProviderUsageWrite> = {}): RunProviderUsageWrite {
  return {
    providerCallsObserved: 2,
    inputTokens: 1_200,
    outputTokens: 400,
    estimatedCostNanoUsd: 17_956_000n,
    pricingStatus: "CURRENT",
    possibleUnobservedCost: false,
    ...overrides,
  };
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
});

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `Live budget coverage for ${ticketId}` });
}

/**
 * One COMPLETE live-run lifecycle: reserve, then reconcile.
 *
 * Sequential reservations on a single day must go through this, because an
 * unreconciled reservation now latches the day closed (see the
 * runs_completed = runs_reserved condition in startLiveRunWithAttemptLimit).
 * Calling startLiveRunWithAttemptLimit twice in a row without reconciling is no
 * longer a shortcut for "two runs happened" — it is the failure mode the latch
 * exists to catch, and it has its own tests below.
 */
async function reserveAndReconcile(
  params: Parameters<typeof startLiveRunWithAttemptLimit>[1],
  usageOverrides: Partial<RunProviderUsageWrite> = {},
) {
  const started = await startLiveRunWithAttemptLimit(prisma, params);
  await reconcileLiveRunBudget(prisma, started.reservation, usage(usageOverrides));
  return started;
}

async function budgetRow(date = BUDGET_DATE) {
  const [row] = await prisma.$queryRaw<
    {
      runsReserved: number;
      runsCompleted: number;
      estimatedCostNanoUsd: bigint;
      pricingUnknownRuns: number;
    }[]
  >`
    SELECT runs_reserved AS "runsReserved", runs_completed AS "runsCompleted",
           estimated_cost_nano_usd AS "estimatedCostNanoUsd",
           pricing_unknown_runs AS "pricingUnknownRuns"
    FROM live_run_budget WHERE budget_date = ${date}::date`;
  return row;
}

describe("startLiveRunWithAttemptLimit — happy path", () => {
  it("creates a LIVE run and reserves one unit of the day's budget", async () => {
    const job = await newJob("TKT-live-1");

    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 2,
      budget: budget(),
    });

    expect(started.run.providerMode).toBe("LIVE");
    expect(started.run.status).toBe("RUNNING");
    expect(started.run.modelIdentifier).toBe("claude-sonnet-5");
    expect(started.run.attemptNumber).toBe(1);
    expect(started.reservation).toEqual({ budgetDate: BUDGET_DATE, runsReserved: 1, isPublic: false });
    expect(started.job.id).toBe(job.id);
  });

  it("returns the budget date as the stored calendar day, whatever the process timezone", async () => {
    // The driver returns a DATE at UTC midnight; the reservation echoes back the
    // committed day so reconciliation cannot key off a shifted date.
    const job = await newJob("TKT-live-date");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    expect(started.reservation.budgetDate).toBe("2026-07-29");
  });

  it("increments the same day's row across successive reconciled runs", async () => {
    for (const ticketId of ["TKT-a", "TKT-b", "TKT-c"]) {
      const job = await newJob(ticketId);
      await reserveAndReconcile({
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget(),
      });
    }

    const row = await budgetRow();
    expect(row?.runsReserved).toBe(3);
    // The counters stay level, which is what keeps the day open.
    expect(row?.runsCompleted).toBe(3);
  });

  it("starts a fresh row for a new UTC date rather than carrying the old one forward", async () => {
    const job = await newJob("TKT-rollover");
    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: budget({ budgetDate: "2026-07-29" }),
    });
    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: budget({ budgetDate: "2026-07-30" }),
    });

    expect((await budgetRow("2026-07-29"))?.runsReserved).toBe(1);
    expect((await budgetRow("2026-07-30"))?.runsReserved).toBe(1);
  });

  it("allocates attempt_number across FAKE and LIVE runs alike", async () => {
    // attempt_number is the run's ordinal within the job; the attempt LIMIT
    // counts only LIVE rows. The two numbers legitimately differ.
    const job = await newJob("TKT-mixed");
    await startRun(prisma, job.id, "FAKE", null);
    await startRun(prisma, job.id, "FAKE", null);

    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    expect(started.run.attemptNumber).toBe(3);
  });
});

describe("startLiveRunWithAttemptLimit — per-job attempt limit", () => {
  it("rejects once the job has reached its live attempt limit", async () => {
    const job = await newJob("TKT-attempts");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    };

    await reserveAndReconcile(params);
    await reserveAndReconcile(params);

    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toMatchObject({
      code: "LIVE_RUN_ATTEMPT_LIMIT",
    });
  });

  it("consumes no budget reservation when the attempt limit rejects", async () => {
    // The whole reason the check lives inside the transaction: a rejected
    // attempt must not burn a unit of the day's allowance.
    const job = await newJob("TKT-attempts-nobudget");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 1, budget: budget() };

    await startLiveRunWithAttemptLimit(prisma, params);
    expect((await budgetRow())?.runsReserved).toBe(1);

    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toBeInstanceOf(
      LiveRunAdmissionError,
    );

    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("creates no AgentRun row when the attempt limit rejects", async () => {
    const job = await newJob("TKT-attempts-norun");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 1, budget: budget() };

    await startLiveRunWithAttemptLimit(prisma, params);
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toBeTruthy();

    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("does not count FAKE runs toward the live attempt limit", async () => {
    const job = await newJob("TKT-fake-dont-count");
    await startRun(prisma, job.id, "FAKE", null);
    await startRun(prisma, job.id, "FAKE", null);
    await startRun(prisma, job.id, "FAKE", null);

    // With a limit of 2, three prior FAKE runs must not have consumed anything.
    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget(),
      }),
    ).resolves.toMatchObject({ run: { providerMode: "LIVE" } });
  });

  it("counts attempts per job, not globally", async () => {
    const first = await newJob("TKT-scope-1");
    const second = await newJob("TKT-scope-2");
    const params = { modelIdentifier: null, maxLiveAttempts: 1, budget: budget() };

    await reserveAndReconcile({ ...params, jobId: first.id });

    // A different job has its own allowance.
    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, jobId: second.id }),
    ).resolves.toBeTruthy();
  });
});

describe("startLiveRunWithAttemptLimit — missing job", () => {
  it("rejects a nonexistent job with PERSISTENCE_NOT_FOUND", async () => {
    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: "00000000-0000-0000-0000-000000000000",
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget(),
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
  });

  it("consumes no reservation for a nonexistent job", async () => {
    // Otherwise the day's allowance could be drained by requests naming jobs
    // that do not exist — a trivially cheap way to take the demo offline.
    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: "00000000-0000-0000-0000-000000000000",
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget(),
      }),
    ).rejects.toBeTruthy();

    expect(await budgetRow()).toBeUndefined();
  });
});

describe("startLiveRunWithAttemptLimit — daily budget gate", () => {
  it("rejects once the daily run limit is reached", async () => {
    const job = await newJob("TKT-daily");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 10, budget: budget({ dailyLimit: 2 }) };

    await reserveAndReconcile(params);
    await reserveAndReconcile(params);

    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toMatchObject({
      code: "LIVE_RUN_BUDGET_EXHAUSTED",
    });
  });

  it("creates no AgentRun row when the budget gate rejects", async () => {
    const job = await newJob("TKT-daily-norun");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 10, budget: budget({ dailyLimit: 1 }) };

    await startLiveRunWithAttemptLimit(prisma, params);
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toBeTruthy();

    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(1);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("rejects once the accumulated cost has crossed the ceiling", async () => {
    const job = await newJob("TKT-cost-gate");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ costCeilingNanoUsd: 20_000_000n }),
    };

    const started = await startLiveRunWithAttemptLimit(prisma, params);
    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(prisma, started.run.id, VALID_REPORT, usage());
    await reconcileLiveRunBudget(prisma, started.reservation, usage());

    // 17,956,000 nanoUSD is under the 20,000,000 ceiling, so the next run is
    // still allowed...
    const second = await startLiveRunWithAttemptLimit(prisma, params);
    await appendDirectSuccessPrefix(prisma, second.run.id);
    await finalizeCompleted(prisma, second.run.id, VALID_REPORT, usage());
    await reconcileLiveRunBudget(prisma, second.reservation, usage());

    // ...but 35,912,000 is over it, so the third is refused. This is exactly the
    // "post-run accounting can be exceeded by one bounded run" property.
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toMatchObject({
      code: "LIVE_RUN_BUDGET_EXHAUSTED",
    });
  });

  it("closes the cost gate for the rest of the day after one unmeasurable run", async () => {
    // An unknown cost is never treated as a known $0.
    const job = await newJob("TKT-unknown-cost");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 10, budget: budget() };

    const started = await startLiveRunWithAttemptLimit(prisma, params);
    const unknown = usage({ estimatedCostNanoUsd: null, pricingStatus: "UNKNOWN_MODEL" });
    const stage_2706 = await appendFailurePrefix(prisma, started.run.id, "PROVIDER_UNAVAILABLE");
    await finalizeFailed(prisma, started.run.id, "PROVIDER_UNAVAILABLE", stage_2706, unknown);
    await reconcileLiveRunBudget(prisma, started.reservation, unknown);

    expect((await budgetRow())?.pricingUnknownRuns).toBe(1);
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toMatchObject({
      code: "LIVE_RUN_BUDGET_EXHAUSTED",
    });
  });

  it("closes the cost gate after a run whose cost may not have been observed", async () => {
    const job = await newJob("TKT-unobserved");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 10, budget: budget() };

    const started = await startLiveRunWithAttemptLimit(prisma, params);
    const unobserved = usage({ possibleUnobservedCost: true });
    const stage_2398 = await appendFailurePrefix(prisma, started.run.id, "PROVIDER_TIMEOUT");
    await finalizeFailed(prisma, started.run.id, "PROVIDER_TIMEOUT", stage_2398, unobserved);
    await reconcileLiveRunBudget(prisma, started.reservation, unobserved);

    const row = await budgetRow();
    expect(row?.pricingUnknownRuns).toBe(1);
    // Cost contribution is zero, not the possibly-partial observed figure.
    expect(row?.estimatedCostNanoUsd).toBe(0n);
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toBeTruthy();
  });

  it("does not let a different day's exhaustion close today", async () => {
    const job = await newJob("TKT-day-isolation");
    const yesterday = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 10, budget: budget({ budgetDate: "2026-07-28", dailyLimit: 1 }) };

    await startLiveRunWithAttemptLimit(prisma, yesterday);
    await expect(startLiveRunWithAttemptLimit(prisma, yesterday)).rejects.toBeTruthy();

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 10,
        budget: budget({ budgetDate: "2026-07-29", dailyLimit: 1 }),
      }),
    ).resolves.toBeTruthy();
  });
});

/**
 * Issue #39 — internal rejection classification, all six reasons plus the
 * precedence case, forced DIRECTLY against `startLiveRunWithAttemptLimit`
 * rather than through HTTP.
 *
 * This is the layer where every reason is deterministically reachable. The
 * PRE-EXISTING #19 advisory pre-check (`isLiveRunBudgetOpen`, run by
 * live-run-admission.ts before the authoritative transaction) mirrors the
 * four SHARED conditions below and would intercept a serial HTTP test before
 * the authoritative transaction's own classification ever ran for them — see
 * apps/api/test/live-run-public-budget-latch.postgres.integration.test.ts,
 * which covers the two PUBLIC-specific reasons the advisory check cannot
 * pre-empt, end to end through the real server.
 */
describe("startLiveRunWithAttemptLimit — internal rejection classification (issue #39)", () => {
  function publicTrial(overrides: { readonly dailyLimit?: number; readonly costCeilingNanoUsd?: bigint } = {}) {
    return {
      visitorId: randomUUID(),
      publicDailyLimit: overrides.dailyLimit ?? 5,
      publicCostCeilingNanoUsd: overrides.costCeilingNanoUsd ?? 500_000_000n,
    };
  }

  it("BUDGET_LATCH_UNRECONCILED — an outstanding reservation, PUBLIC or private", async () => {
    const job = await newJob("TKT-reason-latch");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50 }),
    };

    // Left unreconciled on purpose.
    await startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial() });

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial() }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_LATCH_UNRECONCILED" });
  });

  it("BUDGET_PRICING_UNKNOWN — an unreconciled cost closes the gate for the rest of the day", async () => {
    const job = await newJob("TKT-reason-pricing-unknown");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50 }),
    };

    const started = await startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial() });
    await reconcileLiveRunBudget(
      prisma,
      started.reservation,
      usage({ estimatedCostNanoUsd: null, pricingStatus: "UNKNOWN_MODEL" }),
    );

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial() }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_PRICING_UNKNOWN" });
  });

  it("BUDGET_OVERALL_COUNT_EXHAUSTED — the overall count, with the public sub-limit still open", async () => {
    const job = await newJob("TKT-reason-overall-count");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 1 }),
    };

    await reserveAndReconcile({ ...params, publicTrial: publicTrial({ dailyLimit: 50 }) });

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial({ dailyLimit: 50 }) }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_OVERALL_COUNT_EXHAUSTED" });
  });

  it("BUDGET_OVERALL_COST_EXHAUSTED — the overall ceiling, with the public ceiling still open", async () => {
    const job = await newJob("TKT-reason-overall-cost");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50, costCeilingNanoUsd: 20_000_000n }),
    };

    await reserveAndReconcile(
      { ...params, publicTrial: publicTrial({ costCeilingNanoUsd: 5_000_000_000n }) },
      { estimatedCostNanoUsd: 35_912_000n },
    );

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        ...params,
        publicTrial: publicTrial({ costCeilingNanoUsd: 5_000_000_000n }),
      }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_OVERALL_COST_EXHAUSTED" });
  });

  it("BUDGET_PUBLIC_COUNT_EXHAUSTED — the public sub-limit alone, overall count still open", async () => {
    const job = await newJob("TKT-reason-public-count");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50 }),
    };

    await reserveAndReconcile({ ...params, publicTrial: publicTrial({ dailyLimit: 1 }) });

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial({ dailyLimit: 1 }) }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_PUBLIC_COUNT_EXHAUSTED" });
  });

  it("BUDGET_PUBLIC_COST_EXHAUSTED — the public ceiling alone, overall ceiling still open", async () => {
    const job = await newJob("TKT-reason-public-cost");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50, costCeilingNanoUsd: 5_000_000_000n }),
    };

    await reserveAndReconcile(
      { ...params, publicTrial: publicTrial({ costCeilingNanoUsd: 20_000_000n }) },
      { estimatedCostNanoUsd: 35_912_000n },
    );

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        ...params,
        publicTrial: publicTrial({ costCeilingNanoUsd: 20_000_000n }),
      }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_PUBLIC_COST_EXHAUSTED" });
  });

  it("resolves precedence when the OVERALL count and the PUBLIC count are simultaneously exhausted — overall wins", async () => {
    const job = await newJob("TKT-reason-precedence-count");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      // Both limits are 1: a single reconciled PUBLIC reservation exhausts
      // the overall count AND the public count in the same instant.
      budget: budget({ dailyLimit: 1 }),
    };

    await reserveAndReconcile({ ...params, publicTrial: publicTrial({ dailyLimit: 1 }) });

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial({ dailyLimit: 1 }) }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_OVERALL_COUNT_EXHAUSTED" });
  });

  it("resolves precedence when the LATCH and the PUBLIC count are simultaneously true — the latch wins", async () => {
    const job = await newJob("TKT-reason-precedence-latch");
    const params = {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 10,
      budget: budget({ dailyLimit: 50 }),
    };

    // Left unreconciled AND exhausts the public count of 1 at the same time.
    await startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial({ dailyLimit: 1 }) });

    await expect(
      startLiveRunWithAttemptLimit(prisma, { ...params, publicTrial: publicTrial({ dailyLimit: 1 }) }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_LATCH_UNRECONCILED" });
  });
});

/**
 * The races. These use SEPARATE Prisma clients so the transactions are genuinely
 * concurrent at the PostgreSQL level — a single client would serialize them in
 * the driver and prove nothing about the row lock.
 */
describe("startLiveRunWithAttemptLimit — concurrency", () => {
  it("lets exactly one of two concurrent requests take a job's final attempt", async () => {
    const job = await newJob("TKT-race-attempt");
    const second = createPrismaClient();

    try {
      const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 1, budget: budget() };
      const results = await Promise.allSettled([
        startLiveRunWithAttemptLimit(prisma, params),
        startLiveRunWithAttemptLimit(second.prisma, params),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "LIVE_RUN_ATTEMPT_LIMIT",
      });

      // No second LIVE row, and the loser consumed no reservation.
      expect(await prisma.agentRun.count({ where: { jobId: job.id, providerMode: "LIVE" } })).toBe(1);
      expect((await budgetRow())?.runsReserved).toBe(1);
    } finally {
      await second.close();
    }
  });

  /**
   * The latch under genuine parallelism.
   *
   * Six simultaneous callers on three separate connections, a daily limit of 3 —
   * and exactly ONE succeeds. Not three: the first reservation leaves
   * runs_reserved = 1, runs_completed = 0, and every other caller's WHERE clause
   * then fails on runs_completed = runs_reserved. The condition is evaluated
   * inside the same statement that writes, so no interleaving can slip a second
   * reservation past it.
   *
   * This is the concurrency property that matters: an unreconciled reservation
   * cannot be bypassed by racing it.
   */
  it("admits exactly one outstanding reservation under parallel pressure", async () => {
    const jobs = await Promise.all(
      ["r1", "r2", "r3", "r4", "r5", "r6"].map((suffix) => newJob(`TKT-race-${suffix}`)),
    );
    // Separate clients so the transactions are genuinely concurrent in
    // PostgreSQL. Held in `extraHandles` so the finally block actually closes
    // them — a leaked pool keeps connections open for the rest of the suite.
    const extraHandles: PrismaClientHandle[] = [createPrismaClient(), createPrismaClient()];
    const clients: PrismaClient[] = [prisma, ...extraHandles.map((h) => h.prisma)];

    try {
      const results = await Promise.allSettled(
        jobs.map((job, index) =>
          startLiveRunWithAttemptLimit(clients[index % clients.length] as PrismaClient, {
            jobId: job.id,
            modelIdentifier: null,
            maxLiveAttempts: 2,
            budget: budget({ dailyLimit: 3 }),
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");

      // One, despite a daily limit of three — the latch is stricter than the
      // count, and it is the binding constraint while a run is outstanding.
      expect(fulfilled).toHaveLength(1);
      expect((await budgetRow())?.runsReserved).toBe(1);
      expect(await prisma.agentRun.count({ where: { providerMode: "LIVE" } })).toBe(1);

      for (const rejection of results.filter((r) => r.status === "rejected")) {
        expect((rejection as PromiseRejectedResult).reason).toMatchObject({
          code: "LIVE_RUN_BUDGET_EXHAUSTED",
        });
      }
    } finally {
      await Promise.all(extraHandles.map((h) => h.close()));
    }
  });

  it("still never exceeds the daily limit across reconciled rounds", async () => {
    // The original property, restated for the reconciled lifecycle: run the race
    // repeatedly, reconciling the winner each time, and the day still stops at
    // its limit rather than drifting past it.
    const dailyLimit = 3;
    let admitted = 0;

    for (let round = 0; round < dailyLimit + 2; round += 1) {
      const job = await newJob(`TKT-rounds-${round}`);
      const params = {
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 2,
        budget: budget({ dailyLimit }),
      };

      try {
        const started = await startLiveRunWithAttemptLimit(prisma, params);
        admitted += 1;
        await reconcileLiveRunBudget(prisma, started.reservation, usage());
      } catch (error) {
        expect(error).toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED" });
      }
    }

    expect(admitted).toBe(dailyLimit);
    const row = await budgetRow();
    expect(row?.runsReserved).toBe(dailyLimit);
    expect(row?.runsCompleted).toBe(dailyLimit);
  });
});

/**
 * THE FAIL-CLOSED LATCH.
 *
 * A LIVE reservation is committed BEFORE the provider runs; the cost is added
 * afterwards, by reconciliation. If reconciliation never happens, the row keeps
 * an accurate run COUNT but a stale COST: estimated_cost_nano_usd and
 * pricing_unknown_runs are both missing a run that already executed.
 *
 * Before this correction the day stayed open in that state, so the cost ceiling
 * and the unknown-pricing gate were evaluated against figures known to be
 * incomplete, and more paid runs could be admitted until only the hard daily
 * COUNT stopped them. The observed-estimate gate failed OPEN, which is the one
 * direction a spend control must never fail.
 *
 * The counters themselves are now the latch: runs_completed = runs_reserved is
 * required by both the authoritative statement and the advisory read. Being in
 * PostgreSQL rather than in process memory is the point — it survives a restart
 * and is shared by every instance.
 */
describe("unreconciled reservations latch the day closed", () => {
  const OPEN_BUDGET = () => budget({ dailyLimit: 10, costCeilingNanoUsd: CEILING });

  it("admits the first reservation of a new day", async () => {
    const job = await newJob("TKT-latch-first");

    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });

    // The INSERT arm is unaffected by the latch, so a fresh day always opens.
    expect(started.reservation.runsReserved).toBe(1);
    expect((await budgetRow())?.runsCompleted).toBe(0);
  });

  it("rejects a second reservation while one is outstanding, with room on every other gate", async () => {
    const first = await newJob("TKT-latch-1");
    const second = await newJob("TKT-latch-2");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: first.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });

    // Every OTHER condition is satisfied, so the latch is unambiguously the
    // thing that refused: 1 of 10 runs used, zero cost recorded against a $1.00
    // ceiling, and no unknown pricing.
    const row = await budgetRow();
    expect(row?.runsReserved).toBe(1);
    expect(row?.runsCompleted).toBe(0);
    expect(row?.estimatedCostNanoUsd).toBe(0n);
    expect(row?.pricingUnknownRuns).toBe(0);

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: second.id,
        modelIdentifier: null,
        maxLiveAttempts: 5,
        budget: OPEN_BUDGET(),
      }),
    ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED" });
  });

  it("creates no AgentRun row and consumes no further reservation when latched", async () => {
    const first = await newJob("TKT-latch-norun-1");
    const second = await newJob("TKT-latch-norun-2");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: first.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });
    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: second.id,
        modelIdentifier: null,
        maxLiveAttempts: 5,
        budget: OPEN_BUDGET(),
      }),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);

    // The whole transaction rolled back: no run for the refused job, and the
    // reservation count did not move.
    expect(await prisma.agentRun.count({ where: { jobId: second.id } })).toBe(0);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("reopens once reconciliation makes the counters equal", async () => {
    const first = await newJob("TKT-latch-reopen-1");
    const second = await newJob("TKT-latch-reopen-2");

    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: first.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });
    await reconcileLiveRunBudget(prisma, started.reservation, usage());

    const row = await budgetRow();
    expect(row?.runsReserved).toBe(row?.runsCompleted);

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: second.id,
        modelIdentifier: null,
        maxLiveAttempts: 5,
        budget: OPEN_BUDGET(),
      }),
    ).resolves.toBeTruthy();
  });

  it("stays latched across a NEW client, because the latch is the durable row", async () => {
    // The restart proxy. A fresh PrismaClient is a fresh connection pool with no
    // shared memory — if the latch were an in-process flag it would be gone here,
    // and this reservation would succeed.
    const first = await newJob("TKT-latch-restart-1");
    const second = await newJob("TKT-latch-restart-2");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: first.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });

    const fresh = createPrismaClient();
    try {
      await expect(
        startLiveRunWithAttemptLimit(fresh.prisma, {
          jobId: second.id,
          modelIdentifier: null,
          maxLiveAttempts: 5,
          budget: OPEN_BUDGET(),
        }),
      ).rejects.toMatchObject({ code: "LIVE_RUN_BUDGET_EXHAUSTED" });

      // And the advisory read agrees, through that same fresh connection.
      expect(await isLiveRunBudgetOpen(fresh.prisma, OPEN_BUDGET())).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it("lets a new UTC day open while yesterday stays latched", async () => {
    // The documented recovery posture: a stuck day is stuck until midnight UTC,
    // and the next day starts from a clean row with no operator action.
    const job = await newJob("TKT-latch-rollover");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: budget({ budgetDate: "2026-07-29" }),
    });

    expect(await isLiveRunBudgetOpen(prisma, budget({ budgetDate: "2026-07-29" }))).toBe(false);
    expect(await isLiveRunBudgetOpen(prisma, budget({ budgetDate: "2026-07-30" }))).toBe(true);

    await expect(
      startLiveRunWithAttemptLimit(prisma, {
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 5,
        budget: budget({ budgetDate: "2026-07-30" }),
      }),
    ).resolves.toBeTruthy();
  });

  it("does not affect FAKE runs at all", async () => {
    // FAKE never reserves, so it cannot be latched. The deterministic demo has
    // to keep working through any live-budget state.
    const job = await newJob("TKT-latch-fake");

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });

    await expect(startRun(prisma, job.id, "FAKE", null)).resolves.toBeTruthy();
    await expect(startRun(prisma, job.id, "FAKE", null)).resolves.toBeTruthy();

    // Still exactly one reservation: FAKE contributed nothing to the budget row.
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("reports closed from the advisory read while outstanding", async () => {
    const job = await newJob("TKT-latch-advisory");

    expect(await isLiveRunBudgetOpen(prisma, OPEN_BUDGET())).toBe(true);

    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: OPEN_BUDGET(),
    });

    // Advisory and authoritative agree — which is what stops /v1/capabilities
    // advertising AVAILABLE for a day where every reservation would be refused.
    expect(await isLiveRunBudgetOpen(prisma, OPEN_BUDGET())).toBe(false);
  });
});

describe("reconcileLiveRunBudget", () => {
  it("records a completion and adds the observed cost", async () => {
    const job = await newJob("TKT-reconcile");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await reconcileLiveRunBudget(prisma, started.reservation, usage());

    expect(await budgetRow()).toMatchObject({
      runsReserved: 1,
      runsCompleted: 1,
      estimatedCostNanoUsd: 17_956_000n,
      pricingUnknownRuns: 0,
    });
  });

  it("accumulates costs across runs as exact integers", async () => {
    const job = await newJob("TKT-accumulate");
    for (let i = 0; i < 3; i += 1) {
      const started = await startLiveRunWithAttemptLimit(prisma, {
        jobId: job.id,
        modelIdentifier: null,
        maxLiveAttempts: 5,
        budget: budget(),
      });
      await reconcileLiveRunBudget(prisma, started.reservation, usage({ estimatedCostNanoUsd: 1n }));
    }

    // 3 × 1 nanoUSD, exactly — no floating-point drift at the sub-cent scale.
    expect((await budgetRow())?.estimatedCostNanoUsd).toBe(3n);
  });

  /**
   * The cross-midnight case, stated in the plan as a worked example:
   *   reserved  2026-07-28T23:59:50Z
   *   finished  2026-07-29T00:00:30Z
   *   → the 28th's row must be reconciled.
   *
   * Recomputing "today" at finalization would credit the 29th and leave the
   * 28th's reservation permanently unreconciled.
   */
  it("reconciles the day the run RESERVED against, not the day it finished", async () => {
    const job = await newJob("TKT-midnight");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget({ budgetDate: "2026-07-28" }),
    });

    expect(started.reservation.budgetDate).toBe("2026-07-28");

    // Reconciliation keys off the reservation, so the fact that "now" is a
    // different day is irrelevant by construction.
    await reconcileLiveRunBudget(prisma, started.reservation, usage());

    expect(await budgetRow("2026-07-28")).toMatchObject({ runsReserved: 1, runsCompleted: 1 });
    expect(await budgetRow("2026-07-29")).toBeUndefined();
  });

  it("adds zero cost and flags the run when the cost is unknown", async () => {
    const job = await newJob("TKT-null-cost");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await reconcileLiveRunBudget(
      prisma,
      started.reservation,
      usage({ estimatedCostNanoUsd: null, pricingStatus: "INSUFFICIENT_USAGE_DETAIL" }),
    );

    expect(await budgetRow()).toMatchObject({
      runsCompleted: 1,
      estimatedCostNanoUsd: 0n,
      pricingUnknownRuns: 1,
    });
  });

  it("is a no-op against a date with no row rather than creating one", async () => {
    // Reconciliation only ever follows a committed reservation, so a missing row
    // means something is already wrong upstream — inventing one would hide it.
    await reconcileLiveRunBudget(
      prisma,
      { budgetDate: "2026-01-01", runsReserved: 1, isPublic: false },
      usage(),
    );

    expect(await budgetRow("2026-01-01")).toBeUndefined();
  });
});

describe("per-run usage persistence", () => {
  it("persists all six usage columns for a completed LIVE run", async () => {
    const job = await newJob("TKT-usage-completed");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(prisma, started.run.id, VALID_REPORT, usage());

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row).toMatchObject({
      providerCallsObserved: 2,
      inputTokens: 1_200,
      outputTokens: 400,
      estimatedCostNanoUsd: 17_956_000n,
      pricingStatus: "CURRENT",
      possibleUnobservedCost: false,
    });
  });

  it("persists usage for a FAILED LIVE run too — the tokens were still spent", async () => {
    const job = await newJob("TKT-usage-failed");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 2,
      budget: budget(),
    });

    const failedStage = await appendFailurePrefix(prisma, started.run.id, "PROVIDER_TIMEOUT");
    await finalizeFailed(
      prisma,
      started.run.id,
      "PROVIDER_TIMEOUT",
      failedStage,
      usage({ providerCallsObserved: 1, possibleUnobservedCost: true }),
    );

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row).toMatchObject({
      providerCallsObserved: 1,
      possibleUnobservedCost: true,
      failureCode: "PROVIDER_TIMEOUT",
      status: "FAILED",
    });
  });

  it("leaves every usage column NULL for a FAKE run", async () => {
    // "Not measured" and "measured as zero" are different facts. A FAKE run made
    // no provider call, so writing 0 would claim a measurement that never
    // happened — and would make a genuinely free LIVE run indistinguishable.
    const job = await newJob("TKT-usage-fake");
    const started = await startRun(prisma, job.id, "FAKE", null);

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(prisma, started.run.id, VALID_REPORT);

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row).toMatchObject({
      providerCallsObserved: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostNanoUsd: null,
      pricingStatus: null,
      possibleUnobservedCost: null,
    });
  });

  it("persists a null cost as NULL rather than as zero", async () => {
    const job = await newJob("TKT-usage-null-cost");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(
      prisma,
      started.run.id,
      VALID_REPORT,
      usage({ estimatedCostNanoUsd: null }),
    );

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row.estimatedCostNanoUsd).toBeNull();
  });

  it("round-trips a null cost together with its uncertainty flag", async () => {
    // The consistent pair, all the way to PostgreSQL and back: NULL cost with
    // possible_unobserved_cost = true. The columns are independent in the
    // schema, so nothing but the write itself keeps them in agreement.
    const job = await newJob("TKT-usage-null-uncertain");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(
      prisma,
      started.run.id,
      VALID_REPORT,
      usage({ estimatedCostNanoUsd: null, possibleUnobservedCost: true }),
    );

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row.estimatedCostNanoUsd).toBeNull();
    expect(row.possibleUnobservedCost).toBe(true);

    // And the read model surfaces both, so the DTO can hide the figure.
    const persisted = await getAgentRun(prisma, started.run.id);
    expect(persisted.run.estimatedCostNanoUsd).toBeNull();
    expect(persisted.run.possibleUnobservedCost).toBe(true);
  });

  it("closes the day's cost gate for a null, uncertain run", async () => {
    // Reconciliation must treat this run as unmeasurable: zero added to the
    // cost total, pricing_unknown_runs incremented, and the day closed.
    const job = await newJob("TKT-usage-null-gate");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await reconcileLiveRunBudget(
      prisma,
      started.reservation,
      usage({ estimatedCostNanoUsd: null, possibleUnobservedCost: true }),
    );

    const row = await budgetRow();
    expect(row?.estimatedCostNanoUsd).toBe(0n);
    expect(row?.pricingUnknownRuns).toBe(1);
    expect(await isLiveRunBudgetOpen(prisma, budget())).toBe(false);
  });

  it("stores the cost as an exact bigint beyond Number.MAX_SAFE_INTEGER", async () => {
    const job = await newJob("TKT-usage-bigint");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });
    const huge = 9_007_199_254_740_993n; // 2^53 + 1

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(
      prisma,
      started.run.id,
      VALID_REPORT,
      usage({ estimatedCostNanoUsd: huge }),
    );

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row.estimatedCostNanoUsd).toBe(huge);
  });

  it("does not overwrite the first finalization's usage on an exact replay", async () => {
    // The persisted usage is what the budget was reconciled from, so a retry
    // must never be able to change it.
    const job = await newJob("TKT-usage-replay");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await appendDirectSuccessPrefix(prisma, started.run.id);
    await finalizeCompleted(prisma, started.run.id, VALID_REPORT, usage());
    await finalizeCompleted(
      prisma,
      started.run.id,
      VALID_REPORT,
      usage({ estimatedCostNanoUsd: 999_999_999n, inputTokens: 1 }),
    );

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    expect(row.estimatedCostNanoUsd).toBe(17_956_000n);
    expect(row.inputTokens).toBe(1_200);
  });

  it("rejects a negative usage figure at the database level", async () => {
    const job = await newJob("TKT-usage-negative");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await expect(
      prisma.$executeRaw`UPDATE agent_runs SET input_tokens = -1 WHERE id = ${started.run.id}::uuid`,
    ).rejects.toBeTruthy();
  });

  it("rejects an unrecognized pricing status at the database level", async () => {
    const job = await newJob("TKT-usage-badstatus");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 2,
      budget: budget(),
    });

    await expect(
      prisma.$executeRaw`UPDATE agent_runs SET pricing_status = 'GUESSED' WHERE id = ${started.run.id}::uuid`,
    ).rejects.toBeTruthy();
  });
});

describe("isLiveRunBudgetOpen", () => {
  it("reports open for a day with no row yet", async () => {
    expect(await isLiveRunBudgetOpen(prisma, budget())).toBe(true);
  });

  it("reports closed once the run limit is reached", async () => {
    const job = await newJob("TKT-open-runs");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 5, budget: budget({ dailyLimit: 1 }) };
    await startLiveRunWithAttemptLimit(prisma, params);

    expect(await isLiveRunBudgetOpen(prisma, budget({ dailyLimit: 1 }))).toBe(false);
  });

  it("reports closed once an unmeasurable run has been reconciled", async () => {
    const job = await newJob("TKT-open-unknown");
    const started = await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: budget(),
    });
    await reconcileLiveRunBudget(prisma, started.reservation, usage({ estimatedCostNanoUsd: null }));

    expect(await isLiveRunBudgetOpen(prisma, budget())).toBe(false);
  });

  it("agrees with the authoritative gate at the boundary", async () => {
    const job = await newJob("TKT-open-agree");
    const params = { jobId: job.id, modelIdentifier: null, maxLiveAttempts: 5, budget: budget({ dailyLimit: 2 }) };

    await reserveAndReconcile(params);
    expect(await isLiveRunBudgetOpen(prisma, params.budget)).toBe(true);

    await reserveAndReconcile(params);
    expect(await isLiveRunBudgetOpen(prisma, params.budget)).toBe(false);
    await expect(startLiveRunWithAttemptLimit(prisma, params)).rejects.toBeTruthy();
  });

  it("reports today independently of another day's state", async () => {
    const job = await newJob("TKT-open-day");
    await startLiveRunWithAttemptLimit(prisma, {
      jobId: job.id,
      modelIdentifier: null,
      maxLiveAttempts: 5,
      budget: budget({ budgetDate: "2026-07-28", dailyLimit: 1 }),
    });

    expect(await isLiveRunBudgetOpen(prisma, budget({ budgetDate: "2026-07-28", dailyLimit: 1 }))).toBe(false);
    expect(await isLiveRunBudgetOpen(prisma, budget({ budgetDate: "2026-07-29", dailyLimit: 1 }))).toBe(true);
  });
});

describe("currentBudgetDate", () => {
  it("formats the UTC calendar day", () => {
    expect(currentBudgetDate(new Date("2026-07-29T12:00:00Z"))).toBe("2026-07-29");
  });

  it("uses UTC rather than local time at the day boundary", () => {
    // 23:59:50Z on the 28th is the 28th, and 00:00:30Z is the 29th — regardless
    // of the machine's timezone. This is the pairing the cross-midnight
    // reconciliation test above depends on.
    expect(currentBudgetDate(new Date("2026-07-28T23:59:50Z"))).toBe("2026-07-28");
    expect(currentBudgetDate(new Date("2026-07-29T00:00:30Z"))).toBe("2026-07-29");
  });
});
