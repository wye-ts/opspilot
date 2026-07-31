import { randomUUID } from "node:crypto";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  createJob,
  currentBudgetDate,
  createPrismaClient,
  type PrismaClient,
  type PrismaClientHandle,
} from "@opspilot/database";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { requestIdMiddleware } from "../src/common/request-id.middleware";

/**
 * AUTHENTICATED SAME-KEY REPLAY WHEN NEW-RUN SPEND ADMISSION IS CLOSED.
 *
 * The defect this file pins down: admission steps 2–7 ran as one block, so a
 * request could not be RECOGNIZED as a repeat until after every gate governing
 * NEW spending had already let it through. The documented 200 replay was
 * therefore unreachable in exactly the situations it exists for — and the worst
 * of them was self-inflicted:
 *
 *   the original request consumes the day's final reservation (or fails to
 *   reconcile, latching the day) -> its response is lost -> the recovery repeats
 *   the same key -> the advisory budget gate refuses at step 6, before any
 *   lookup -> the run that already exists can never be handed back
 *
 * The same held for an exhausted rate window.
 *
 * Every case below closes one gate for real — a committed `live_run_budget` row,
 * a genuinely consumed rate window — and asserts that a retained key still
 * recovers its run, while a NEW key against the identical closed gate is refused
 * with exactly the code it always was.
 *
 * NO PROVIDER IS EVER REACHED. Every request in this file is arranged so that is
 * a property of the code path rather than of luck: a replay returns before any
 * provider is constructed, and every new-key request is aimed at a closed gate or
 * at a job today's input rules refuse. The `afterEach` guard reads the one
 * counter that cannot be bypassed — a provider call is impossible without a
 * committed reservation, because the reservation is taken inside the
 * authoritative transaction and the provider is only built after it commits.
 */

const PLACEHOLDER_KEY = "sk-ant-test-do-not-use-0123456789";
const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";
const TOKEN_HEADER = "X-OpsPilot-Demo-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

const STORED_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "s",
  rootCause: "r",
  customerImpact: "c",
  recommendedResolution: "rr",
  confidence: 0.5,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "f" }],
  suggestedActions: [],
};

const UNAVAILABLE_MESSAGE =
  "PostgreSQL test database is unreachable. Run:\n" +
  "  pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:test\n" +
  "then re-run the integration tests.";

async function createTestPrismaClient(): Promise<PrismaClientHandle> {
  const handle = createPrismaClient();
  try {
    await handle.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw new Error(UNAVAILABLE_MESSAGE, { cause: error });
  }
  return handle;
}

const LIVE_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_MAX_RETRIES: "0",
  LIVE_AGENT_RUNS_ENABLED: "true",
  LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
  // ONE run per UTC day, so a single seeded reservation genuinely closes the day
  // rather than merely nudging a counter.
  LIVE_RUN_DAILY_LIMIT: "1",
  LIVE_RUN_DAILY_COST_CEILING_USD: "1.00",
  // Comfortable for the budget/latch cases, which send several requests each.
  // The rate-limit case builds its OWN app at max=1 — see below.
  LIVE_RUN_RATE_LIMIT_MAX: "60",
};

let handle: PrismaClientHandle;
let prisma: PrismaClient;
let app: NestExpressApplication;
const originalEnv = new Map<string, string | undefined>();

/**
 * Builds a fully wired app on the shared Prisma handle.
 *
 * Takes env overrides because the rate limiter is per-INSTANCE state with a
 * 60-second window: exhausting it in one test would leave it exhausted for every
 * later test in the file. A dedicated instance at `LIVE_RUN_RATE_LIMIT_MAX=1`
 * keeps that case exact and keeps it local.
 */
