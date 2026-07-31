import { randomUUID } from "node:crypto";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  createJob,
  createPrismaClient,
  reconcileLiveRunBudget,
  startLiveRunWithAttemptLimit,
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
 * The fail-closed latch, proven through the REAL HTTP stack and the REAL
 * repository — not a mocked budget read returning false.
 *
 * The defect: a LIVE reservation commits before the provider runs, and
 * reconciliation adds the cost afterwards. When reconciliation failed, the
 * controller correctly preserved the run's response and released the lease, but
 * the durable row was left with runs_reserved > runs_completed and cost figures
 * missing a run that had already executed. The day stayed OPEN, so subsequent
 * admissions were gated on figures known to be stale — the observed-estimate
 * cost gate failed open, with only the hard daily run COUNT left to stop it.
 *
 * These tests leave a genuine unreconciled reservation in PostgreSQL and then
 * drive real requests at the running application. The unit suite
 * (agent-runs.controller.test.ts) already covers the other half — that a
 * throwing reconciliation does not replace the response or strand the lease;
 * what could not be proven there is that the DURABLE row then closes the day.
 *
 * NO PROVIDER IS EVER REACHED. Every LIVE request below is refused at admission
 * step 6 (the budget pre-check), which runs before the concurrency lease, before
 * the authoritative transaction, and long before any Anthropic object is
 * invoked. The configured key is a placeholder and no network call is made.
 */

const PLACEHOLDER_KEY = "sk-ant-test-do-not-use-0123456789";
const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";
const TOKEN_HEADER = "X-OpsPilot-Demo-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

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

/**
 * The environment a SERVABLE deployment runs in: capability present, kill switch
 * on, token configured, SDK retries forbidden.
 *
 * Set on process.env because parseRunExecutionConfig reads it once at module
 * instantiation. Captured and restored afterwards so no other suite inherits a
 * live-capable configuration.
 */
const LIVE_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_MAX_RETRIES: "0",
  LIVE_AGENT_RUNS_ENABLED: "true",
  LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
  // Deliberately generous, so nothing below can be refused by the run count or
  // the cost ceiling. The latch has to be the only thing that closes the day.
  LIVE_RUN_DAILY_LIMIT: "10",
  LIVE_RUN_DAILY_COST_CEILING_USD: "1.00",
  // The rate limiter is per process and shared across these tests; raised so a
  // sequence of requests in one suite is not refused at step 5 instead of 6.
  LIVE_RUN_RATE_LIMIT_MAX: "60",
};

let app: NestExpressApplication;
let handle: PrismaClientHandle;
let prisma: PrismaClient;
const originalEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [key, value] of Object.entries(LIVE_ENV)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  handle = await createTestPrismaClient();
  prisma = handle.prisma;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(handle, async () => undefined)],
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    abortOnError: false,
    logger: false,
    bodyParser: false,
  });
  app.use(requestIdMiddleware);
  app.use(jsonBodyParser);
  app.use(jsonParserErrorHandler);
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
  await prisma.$executeRaw`DELETE FROM live_run_budget`;
});

/** Today's UTC budget date, matching what admission captures. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `Latch coverage for ${ticketId}` });
}

/**
 * Leaves a genuine, unreconciled reservation on today's row — the exact durable
 * state a failed reconciliation produces.
 */
async function leaveUnreconciledReservation() {
  const job = await newJob(`TKT-latch-${Math.random().toString(36).slice(2, 10)}`);
  const started = await startLiveRunWithAttemptLimit(prisma, {
    jobId: job.id,
    modelIdentifier: "claude-sonnet-5",
    maxLiveAttempts: 5,
    budget: { budgetDate: todayUtc(), dailyLimit: 10, costCeilingNanoUsd: 1_000_000_000n },
    // A fresh key per call: this helper is used to leave SEVERAL independent
    // reservations, and a shared key would make every call after the first an
    // idempotent replay that reserved nothing.
    clientRequestId: randomUUID(),
  });
  if (started.outcome !== "started") {
    throw new Error("expected a started run");
  }
  return started;
}

async function budgetRow() {
  const [row] = await prisma.$queryRaw<
    { runsReserved: number; runsCompleted: number; estimatedCostNanoUsd: bigint }[]
  >`
    SELECT runs_reserved AS "runsReserved", runs_completed AS "runsCompleted",
           estimated_cost_nano_usd AS "estimatedCostNanoUsd"
    FROM live_run_budget WHERE budget_date = ${todayUtc()}::date`;
  return row;
}

