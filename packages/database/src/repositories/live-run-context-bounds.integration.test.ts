import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { LiveRunAdmissionError } from "../live-run-errors";
import {
  getAgentJob,
  getAgentRun,
  startLiveRunWithAttemptLimit,
  startRun,
} from "./agent-run-repository";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import type {
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  LiveRunStartResult,
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
 * LEGACY JOBS AND THE CURRENT LIVE BOUNDS.
 *
 * `StoredTicketContextSchema` is deliberately permissive so rows written before
 * the 15..2000 rule stay readable — a tightened INPUT rule must not invalidate
 * history. But `startLiveRunWithAttemptLimit` read that same permissive snapshot
 * and handed it to a provider that CHARGES for it, so a job created under the
 * old rule could start a paid run with a summary no current caller is allowed to
 * submit.
 *
 * The split these tests pin down:
 *
 *   stored-read compatibility  →  permissive
 *   LIVE execution eligibility →  current bounds
 *
 * Every rejection below must leave the job with no run, no attempt consumed, and
 * NO BUDGET ROW AT ALL — the transaction rolls back before the reservation
 * statement, so the day is never touched.
 *
 * Legacy rows are written with raw SQL on purpose. `createJob` enforces the
 * current write bounds, so there is no way to produce one through the public
 * API — which is the point: these rows exist only because they predate the rule.
 */

const BUDGET_DATE = "2026-07-29";

function budget(): LiveRunBudgetReservationInput {
  return { budgetDate: BUDGET_DATE, dailyLimit: 10, costCeilingNanoUsd: 1_000_000_000n };
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

/** A row that `createJob` would refuse today, inserted the way history did. */
async function legacyJob(ticketId: string, summary: string): Promise<string> {
  const context = JSON.stringify({ ticketId, summary });
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_jobs (ticket_context, external_ticket_id)
    VALUES (${context}::jsonb, ${ticketId})
    RETURNING id`;
  return row!.id;
}

function startLive(jobId: string) {
  return startLiveRunWithAttemptLimit(prisma, {
    jobId,
    modelIdentifier: "claude-sonnet-5",
    maxLiveAttempts: 3,
    budget: budget(),
    clientRequestId: randomUUID(),
  });
}

async function budgetRowExists() {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM live_run_budget`;
  return (row?.count ?? 0n) > 0n;
}

async function expectNoPaidSideEffect(jobId: string) {
  expect(await prisma.agentRun.count({ where: { jobId } })).toBe(0);
  // No reservation, because the rejection happens before the reservation
  // statement runs at all — not because it was rolled back afterwards.
  expect(await budgetRowExists()).toBe(false);
}

describe("a legacy summary shorter than the current floor", () => {
  const SHORT = "Disk full";

  it("still reads back through the ordinary job read", async () => {
    const jobId = await legacyJob("TKT-legacy-short", SHORT);

    const persisted = await getAgentJob(prisma, jobId);

    // History stays readable, exactly as persisted — no trimming, no rewriting.
    expect(persisted.job.ticketContext.summary).toBe(SHORT);
  });

  it("still runs FAKE, which spends nothing", async () => {
    const jobId = await legacyJob("TKT-legacy-short-fake", SHORT);

    const started = await startRun(prisma, jobId, "FAKE", null);

    // A deterministic run makes no provider call, so there is no money for the
    // bounds to protect and no reason to invalidate the row retroactively.
    expect(started.run.providerMode).toBe("FAKE");
    expect(started.job.ticketContext.summary).toBe(SHORT);
    // And it stays readable afterwards.
    const persisted = await getAgentRun(prisma, started.run.id);
    expect(persisted.run.status).toBe("RUNNING");
  });

  it("is refused for LIVE, before any paid side effect", async () => {
    const jobId = await legacyJob("TKT-legacy-short-live", SHORT);

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });
});

describe("a legacy summary longer than the current ceiling", () => {
  const LONG = "x".repeat(2001);

  it("still reads back", async () => {
    const jobId = await legacyJob("TKT-legacy-long", LONG);
    const persisted = await getAgentJob(prisma, jobId);
    expect(persisted.job.ticketContext.summary).toHaveLength(2001);
  });

  it("still runs FAKE", async () => {
    const jobId = await legacyJob("TKT-legacy-long-fake", LONG);
    await expect(startRun(prisma, jobId, "FAKE", null)).resolves.toBeTruthy();
  });

  it("is refused for LIVE, before any paid side effect", async () => {
    const jobId = await legacyJob("TKT-legacy-long-live", LONG);

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("is refused at exactly one character over, and admitted at the ceiling", async () => {
    const over = await legacyJob("TKT-legacy-2001", "y".repeat(2001));
    await expect(startLive(over)).rejects.toBeInstanceOf(LiveRunAdmissionError);

    const at = await legacyJob("TKT-legacy-2000", "y".repeat(2000));
    await expect(startLive(at)).resolves.toMatchObject({ outcome: "started" });
  });
});

/**
 * WHITESPACE IS NOT A BYPASS — and "passes the bound" is not the same test as
 * "is the value that will be sent".
 *
 * `TicketContextSchema` TRIMS before it measures, but the repository sends the
 * STORED snapshot to the provider, not the schema's parsed output. So a row
 * padded with arbitrary whitespace around a valid 20-character summary would
 * satisfy a 15..2000 rule that was never applied to the string actually billed
 * for. Eligibility therefore requires the stored value to ALREADY EQUAL its
 * parsed form: the measured value and the sent value are then the same string by
 * construction.
 */
describe("only canonical stored values may start a new LIVE run", () => {
  it("refuses a padded summary whose TRIMMED value is below the floor", async () => {
    const padded = `${" ".repeat(20)}Disk full${" ".repeat(11)}`;
    expect(padded.trim().length).toBeLessThan(15);
    const jobId = await legacyJob("TKT-legacy-padded", padded);

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("refuses a padded summary even when its trimmed value is perfectly valid", async () => {
    // This is the case a `safeParse().success` check let through: the trimmed
    // value is a fine 42-character summary, and the run would have gone ahead
    // sending the padded original.
    const padded = `  Elevated error rate on the billing service  `;
    expect(padded.trim().length).toBeGreaterThanOrEqual(15);
    const jobId = await legacyJob("TKT-legacy-padded-ok", padded);

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("refuses ARBITRARILY LARGE padding around valid content", async () => {
    // The whole point. 200 kB of whitespace around 27 valid characters: the
    // trimmed length is 27, comfortably inside 15..2000, while the prompt that
    // would actually be paid for is 200,000 characters long.
    const inner = "Elevated error rate on API";
    const padded = `${" ".repeat(100_000)}${inner}${" ".repeat(100_000)}`;
    expect(padded.trim()).toBe(inner);
    expect(padded.length).toBeGreaterThan(2_000);
    const jobId = await legacyJob("TKT-legacy-huge-padding", padded);

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("refuses a padded TICKET ID whose trimmed value is valid", async () => {
    const jobId = await legacyJob("  TKT-legacy-padded-id  ", "Elevated API error rate on billing");

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("refuses a trailing newline, which no counter would show a reader", async () => {
    const jobId = await legacyJob("TKT-legacy-newline", "Elevated API error rate on billing\n");

    await expect(startLive(jobId)).rejects.toBeInstanceOf(LiveRunAdmissionError);

    await expectNoPaidSideEffect(jobId);
  });

  it("hands the provider EXACTLY the stored value for a row it admits", async () => {
    // The other half of the guarantee. Because an admitted row is already
    // canonical, "the stored value" and "the value the bounds were checked
    // against" are the same string — so passing the snapshot through unchanged
    // is safe, and no normalization ever happens on the execution path.
    const summary = "Elevated API error rate on billing-service";
    const jobId = await legacyJob("TKT-canonical", summary);

    const started = await startLive(jobId);

    expect(started.outcome).toBe("started");
    expect(started.job.ticketContext.summary).toBe(summary);
    expect(started.job.ticketContext.ticketId).toBe("TKT-canonical");
    // Nothing was written back to the row either.
    const persisted = await getAgentJob(prisma, jobId);
    expect(persisted.job.ticketContext.summary).toBe(summary);
  });

  it("admits a canonical summary at exactly the 15-character floor", async () => {
    // One start per test: an unreconciled reservation latches the UTC day, so a
    // second LIVE run here would be refused by the latch rather than by
    // anything this test is about. The 2000-character ceiling has its own case
    // above.
    const atFloor = await legacyJob("TKT-canonical-15", "y".repeat(15));
    await expect(startLive(atFloor)).resolves.toMatchObject({ outcome: "started" });
  });
});

describe("the ticket id is held to the same current bound", () => {
  it("refuses a legacy ticket id longer than 64 characters", async () => {
    // Applied consistently with the summary: one predicate over the whole stored
    // context, one error code, one rejection point. A row that today's
    // POST /v1/agent-jobs would refuse is a row LIVE will not execute.
    const jobId = await legacyJob(`TKT-${"z".repeat(70)}`, "Elevated error rate on billing");

    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    await expectNoPaidSideEffect(jobId);
  });

  it("still reads and still runs FAKE with an over-long legacy ticket id", async () => {
    const ticketId = `TKT-${"z".repeat(70)}`;
    const jobId = await legacyJob(ticketId, "Elevated error rate on billing");

    await expect(getAgentJob(prisma, jobId)).resolves.toBeTruthy();
    await expect(startRun(prisma, jobId, "FAKE", null)).resolves.toBeTruthy();
  });
});

describe("a compliant job is unaffected", () => {
  it("runs LIVE exactly as before", async () => {
    const jobId = await legacyJob("TKT-current", "Elevated API error rate on billing-service");

    const started = await startLive(jobId);

    expect(started.outcome).toBe("started");
    expect(started.run.providerMode).toBe("LIVE");
    expect(await budgetRowExists()).toBe(true);
  });

  it("leaves the day's budget untouched by a rejected neighbour", async () => {
    const good = await legacyJob("TKT-current-neighbour", "Elevated API error rate on billing");
    const bad = await legacyJob("TKT-legacy-neighbour", "short");

    await expect(startLive(bad)).rejects.toBeInstanceOf(LiveRunAdmissionError);
    const started = await startLive(good);

    // The rejected request consumed nothing, so the compliant one still gets
    // the day's first reservation.
    expect(reservationOf(started).runsReserved).toBe(1);
  });
});

describe("a replay outranks the bounds", () => {
  it("returns an existing run for a legacy job rather than refusing it", async () => {
    // The ordering that makes this possible: the key lookup happens BEFORE the
    // eligibility check. A run that already exists was already paid for, and a
    // rule about what may START cannot change what a finished run cost. Refusing
    // to hand it back would strand it.
    const jobId = await legacyJob("TKT-legacy-replay", "Elevated API error rate on billing");
    const key = randomUUID();
    const first = await startLiveRunWithAttemptLimit(prisma, {
      jobId,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 3,
      budget: budget(),
      clientRequestId: key,
    });

    // The row is then edited to a value today's rule forbids — standing in for a
    // job whose context predates the bounds and already has a run.
    await prisma.$executeRaw`
      UPDATE agent_jobs SET ticket_context = ${JSON.stringify({
        ticketId: "TKT-legacy-replay",
        summary: "short",
      })}::jsonb WHERE id = ${jobId}::uuid`;

    const replay = await startLiveRunWithAttemptLimit(prisma, {
      jobId,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 3,
      budget: budget(),
      clientRequestId: key,
    });

    expect(replay.outcome).toBe("replayed");
    expect(replay.run.id).toBe(first.run.id);

    // A NEW key against the same now-ineligible job is still refused — the
    // exemption is for the run that exists, not for the job.
    await expect(startLive(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });
  });
});

/**
 * Issue #39 — the PUBLIC trial's stricter 15..300 bound, distinct from the
 * private 15..2000 bound above. Same canonical-form contract, same rejection
 * code, same "before any paid side effect" placement — only the ceiling
 * differs, and only for a request carrying `publicTrial`.
 */
describe("PUBLIC trial eligibility uses the 15..300 bound, not 15..2000", () => {
  function startPublic(jobId: string) {
    return startLiveRunWithAttemptLimit(prisma, {
      jobId,
      modelIdentifier: "claude-sonnet-5",
      maxLiveAttempts: 3,
      budget: budget(),
      clientRequestId: randomUUID(),
      publicTrial: { visitorId: randomUUID(), publicDailyLimit: 5, publicCostCeilingNanoUsd: 500_000_000n },
    });
  }

  it("admits a summary within 15..300 for PUBLIC", async () => {
    const jobId = await legacyJob("TKT-public-ok", "Elevated API error rate on billing-service");
    await expect(startPublic(jobId)).resolves.toMatchObject({ outcome: "started" });
  });

  it("refuses a summary that PASSES the private 15..2000 bound but exceeds 300, for PUBLIC only", async () => {
    const summary = "y".repeat(301);
    const publicJob = await legacyJob("TKT-public-over-301a", summary);
    await expect(startPublic(publicJob)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    // The SAME summary is eligible for the PRIVATE path — proving this is a
    // stricter PUBLIC-only bound, not a global tightening of 2000 to 300.
    const privateJob = await legacyJob("TKT-public-over-301b", summary);
    await expect(startLive(privateJob)).resolves.toMatchObject({ outcome: "started" });
  });

  it("is refused at exactly one character over 300, and admitted at exactly 300", async () => {
    const over = await legacyJob("TKT-public-301", "y".repeat(301));
    await expect(startPublic(over)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });

    const at = await legacyJob("TKT-public-300", "y".repeat(300));
    await expect(startPublic(at)).resolves.toMatchObject({ outcome: "started" });
  });

  it("still refuses below the shared 15-character floor for PUBLIC", async () => {
    const jobId = await legacyJob("TKT-public-short", "Disk full");
    await expect(startPublic(jobId)).rejects.toMatchObject({ code: "LIVE_RUN_CONTEXT_INVALID" });
  });

  it("consumes no visitor-day row and no budget row on a PUBLIC eligibility refusal", async () => {
    const jobId = await legacyJob("TKT-public-refused-side-effects", "y".repeat(301));

    await expect(startPublic(jobId)).rejects.toBeInstanceOf(LiveRunAdmissionError);

    await expectNoPaidSideEffect(jobId);
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM live_run_visitor_usage`;
    expect(row?.count ?? 0n).toBe(0n);
  });
});