async function createApp(envOverrides: Record<string, string> = {}): Promise<NestExpressApplication> {
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envOverrides)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(handle, async () => undefined)],
    }).compile();

    const created = moduleRef.createNestApplication<NestExpressApplication>({
      abortOnError: false,
      logger: false,
      bodyParser: false,
    });
    created.use(requestIdMiddleware);
    created.use(jsonBodyParser);
    created.use(jsonParserErrorHandler);
    created.setGlobalPrefix("v1");
    created.useGlobalFilters(new AllExceptionsFilter());
    created.useGlobalInterceptors(new LoggingInterceptor());
    await created.init();
    return created;
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(LIVE_ENV)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  handle = await createTestPrismaClient();
  prisma = handle.prisma;
  app = await createApp();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Reservations this test DELIBERATELY seeded, which are not spend.
 *
 * The guard below cannot simply assert "no reservation exists", because closing
 * the day for real means committing a `live_run_budget` row. So a seeding helper
 * declares what it wrote, and the guard asserts the counter did not move BEYOND
 * it — which is still the exact question that matters: did any request in this
 * file reserve, and therefore possibly spend?
 */
let seededReservations = 0;

async function reservedToday(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ reserved: bigint }[]>`
    SELECT COALESCE(sum(runs_reserved), 0)::bigint AS reserved FROM live_run_budget`;
  return Number(row?.reserved ?? 0n);
}

afterEach(async () => {
  const reserved = await reservedToday();
  const expected = seededReservations;
  seededReservations = 0;

  await prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
  await prisma.$executeRaw`DELETE FROM live_run_budget`;

  expect(
    reserved,
    "a LIVE reservation was committed beyond what this test seeded — this suite must never execute a paid run",
  ).toBe(expected);
});

function post(server: unknown, jobId: string) {
  return request(server as never).post(`/v1/agent-jobs/${jobId}/runs`);
}

function live(server: unknown, jobId: string, key: string) {
  return post(server, jobId)
    .set(TOKEN_HEADER, DEMO_TOKEN)
    .set(IDEMPOTENCY_HEADER, key)
    .send({ providerMode: "LIVE" });
}

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `Replay-ordering coverage for ${ticketId}` });
}

/** A job today's `POST /v1/agent-jobs` would refuse, written the way history did. */
async function legacyJob(ticketId: string): Promise<string> {
  const context = JSON.stringify({ ticketId, summary: "short" });
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_jobs (ticket_context, external_ticket_id)
    VALUES (${context}::jsonb, ${ticketId})
    RETURNING id`;
  return row!.id;
}

/**
 * The durable state a lost response leaves behind: a LIVE run that already
 * exists for a key. Inserted directly, precisely so no test here has to execute
 * a paid run to reach the replay path.
 */
async function existingLiveRun(
  jobId: string,
  clientRequestId: string,
  status: "RUNNING" | "COMPLETED" | "FAILED" = "RUNNING",
) {
  const report = status === "COMPLETED" ? JSON.stringify(STORED_REPORT) : null;
  const failureCode = status === "FAILED" ? "PROVIDER_TIMEOUT" : null;
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_runs
      (job_id, attempt_number, status, provider_mode, model_identifier, started_at,
       finished_at, report, failure_code, client_request_id)
    VALUES
      (${jobId}::uuid, 1, ${status}, 'LIVE', 'claude-sonnet-5', now(),
       ${status === "RUNNING" ? null : new Date()},
       ${report}::jsonb, ${failureCode}, ${clientRequestId}::uuid)
    RETURNING id`;
  return row!.id;
}

/**
 * Closes today's budget the way a finished run closes it: one reservation, one
 * completion, and the daily limit of 1 reached.
 */
async function exhaustTodaysBudget() {
  await prisma.$executeRaw`
    INSERT INTO live_run_budget
      (budget_date, runs_reserved, runs_completed, estimated_cost_nano_usd, pricing_unknown_runs, updated_at)
    VALUES (${currentBudgetDate()}::date, 1, 1, 17956000, 0, now())`;
  seededReservations += 1;
}

/**
 * Latches today the way a FAILED RECONCILIATION latches it: a reservation that
 * was never completed, so `runs_reserved > runs_completed` and every gate that
 * reads the row refuses.
 *
 * This is the state an ambiguous failure actually produces, which is why it must
 * not be able to block the recovery from that same failure.
 */
async function latchToday() {
  await prisma.$executeRaw`
    INSERT INTO live_run_budget
      (budget_date, runs_reserved, runs_completed, estimated_cost_nano_usd, pricing_unknown_runs, updated_at)
    VALUES (${currentBudgetDate()}::date, 1, 0, 0, 0, now())`;
  seededReservations += 1;
}

