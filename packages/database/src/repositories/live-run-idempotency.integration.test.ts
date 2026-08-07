import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { LiveRunAdmissionError } from "../live-run-errors";
import {
  appendInvestigationEvent,
  createJob,
  finalizeCompleted,
  finalizeFailed,
  reconcileLiveRunBudget,
  replayLiveRun,
  startLiveRunWithAttemptLimit,
  startRun,
} from "./agent-run-repository";
import { appendDirectSuccessPrefix } from "../test/canonical-stream";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import type {
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  LiveRunStartResult,
  RunProviderUsageWrite,
} from "../types";

/**
 * Narrows a start result to the STARTED arm and hands back its reservation.
 *
 * A replay carries none, deliberately — reconciling one would double-count a
 * cost the original attempt already recorded. Where a test means "the run this
 * call created", saying so explicitly is what keeps that distinction typed
 * rather than asserted away.
 */
function reservationOf(result: LiveRunStartResult): LiveRunBudgetReservation {
  if (result.outcome !== "started") {
    throw new Error("expected a started run, not a replay");
  }
  return result.reservation;
}


/**
 * IDEMPOTENT LIVE RUN CREATION.
 *
 * The defect: a `POST /v1/agent-jobs/:jobId/runs` exception does not prove that
 * no run was created. Finalization can fail AFTER the provider executed and
 * after the budget was reconciled, and a successful response can be lost in
 * transit. The browser offered recovery for both, and recovery created a SECOND
 * paid attempt.
 *
 * These tests exercise the layer that actually decides: the one transaction that
 * locks the job, looks the key up, and either replays or creates. The provider
 * itself never appears here — it cannot, because this package has no idea one
 * exists. What stands in for "the provider ran again" is the thing that would
 * make it run again: a SECOND AgentRun row, a second reservation, a second
 * attempt consumed. If none of those appear, no second execution is possible,
 * because the caller only executes for a run this function created.
 */

const CEILING = 1_000_000_000n; // $1.00
const BUDGET_DATE = "2026-07-29";

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
  return createJob(prisma, { ticketId, summary: `Idempotency coverage for ${ticketId}` });
}

function params(jobId: string, clientRequestId: string, overrides: Record<string, unknown> = {}) {
  return {
    jobId,
    modelIdentifier: "claude-sonnet-5",
    maxLiveAttempts: 3,
    budget: budget(),
    clientRequestId,
    ...overrides,
  } as Parameters<typeof startLiveRunWithAttemptLimit>[1];
}

async function budgetRow(date = BUDGET_DATE) {
  const [row] = await prisma.$queryRaw<
    { runsReserved: number; runsCompleted: number; estimatedCostNanoUsd: bigint }[]
  >`
    SELECT runs_reserved AS "runsReserved", runs_completed AS "runsCompleted",
           estimated_cost_nano_usd AS "estimatedCostNanoUsd"
    FROM live_run_budget WHERE budget_date = ${date}::date`;
  return row;
}

function liveRunCount(jobId: string) {
  return prisma.agentRun.count({ where: { jobId, providerMode: "LIVE" } });
}

