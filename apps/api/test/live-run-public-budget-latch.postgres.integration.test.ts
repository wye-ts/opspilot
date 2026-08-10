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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { requestIdMiddleware } from "../src/common/request-id.middleware";

/**
 * Issue #39 — the PUBLIC sub-ceiling latch, proven through the REAL HTTP
 * stack and the REAL repository, mirroring live-run-budget-latch.postgres.
 * integration.test.ts's approach for the private path.
 *
 * NO REAL CLOUDFLARE CALL: `global.fetch` is stubbed for the whole suite to
 * always report a successful Turnstile verification, so every request below
 * reaches the durable admission gate without ever leaving the process.
 *
 * NO PROVIDER IS EVER REACHED. Every PUBLIC request below is refused at
 * admission before the concurrency lease, before the authoritative
 * transaction, and long before any Anthropic object is invoked.
 */

const TURNSTILE_SECRET = "turnstile-secret-do-not-use-1f14e45fceea";
const TURNSTILE_SITE_KEY = "turnstile-site-key-do-not-use";
const VISITOR_SECRET = "visitor-secret-do-not-use-9f14e45fceea";
const TURNSTILE_TOKEN_HEADER = "X-OpsPilot-Turnstile-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

const PLACEHOLDER_KEY = "sk-ant-test-do-not-use-0123456789";

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
 * The PUBLIC-servable environment: capability present, kill switch on, NO
 * private token, the public-trial flag on with all three secrets. Generous
 * overall and public limits so nothing below is refused by count/cost alone
 * — each test sets up EXACTLY the condition it exercises.
 */
const PUBLIC_TRIAL_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_MAX_RETRIES: "0",
  LIVE_AGENT_RUNS_ENABLED: "true",
  LIVE_PUBLIC_TRIAL_ENABLED: "true",
  TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
  TURNSTILE_SITE_KEY,
  LIVE_PUBLIC_TRIAL_VISITOR_SECRET: VISITOR_SECRET,
  LIVE_RUN_DAILY_LIMIT: "50",
  LIVE_RUN_DAILY_COST_CEILING_USD: "5.00",
  LIVE_RUN_RATE_LIMIT_MAX: "60",
};

let app: NestExpressApplication;
let handle: PrismaClientHandle;
let prisma: PrismaClient;
const originalEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [key, value] of Object.entries(PUBLIC_TRIAL_ENV)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  // MUST be stubbed BEFORE the app is built: run-execution.module.ts's DI
  // factory calls createTurnstileVerifier(secretKey) exactly once, during
  // app.init() below, and its `fetchImpl` default parameter captures
  // whatever `fetch` resolves to AT THAT CALL — not on every future
  // `.verify()`. Stubbing later would have no effect on the already-built
  // verifier and this suite would silently start making real HTTPS calls.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as unknown as Response),
  );

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
  vi.unstubAllGlobals();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
  await prisma.$executeRaw`DELETE FROM live_run_budget`;
  await prisma.$executeRaw`DELETE FROM live_run_visitor_usage`;
});

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `Public latch coverage for ${ticketId}` });
}

/** One committed, RECONCILED PUBLIC reservation — leaves no latch behind. */
async function reserveAndReconcilePublic(overrides: { readonly costNanoUsd?: bigint } = {}) {
  const job = await newJob(`TKT-public-${randomUUID().slice(0, 8)}`);
  const started = await startLiveRunWithAttemptLimit(prisma, {
    jobId: job.id,
    modelIdentifier: "claude-sonnet-5",
    maxLiveAttempts: 5,
    budget: { budgetDate: todayUtc(), dailyLimit: 50, costCeilingNanoUsd: 5_000_000_000n },
    clientRequestId: randomUUID(),
    publicTrial: {
      visitorId: randomUUID(),
      publicDailyLimit: 5,
      publicCostCeilingNanoUsd: 500_000_000n,
    },
  });
  if (started.outcome !== "started") throw new Error("expected a started run");

  await reconcileLiveRunBudget(prisma, started.reservation, {
    providerCallsObserved: 1,
    inputTokens: 100,
    outputTokens: 100,
    estimatedCostNanoUsd: overrides.costNanoUsd ?? 1_000_000n,
    pricingStatus: "CURRENT",
    possibleUnobservedCost: false,
  });
  return started;
}