async function budgetRow() {
  const [row] = await prisma.$queryRaw<
    { runsReserved: number; runsCompleted: number; estimatedCostNanoUsd: bigint }[]
  >`
    SELECT runs_reserved AS "runsReserved", runs_completed AS "runsCompleted",
           estimated_cost_nano_usd AS "estimatedCostNanoUsd"
    FROM live_run_budget WHERE budget_date = ${currentBudgetDate()}::date`;
  return row;
}

function runCount(jobId: string) {
  return prisma.agentRun.count({ where: { jobId } });
}

describe("an exhausted daily budget", () => {
  it("still replays the retained key with 200", async () => {
    const job = await newJob("TKT-replay-budget");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);
    await exhaustTodaysBudget();

    const response = await live(app.getHttpServer(), job.id, key).expect(200);

    // The run the original attempt created, handed back for free — by the very
    // day its own reservation closed.
    expect(response.body.data.run.id).toBe(runId);
    expect(response.headers.location).toBe(`/v1/agent-runs/${runId}`);
    expect(await runCount(job.id)).toBe(1);
  });

  it("leaves the budget row byte-identical", async () => {
    const job = await newJob("TKT-replay-budget-untouched");
    const key = randomUUID();
    await existingLiveRun(job.id, key);
    await exhaustTodaysBudget();
    const before = await budgetRow();

    await live(app.getHttpServer(), job.id, key).expect(200);

    // No reservation, no completion, no cost. A replay is free in the ledger as
    // well as in the provider.
    expect(await budgetRow()).toEqual(before);
  });

  it("replays repeatedly without ever reserving", async () => {
    const job = await newJob("TKT-replay-budget-repeat");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);
    await exhaustTodaysBudget();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await live(app.getHttpServer(), job.id, key).expect(200);
      expect(response.body.data.run.id).toBe(runId);
    }

    expect(await runCount(job.id)).toBe(1);
  });

  it("still refuses a NEW key with 429 LIVE_RUN_BUDGET_EXHAUSTED", async () => {
    // The other half of the guarantee. Recovery got cheaper; starting did not.
    const job = await newJob("TKT-replay-budget-new-key");
    await existingLiveRun(job.id, randomUUID());
    await exhaustTodaysBudget();

    const response = await live(app.getHttpServer(), job.id, randomUUID()).expect(429);

    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
    expect(await runCount(job.id)).toBe(1);
  });

  it.each(["RUNNING", "COMPLETED", "FAILED"] as const)(
    "replays a %s run identically",
    async (status) => {
      const job = await newJob(`TKT-replay-budget-${status}`);
      const key = randomUUID();
      const runId = await existingLiveRun(job.id, key, status);
      await exhaustTodaysBudget();

      const response = await live(app.getHttpServer(), job.id, key).expect(200);

      // A RUNNING replay is the NORMAL answer here: the provider executed and
      // finalization failed. Status is never what decides a replay.
      expect(response.body.data.run.id).toBe(runId);
      expect(response.body.data.run.status).toBe(status);
    },
  );
});

describe("a day latched by an unreconciled reservation", () => {
  it("still replays the retained key with 200", async () => {
    const job = await newJob("TKT-replay-latch");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);
    await latchToday();

    const response = await live(app.getHttpServer(), job.id, key).expect(200);

    expect(response.body.data.run.id).toBe(runId);
  });

  it("leaves the latch exactly as it was", async () => {
    const job = await newJob("TKT-replay-latch-untouched");
    const key = randomUUID();
    await existingLiveRun(job.id, key);
    await latchToday();
    const before = await budgetRow();

    await live(app.getHttpServer(), job.id, key).expect(200);

    expect(await budgetRow()).toEqual(before);
    expect(before?.runsReserved).toBe(1);
    expect(before?.runsCompleted).toBe(0);
  });

  it("still refuses a NEW key with 429", async () => {
    const job = await newJob("TKT-replay-latch-new-key");
    await existingLiveRun(job.id, randomUUID());
    await latchToday();

    const response = await live(app.getHttpServer(), job.id, randomUUID()).expect(429);

    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
  });
});