describe("an unreconciled reservation closes LIVE admission over HTTP", () => {
  it("serves LIVE as AVAILABLE while the day is clean", async () => {
    // The control. Without this, a test asserting UNAVAILABLE later proves
    // nothing — the deployment might simply never have been servable.
    const response = await request(app.getHttpServer()).get("/v1/capabilities").expect(200);

    expect(response.body).toEqual({
      data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" },
    });
  });

  it("refuses a LIVE run with 429 while a reservation is outstanding", async () => {
    await leaveUnreconciledReservation();
    const job = await newJob("TKT-latch-http-refused");

    const response = await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${job.id}/runs`)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      // A fresh key: each of these is a genuinely new request, so none of them
      // should replay another's run.
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(429);

    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
  });

  it("creates no AgentRun and consumes no further reservation for the refused request", async () => {
    await leaveUnreconciledReservation();
    const job = await newJob("TKT-latch-http-norun");

    await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${job.id}/runs`)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      // A fresh key: each of these is a genuinely new request, so none of them
      // should replay another's run.
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(429);

    // No run for the refused job — so no provider was constructed or invoked for
    // it either; the refusal happens before either could occur.
    expect(await prisma.agentRun.count({ where: { jobId: job.id } })).toBe(0);
    const row = await budgetRow();
    expect(row?.runsReserved).toBe(1);
    expect(row?.runsCompleted).toBe(0);
  });

  it("reports UNAVAILABLE from /v1/capabilities, with no accounting detail", async () => {
    await leaveUnreconciledReservation();

    const response = await request(app.getHttpServer()).get("/v1/capabilities").expect(200);

    // Byte-identical to every other unavailable reason: a caller cannot tell an
    // unreconciled reservation from an exhausted count, a crossed ceiling, or
    // unknown pricing.
    expect(response.body).toEqual({
      data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" },
    });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/runsReserved|runsCompleted|runs_reserved|runs_completed/i);
    expect(serialized).not.toMatch(/reconcil/i);
    expect(serialized).not.toMatch(/\d/);
  });

  it("keeps the refusal opaque in the error envelope too", async () => {
    await leaveUnreconciledReservation();
    const job = await newJob("TKT-latch-http-opaque");

    const response = await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${job.id}/runs`)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      // A fresh key: each of these is a genuinely new request, so none of them
      // should replay another's run.
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(429);

    // The same message an exhausted daily count produces. No counter, no
    // reconciliation hint, and no credential.
    expect(response.body.error.message).toBe(
      "The live agent run allowance for today has been used. The deterministic demo remains available.",
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/reconcil|runs_|unreconciled/i);
    expect(serialized).not.toContain(PLACEHOLDER_KEY);
    expect(serialized).not.toContain(DEMO_TOKEN);
  });

  it("reopens once the reservation is reconciled", async () => {
    const started = await leaveUnreconciledReservation();
    await request(app.getHttpServer()).get("/v1/capabilities").expect(200);

    await reconcileLiveRunBudget(prisma, started.reservation, {
      providerCallsObserved: 2,
      inputTokens: 1_200,
      outputTokens: 400,
      estimatedCostNanoUsd: 17_956_000n,
      pricingStatus: "CURRENT",
      possibleUnobservedCost: false,
    });

    const response = await request(app.getHttpServer()).get("/v1/capabilities").expect(200);
    expect(response.body).toEqual({
      data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" },
    });

    // The row is level again, and the cost the run actually incurred is now
    // recorded — which is what makes the ceiling meaningful for the next run.
    const row = await budgetRow();
    expect(row?.runsReserved).toBe(row?.runsCompleted);
    expect(row?.estimatedCostNanoUsd).toBe(17_956_000n);
  });

  it("leaves the deterministic FAKE demo completely unaffected", async () => {
    // The public demo must keep working through any live-budget state — that is
    // the whole point of the deterministic path.
    await leaveUnreconciledReservation();
    const job = await newJob("TKT-latch-http-fake");

    const response = await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${job.id}/runs`)
      .send({ providerMode: "FAKE" })
      .expect(201);

    expect(response.body.data.run.providerMode).toBe("FAKE");
    // And FAKE contributed nothing to the budget row.
    expect((await budgetRow())?.runsReserved).toBe(1);
  });
});