/** A committed but UNRECONCILED reservation — the fail-closed latch. */
async function leaveUnreconciledReservation(isPublic: boolean) {
  const job = await newJob(`TKT-latch-${randomUUID().slice(0, 8)}`);
  const started = await startLiveRunWithAttemptLimit(prisma, {
    jobId: job.id,
    modelIdentifier: "claude-sonnet-5",
    maxLiveAttempts: 5,
    budget: { budgetDate: todayUtc(), dailyLimit: 50, costCeilingNanoUsd: 5_000_000_000n },
    clientRequestId: randomUUID(),
    ...(isPublic
      ? { publicTrial: { visitorId: randomUUID(), publicDailyLimit: 5, publicCostCeilingNanoUsd: 500_000_000n } }
      : {}),
  });
  if (started.outcome !== "started") throw new Error("expected a started run");
  return started;
}

async function postPublicRun(jobId: string) {
  return request(app.getHttpServer())
    .post(`/v1/agent-jobs/${jobId}/runs`)
    .set(TURNSTILE_TOKEN_HEADER, "solved-token")
    .set(IDEMPOTENCY_HEADER, randomUUID())
    .send({ providerMode: "LIVE" });
}

/**
 * Captures the "live_run_admission" console.log line(s) emitted during
 * `action`, filtering out the unrelated per-request access log line
 * LoggingInterceptor also writes to console.log.
 */
async function captureAdmissionLogLines<T>(action: () => Promise<T>): Promise<{ result: T; lines: unknown[] }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const result = await action();
    const lines = spy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line));
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is { event: string } => parsed !== null && parsed.event === "live_run_admission");
    return { result, lines };
  } finally {
    spy.mockRestore();
  }
}

describe("PUBLIC trial: public_runs_reserved hits publicDailyLimit", () => {
  it("denies further PUBLIC reservations once the public count is exhausted", async () => {
    for (let i = 0; i < 5; i += 1) {
      await reserveAndReconcilePublic();
    }
    const job = await newJob("TKT-public-count-exhausted");

    const response = await postPublicRun(job.id);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
  });

  it("leaves PRIVATE unaffected by the PUBLIC count alone — the overall limit is what governs it", async () => {
    // 5 reconciled PUBLIC runs close the PUBLIC sub-ceiling, but the overall
    // day (dailyLimit 50) still has room, and there is no private token
    // configured on this deployment to exercise directly — so the proof here
    // is that the OVERALL runs_reserved count (5) is nowhere near dailyLimit,
    // meaning a hypothetical private request would not be refused by count.
    for (let i = 0; i < 5; i += 1) {
      await reserveAndReconcilePublic();
    }

    const [row] = await prisma.$queryRaw<{ runsReserved: number; publicRunsReserved: number }[]>`
      SELECT runs_reserved AS "runsReserved", public_runs_reserved AS "publicRunsReserved"
      FROM live_run_budget WHERE budget_date = ${todayUtc()}::date`;
    expect(row?.publicRunsReserved).toBe(5);
    expect(row?.runsReserved).toBeLessThan(50);
  });
});

describe("PUBLIC trial: public_estimated_cost_nano_usd crosses publicCostCeilingNanoUsd", () => {
  it("denies further PUBLIC reservations once the public cost ceiling is crossed", async () => {
    // One reconciled PUBLIC run at $0.60 crosses the $0.50 ceiling by itself.
    await reserveAndReconcilePublic({ costNanoUsd: 600_000_000n });
    const job = await newJob("TKT-public-cost-exhausted");

    const response = await postPublicRun(job.id);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
  });

  it("is gated by the SAME shared latch as the overall ceiling, not a separate one", async () => {
    // An unreconciled reservation (private-shaped, no publicTrial) latches
    // the whole day via the shared runs_completed = runs_reserved condition
    // — proving there is no independent "public latch" bypassable by a
    // request that never touches the public columns.
    await leaveUnreconciledReservation(false);
    const job = await newJob("TKT-public-shared-latch");

    const response = await postPublicRun(job.id);

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("LIVE_RUN_BUDGET_EXHAUSTED");
  });
});