describe("authorization still comes first", () => {
  it("refuses an unauthenticated replay with 401, even with the budget closed", async () => {
    const job = await newJob("TKT-replay-unauth");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);
    await exhaustTodaysBudget();

    const response = await post(app.getHttpServer(), job.id)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(401);

    // 401 rather than 200 or 429: idempotency is not an authentication bypass,
    // and the response leaks nothing about whether the key names anything.
    expect(response.body.error.code).toBe("LIVE_RUN_ACCESS_DENIED");
    expect(JSON.stringify(response.body)).not.toContain(runId);
  });

  it("gives a wrong token the same 401 whether or not the key exists", async () => {
    const job = await newJob("TKT-replay-unauth-oracle");
    const key = randomUUID();
    await existingLiveRun(job.id, key);

    const withKnownKey = await post(app.getHttpServer(), job.id)
      .set(TOKEN_HEADER, "not-the-token")
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(401);
    const withUnknownKey = await post(app.getHttpServer(), job.id)
      .set(TOKEN_HEADER, "not-the-token")
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(401);

    // Byte-identical apart from the request id: an unauthenticated caller cannot
    // use the endpoint to probe which keys exist.
    expect(withKnownKey.body.error.code).toBe(withUnknownKey.body.error.code);
    expect(withKnownKey.body.error.message).toBe(withUnknownKey.body.error.message);
  });

  it("refuses a malformed key with 400 before the lookup", async () => {
    const job = await newJob("TKT-replay-bad-key");
    await existingLiveRun(job.id, randomUUID());
    await exhaustTodaysBudget();

    const response = await post(app.getHttpServer(), job.id)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, "not-a-uuid")
      .send({ providerMode: "LIVE" })
      .expect(400);

    expect(response.body.error.code).toBe("LIVE_RUN_IDEMPOTENCY_KEY_INVALID");
  });

  it("answers 404 for a job that does not exist, reserving nothing", async () => {
    const response = await live(app.getHttpServer(), randomUUID(), randomUUID()).expect(404);

    // The same code the authoritative transaction produces for the same cause —
    // one contract, whichever step met it.
    expect(response.body.error.code).toBe("AGENT_JOB_NOT_FOUND");
  });
});

describe("a legacy job whose context today's rules refuse", () => {
  it("still replays an existing run for it, with the budget closed", async () => {
    const jobId = await legacyJob("TKT-replay-legacy");
    const key = randomUUID();
    const runId = await existingLiveRun(jobId, key);
    await exhaustTodaysBudget();

    // Two gates closed at once — spend admission AND eligibility — and the run
    // that already exists is still recoverable. A rule about what may START
    // cannot change what a finished run cost.
    const response = await live(app.getHttpServer(), jobId, key).expect(200);
    expect(response.body.data.run.id).toBe(runId);
  });
});

/**
 * The rate window, on its OWN app instance at max=1.
 *
 * The limiter is per-instance in-memory state with a 60-second window, so
 * exhausting it on the shared app would leave every later test in this file
 * facing a limiter it did not ask for. A dedicated instance keeps the case exact
 * and keeps it local.
 */
describe("an exhausted per-client rate window", () => {
  let limited: NestExpressApplication;

  beforeAll(async () => {
    limited = await createApp({ LIVE_RUN_RATE_LIMIT_MAX: "1" });
  });

  afterAll(async () => {
    await limited?.close();
  });

  it("still replays the retained key with 200, and does not consume the window", async () => {
    const job = await newJob("TKT-replay-rate");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);
    // One new-key request against an ineligible job: refused at 422, but only
    // AFTER consuming the window at step 5. The window is now closed.
    const ineligible = await legacyJob("TKT-replay-rate-consumer");
    await live(limited.getHttpServer(), ineligible, randomUUID()).expect(422);

    // Four recoveries in a row, all 200. Under the old ordering the first would
    // have been 429.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await live(limited.getHttpServer(), job.id, key).expect(200);
      expect(response.body.data.run.id).toBe(runId);
    }

    // And a NEW key is still refused — proving the four replays neither consumed
    // the window nor reopened it.
    const refused = await live(limited.getHttpServer(), job.id, randomUUID()).expect(429);
    expect(refused.body.error.code).toBe("LIVE_RUN_RATE_LIMITED");
    expect(await runCount(job.id)).toBe(1);
  });
});