describe("same job, same key — sequentially", () => {
  it("creates exactly one run, reserves exactly once, and replays the original", async () => {
    const job = await newJob("TKT-idem-seq");
    const key = randomUUID();

    const first = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    const second = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("replayed");
    // The SAME row, by id. Not merely "a run for this job".
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.attemptNumber).toBe(first.run.attemptNumber);

    expect(await liveRunCount(job.id)).toBe(1);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("replays indefinitely, never accumulating rows or reservations", async () => {
    const job = await newJob("TKT-idem-repeat");
    const key = randomUUID();

    const first = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const replay = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
      expect(replay.outcome).toBe("replayed");
      expect(replay.run.id).toBe(first.run.id);
    }

    // Five recovery attempts, one run, one reservation. Under the old behaviour
    // this was five paid executions.
    expect(await liveRunCount(job.id)).toBe(1);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("returns the locked job snapshot on a replay too, not just the run", async () => {
    const job = await newJob("TKT-idem-job-snapshot");
    const key = randomUUID();

    await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    const replay = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    // The caller derives the agent's ticket context from this snapshot, so a
    // replay that omitted it would be a different shape to handle.
    expect(replay.job.id).toBe(job.id);
    expect(replay.job.ticketContext.ticketId).toBe("TKT-idem-job-snapshot");
  });
});

/**
 * The race, on SEPARATE Prisma clients so the transactions are genuinely
 * concurrent at the PostgreSQL level. A single client would serialize them in
 * the driver and prove nothing about the job row lock.
 */
describe("same job, same key — concurrently", () => {
  it("creates one row and one reservation across two simultaneous requests", async () => {
    const job = await newJob("TKT-idem-race");
    const key = randomUUID();
    const second = createPrismaClient();

    try {
      const results = await Promise.all([
        startLiveRunWithAttemptLimit(prisma, params(job.id, key)),
        startLiveRunWithAttemptLimit(second.prisma, params(job.id, key)),
      ]);

      // Both SUCCEED — neither caller is punished for the race — and both name
      // the same run. Exactly one of them started it.
      const outcomes = results.map((r) => r.outcome).sort();
      expect(outcomes).toEqual(["replayed", "started"]);
      expect(results[0]!.run.id).toBe(results[1]!.run.id);

      expect(await liveRunCount(job.id)).toBe(1);
      // The counter that maps directly to money: incremented once, not twice.
      expect((await budgetRow())?.runsReserved).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("holds under many simultaneous duplicates", async () => {
    const job = await newJob("TKT-idem-race-many");
    const key = randomUUID();
    const clients = [createPrismaClient(), createPrismaClient(), createPrismaClient()];

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_unused, index) =>
          startLiveRunWithAttemptLimit(clients[index % clients.length]!.prisma, params(job.id, key)),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      // Whatever the interleaving, the durable facts are fixed. A rejection here
      // would be the partial unique index catching a duplicate the lock somehow
      // let through — still no second run, which is the invariant that matters.
      expect(await liveRunCount(job.id)).toBe(1);
      expect((await budgetRow())?.runsReserved).toBe(1);
      expect(fulfilled.length).toBeGreaterThan(0);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});

describe("the ambiguous failures this exists for", () => {
  it("a lost response: repeating the key returns the finished run, spending nothing", async () => {
    const job = await newJob("TKT-idem-lost-response");
    const key = randomUUID();

    // The original request succeeded end to end — run created, provider ran,
    // outcome finalized, budget reconciled — and only the HTTP response was
    // lost. The client cannot tell this from a pre-execution refusal.
    const first = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    await appendDirectSuccessPrefix(prisma, first.run.id);
    await finalizeCompleted(prisma, first.run.id, VALID_REPORT, usage());
    await reconcileLiveRunBudget(prisma, reservationOf(first), usage());

    const replay = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    expect(replay.outcome).toBe("replayed");
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.status).toBe("COMPLETED");
    expect(await liveRunCount(job.id)).toBe(1);
    const row = await budgetRow();
    // Reconciled once. A second execution would have reserved again and
    // double-counted the day.
    expect(row?.runsReserved).toBe(1);
    expect(row?.runsCompleted).toBe(1);
    expect(row?.estimatedCostNanoUsd).toBe(17_956_000n);
  });

  it("a failed finalization: the RUNNING row is returned, not re-executed", async () => {
    const job = await newJob("TKT-idem-finalization");
    const key = randomUUID();

    // The provider ran and the budget was reconciled; only the run's own
    // finalization transaction rolled back, so the row is still RUNNING.
    const first = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    await reconcileLiveRunBudget(prisma, reservationOf(first), usage());

    const replay = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    // RUNNING is a VALID replay. Refusing it, or treating it as "unfinished, so
    // start again", is precisely the duplicate charge this prevents.
    expect(replay.outcome).toBe("replayed");
    expect(replay.run.status).toBe("RUNNING");
    expect(replay.run.id).toBe(first.run.id);
    expect(await liveRunCount(job.id)).toBe(1);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("a failure BEFORE the row committed: the same key then creates exactly one run", async () => {
    const job = await newJob("TKT-idem-precommit");
    const key = randomUUID();

    // Another job's unreconciled reservation latches the UTC day shut, so the
    // first request carrying this key is refused INSIDE the transaction and
    // rolls back, leaving no row that bears it. There is nothing to replay, and
    // the key must not become a permanent tombstone for the job.
    const blocker = await newJob("TKT-idem-precommit-blocker");
    const blocking = await startLiveRunWithAttemptLimit(prisma, params(blocker.id, randomUUID()));

    await expect(
      startLiveRunWithAttemptLimit(prisma, params(job.id, key)),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);
    expect(await liveRunCount(job.id)).toBe(0);

    // The day reopens, and the SAME key now creates the run it never got to.
    await reconcileLiveRunBudget(prisma, reservationOf(blocking), usage());
    const retried = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    expect(retried.outcome).toBe("started");
    expect(await liveRunCount(job.id)).toBe(1);
    // And repeating it once more still replays rather than creating a second.
    const replay = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    expect(replay.outcome).toBe("replayed");
    expect(await liveRunCount(job.id)).toBe(1);
  });
});

describe("what the key does NOT change", () => {
  it("different keys on one job remain separate attempts, still capped", async () => {
    const job = await newJob("TKT-idem-different-keys");

    const first = await startLiveRunWithAttemptLimit(prisma, params(job.id, randomUUID(), { maxLiveAttempts: 2 }));
    await reconcileLiveRunBudget(prisma, reservationOf(first), usage());
    const second = await startLiveRunWithAttemptLimit(prisma, params(job.id, randomUUID(), { maxLiveAttempts: 2 }));
    await reconcileLiveRunBudget(prisma, reservationOf(second), usage());

    expect(second.outcome).toBe("started");
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.attemptNumber).toBe(first.run.attemptNumber + 1);

    // The per-job attempt limit is untouched by idempotency: a deliberate third
    // attempt is still refused.
    await expect(
      startLiveRunWithAttemptLimit(prisma, params(job.id, randomUUID(), { maxLiveAttempts: 2 })),
    ).rejects.toMatchObject({ code: "LIVE_RUN_ATTEMPT_LIMIT" });
    expect(await liveRunCount(job.id)).toBe(2);
  });

  it("the same key on a DIFFERENT job is a different request", async () => {
    const first = await newJob("TKT-idem-scope-a");
    const other = await newJob("TKT-idem-scope-b");
    const key = randomUUID();

    const a = await startLiveRunWithAttemptLimit(prisma, params(first.id, key));
    await reconcileLiveRunBudget(prisma, reservationOf(a), usage());
    const b = await startLiveRunWithAttemptLimit(prisma, params(other.id, key));

    // Uniqueness is (job_id, client_request_id), so a key reused against another
    // job names a genuinely different request — and, just as importantly, one
    // job can never replay another job's run.
    expect(b.outcome).toBe("started");
    expect(b.run.id).not.toBe(a.run.id);
    expect(b.run.jobId).toBe(other.id);
    expect(await liveRunCount(first.id)).toBe(1);
    expect(await liveRunCount(other.id)).toBe(1);
  });

  it("a FAKE run stores no key and is never replayed", async () => {
    const job = await newJob("TKT-idem-fake");

    const first = await startRun(prisma, job.id, "FAKE", null);
    const second = await startRun(prisma, job.id, "FAKE", null);

    // Two rows, both keyless. A deterministic run spends nothing, so repeating
    // one is harmless and needs no protection.
    expect(second.run.id).not.toBe(first.run.id);
    const rows = await prisma.agentRun.findMany({
      where: { jobId: job.id },
      select: { clientRequestId: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.clientRequestId === null)).toBe(true);
  });

  it("keyless historical rows do not collide with each other", async () => {
    // The partial unique index must not treat two NULL keys as duplicates —
    // every row written before this migration has one.
    const job = await newJob("TKT-idem-null-keys");
    await startRun(prisma, job.id, "FAKE", null);
    await startRun(prisma, job.id, "FAKE", null);
    await expect(startRun(prisma, job.id, "FAKE", null)).resolves.toBeTruthy();
    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(3);
  });
});

/**
 * `replayLiveRun` — the READ-ONLY lookup that runs BEFORE new-run spend
 * admission.
 *
 * The ordering defect it exists to fix: the API ran every gate governing NEW
 * spending (rate limit, advisory budget, concurrency lease) before it ever
 * reached the transaction that performs the key lookup. So a request whose
 * original attempt consumed the day's final reservation — or left the day
 * latched by failing to reconcile — could never be recovered. The gate its own
 * original attempt closed answered first, and the run that already existed was
 * unreachable.
 *
 * Two properties are load-bearing here, and both need a real database to
 * demonstrate:
 *
 *   1. it writes NOTHING — no reservation, no attempt, no row, no status change;
 *   2. it takes the SAME AgentJob lock the creating transaction does, so it
 *      cannot read past an in-flight original and wrongly answer "nothing was
 *      created".
 */
describe("replayLiveRun — the read-only lookup", () => {
  it("returns null for a key that names nothing on this job", async () => {
    const job = await newJob("TKT-replay-miss");

    expect(await replayLiveRun(prisma, { jobId: job.id, clientRequestId: randomUUID() })).toBeNull();
    // A miss must leave the day exactly as it found it — no row created merely
    // by asking the question.
    expect(await budgetRow()).toBeUndefined();
    expect(await liveRunCount(job.id)).toBe(0);
  });

  it("returns the run an earlier creation committed for the same key", async () => {
    const job = await newJob("TKT-replay-hit");
    const key = randomUUID();
    const created = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });

    expect(found?.outcome).toBe("replayed");
    expect(found?.run.id).toBe(created.run.id);
    expect(found?.run.attemptNumber).toBe(created.run.attemptNumber);
    // The locked job snapshot rides along, exactly as the creating transaction
    // returns it.
    expect(found?.job.id).toBe(job.id);
  });

  it("writes nothing at all: no reservation, no attempt, no second row", async () => {
    const job = await newJob("TKT-replay-readonly");
    const key = randomUUID();
    await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
    const before = await budgetRow();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });
      expect(found).not.toBeNull();
    }

    // The counters that map directly to money are byte-identical afterwards.
    expect(await budgetRow()).toEqual(before);
    expect(await liveRunCount(job.id)).toBe(1);
  });

  it("finds the run even when the day's budget is fully exhausted", async () => {
    // THE HEADLINE CASE. The original request consumed the last of the day's
    // allowance, so `startLiveRunWithAttemptLimit` with a NEW key is refused —
    // and before the split, the recovery was refused at the advisory gate
    // upstream of that, without ever looking.
    const job = await newJob("TKT-replay-budget-exhausted");
    const key = randomUUID();
    const created = await startLiveRunWithAttemptLimit(
      prisma,
      params(job.id, key, { budget: budget({ dailyLimit: 1 }) }),
    );
    await reconcileLiveRunBudget(prisma, reservationOf(created), usage());

    // A NEW key is genuinely refused — the day really is closed.
    await expect(
      startLiveRunWithAttemptLimit(
        prisma,
        params(job.id, randomUUID(), { budget: budget({ dailyLimit: 1 }) }),
      ),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);

    // The existing run is still recoverable, for free.
    const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });
    expect(found?.run.id).toBe(created.run.id);
    expect((await budgetRow())?.runsReserved).toBe(1);
  });

  it("finds the run even when the day is LATCHED by an unreconciled reservation", async () => {
    // runs_reserved > runs_completed is the fail-closed latch: the day admits no
    // further runs until the counters agree. It is also the exact state a
    // reconciliation failure leaves behind — which is one of the ambiguous
    // failures recovery exists for, so it must not be able to block recovery.
    const job = await newJob("TKT-replay-latched");
    const key = randomUUID();
    const created = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));

    const row = await budgetRow();
    expect(row?.runsReserved).toBe(1);
    expect(row?.runsCompleted).toBe(0);

    await expect(
      startLiveRunWithAttemptLimit(prisma, params(job.id, randomUUID())),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);

    const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });
    expect(found?.run.id).toBe(created.run.id);
    // Still latched afterwards: the lookup did not touch the counters.
    expect(await budgetRow()).toEqual(row);
  });

  it("finds a run whose per-job attempt limit is already used up", async () => {
    const job = await newJob("TKT-replay-attempt-limit");
    const key = randomUUID();
    const created = await startLiveRunWithAttemptLimit(
      prisma,
      params(job.id, key, { maxLiveAttempts: 1 }),
    );

    await expect(
      startLiveRunWithAttemptLimit(prisma, params(job.id, randomUUID(), { maxLiveAttempts: 1 })),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);

    const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });
    expect(found?.run.id).toBe(created.run.id);
  });

  it.each(["RUNNING", "COMPLETED", "FAILED"] as const)(
    "finds a %s run identically, never inferring replay from status",
    async (status) => {
      const job = await newJob(`TKT-replay-status-${status}`);
      const key = randomUUID();
      const created = await startLiveRunWithAttemptLimit(prisma, params(job.id, key));
      if (status === "COMPLETED") {
        await appendDirectSuccessPrefix(prisma, created.run.id);
        await finalizeCompleted(prisma, created.run.id, VALID_REPORT);
      } else if (status === "FAILED") {
        await appendInvestigationEvent(prisma, created.run.id, { type: "AGENT_STARTED" });
        await finalizeFailed(prisma, created.run.id, "PROVIDER_TIMEOUT", "AGENT_ANALYSIS");
      }

      const found = await replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });

      // A RUNNING row is the NORMAL shape of the case this exists for — the
      // provider executed and finalization failed. Refusing to return it because
      // it looks unfinished is precisely the duplicate charge the key prevents.
      expect(found?.run.id).toBe(created.run.id);
      expect(found?.run.status).toBe(status);
    },
  );

  it("is scoped to the job in the request, never to the key alone", async () => {
    const owner = await newJob("TKT-replay-scope-owner");
    const other = await newJob("TKT-replay-scope-other");
    const key = randomUUID();
    await startLiveRunWithAttemptLimit(prisma, params(owner.id, key));

    // Uniqueness is (job_id, client_request_id). A key presented against a
    // different job finds nothing, so it cannot borrow another job's run.
    expect(await replayLiveRun(prisma, { jobId: other.id, clientRequestId: key })).toBeNull();
  });

  it("never returns a FAKE run, which carries no key at all", async () => {
    const job = await newJob("TKT-replay-fake");
    await startRun(prisma, job.id, "FAKE", null);

    expect(await replayLiveRun(prisma, { jobId: job.id, clientRequestId: randomUUID() })).toBeNull();
  });

  it("reports a nonexistent job as PERSISTENCE_NOT_FOUND, exactly as creation does", async () => {
    // One cause, one contract: the caller maps this to the same 404 whichever
    // path met it, and a request naming a job that does not exist still cannot
    // drain the day's allowance on its way to being told so.
    await expect(
      replayLiveRun(prisma, { jobId: randomUUID(), clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
    expect(await budgetRow()).toBeUndefined();
  });

  /**
   * THE LOCK, demonstrated rather than asserted about.
   *
   * A plain unlocked SELECT would return immediately with "no row" while the
   * original transaction was still open — and the caller would conclude nothing
   * was created and admit a second paid execution. Taking the same AgentJob lock
   * makes the lookup WAIT for the original to resolve, so it observes a decided
   * outcome rather than an in-progress one.
   */
  describe("the job lock, against an in-flight original", () => {
    it("waits for an uncommitted creation and then returns its run", async () => {
      const job = await newJob("TKT-replay-lock-commit");
      const key = randomUUID();
      const other = createPrismaClient();

      try {
        let createdRunId: string | null = null;
        let releaseOriginal!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseOriginal = resolve;
        });

        // An open transaction that has inserted the run but not yet committed.
        const original = other.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM agent_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
          const row = await tx.agentRun.create({
            data: {
              jobId: job.id,
              attemptNumber: 1,
              status: "RUNNING",
              startedAt: new Date(),
              providerMode: "LIVE",
              modelIdentifier: "claude-sonnet-5",
              clientRequestId: key,
            },
          });
          createdRunId = row.id;
          await held;
        });

        // Give the transaction time to take the lock and insert.
        await new Promise((resolve) => setTimeout(resolve, 100));

        let lookupSettled = false;
        const lookup = replayLiveRun(prisma, { jobId: job.id, clientRequestId: key }).then(
          (result) => {
            lookupSettled = true;
            return result;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Blocked on the lock — an unlocked SELECT would have answered `null` by
        // now, which is the wrong answer and the expensive one.
        expect(lookupSettled).toBe(false);

        releaseOriginal();
        await original;

        const found = await lookup;
        expect(found?.run.id).toBe(createdRunId);
      } finally {
        await other.close();
      }
    });

    it("returns null after an in-flight creation ROLLS BACK", async () => {
      const job = await newJob("TKT-replay-lock-rollback");
      const key = randomUUID();
      const other = createPrismaClient();

      try {
        let abortOriginal!: () => void;
        const held = new Promise<void>((_resolve, reject) => {
          abortOriginal = () => reject(new Error("rolled back on purpose"));
        });

        const original = other.prisma
          .$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM agent_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
            await tx.agentRun.create({
              data: {
                jobId: job.id,
                attemptNumber: 1,
                status: "RUNNING",
                startedAt: new Date(),
                providerMode: "LIVE",
                modelIdentifier: "claude-sonnet-5",
                clientRequestId: key,
              },
            });
            await held;
          })
          .catch(() => undefined);

        await new Promise((resolve) => setTimeout(resolve, 100));
        const lookup = replayLiveRun(prisma, { jobId: job.id, clientRequestId: key });
        abortOriginal();
        await original;

        // The rollback took the row with it, so `null` is the CORRECT answer —
        // and the caller goes on to new-run admission, which is what it should
        // do when nothing was created.
        expect(await lookup).toBeNull();
        expect(await liveRunCount(job.id)).toBe(0);
      } finally {
        await other.close();
      }
    });
  });
});