/**
 * Internal rejection classification, HTTP-level half.
 *
 * ONLY the two PUBLIC-specific reasons (5–6) are observable through the real
 * HTTP admission pipeline: the pre-existing #19 advisory pre-check
 * (`isLiveRunBudgetOpen`, run inside `admitNewRun` BEFORE the authoritative
 * transaction) already mirrors the four SHARED conditions (1–4:
 * unreconciled latch, unknown pricing, overall count, overall cost) and
 * therefore intercepts every one of those cases in a serial test — the
 * authoritative transaction's own classification code is deterministically
 * unreachable for them via this pipeline, precisely because the advisory
 * check is doing its documented job of failing an obviously-closed day
 * before a concurrency slot or a transaction is even opened.
 *
 * That is not a gap: it is why `startLiveRunWithAttemptLimit` is tested
 * DIRECTLY, bypassing the advisory layer, for all six reasons and the
 * precedence case where two are simultaneously true — see
 * packages/database/src/repositories/live-run-budget.integration.test.ts's
 * "internal rejection classification" suite. This file proves the two
 * reasons the advisory check cannot pre-empt, end to end through the real
 * server, and that every rejection — whichever of the six closed the gate —
 * renders an identically opaque response to the anonymous caller.
 */
describe("PUBLIC trial: internal rejection classification", () => {
  it("BUDGET_PUBLIC_COUNT_EXHAUSTED — the public count alone, overall count still open", async () => {
    for (let i = 0; i < 5; i += 1) {
      await reserveAndReconcilePublic();
    }
    const job = await newJob("TKT-reason-public-count");

    const { result, lines } = await captureAdmissionLogLines(() => postPublicRun(job.id));

    expect(result.status).toBe(429);
    expect(lines).toEqual([{ event: "live_run_admission", decision: "rejected", code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_PUBLIC_COUNT_EXHAUSTED" }]);
  });

  it("BUDGET_PUBLIC_COST_EXHAUSTED — the public ceiling alone, overall ceiling still open", async () => {
    await reserveAndReconcilePublic({ costNanoUsd: 600_000_000n });
    const job = await newJob("TKT-reason-public-cost");

    const { result, lines } = await captureAdmissionLogLines(() => postPublicRun(job.id));

    expect(result.status).toBe(429);
    expect(lines).toEqual([{ event: "live_run_admission", decision: "rejected", code: "LIVE_RUN_BUDGET_EXHAUSTED", reason: "BUDGET_PUBLIC_COST_EXHAUSTED" }]);
  });

  it("keeps the anonymous-facing response identically opaque across every rejection reason", async () => {
    // Covers all four scenario SHAPES reachable via HTTP: the two the
    // advisory pre-check intercepts before the authoritative transaction
    // (unreconciled latch, unknown pricing — code only, no reason) and the
    // two the authoritative transaction itself classifies (public count,
    // public cost — code AND reason). `requestId` is stripped before
    // comparing: it is a fresh UUID per request by design (requestIdMiddleware)
    // and asserting it away is what makes the REST of each body comparable.
    const scenarios: Array<() => Promise<void>> = [
      async () => {
        await leaveUnreconciledReservation(true);
      },
      async () => {
        const started = await leaveUnreconciledReservation(true);
        await reconcileLiveRunBudget(prisma, started.reservation, {
          providerCallsObserved: 1,
          inputTokens: 10,
          outputTokens: 10,
          estimatedCostNanoUsd: null,
          pricingStatus: "INSUFFICIENT_USAGE_DETAIL",
          possibleUnobservedCost: true,
        });
      },
      async () => {
        for (let i = 0; i < 5; i += 1) await reserveAndReconcilePublic();
      },
      async () => {
        await reserveAndReconcilePublic({ costNanoUsd: 600_000_000n });
      },
    ];

    const bodies: string[] = [];
    for (const setup of scenarios) {
      await prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
      await prisma.$executeRaw`DELETE FROM live_run_budget`;
      await prisma.$executeRaw`DELETE FROM live_run_visitor_usage`;

      await setup();
      const job = await newJob(`TKT-opacity-${randomUUID().slice(0, 8)}`);
      const response = await postPublicRun(job.id);
      expect(response.status).toBe(429);
      bodies.push(JSON.stringify({ ...response.body, error: { ...response.body.error, requestId: "x" } }));
    }

    expect(new Set(bodies).size).toBe(1);
    for (const body of bodies) {
      // The public catalog code LIVE_RUN_BUDGET_EXHAUSTED is expected and
      // fine — what must never leak is one of the six internal REASON
      // classifications, or any raw figure.
      expect(body).not.toMatch(/BUDGET_(LATCH|PRICING|OVERALL|PUBLIC)_|runs_reserved|runsReserved|nanoUsd/i);
    }
  });
});
