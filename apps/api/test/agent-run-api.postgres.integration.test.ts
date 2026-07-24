import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createPrismaClient, type PrismaClientHandle } from "@opspilot/database";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { requestIdMiddleware } from "../src/common/request-id.middleware";

// Real-PostgreSQL API integration suite: real PrismaClientHandle, real
// PrismaModule, real AgentRunService, real FakeLlmProvider (via the
// deterministic provider factory), real InMemoryToolRegistry, real
// controllers, real HTTP stack — see docs/12-agent-run-api.md. Shares the
// same physical test database as packages/database's own integration
// suite; both must run sequentially (test:integration:sequential).
//
// createTestPrismaClient/truncateAllTables (packages/database/src/test/
// test-db.ts) are internal to that package's own test suite, not part of
// its public "." export — so this suite builds the equivalent preflight/
// truncate behavior directly from the publicly exported createPrismaClient,
// rather than reaching into @opspilot/database's internals or widening its
// public API for a PR2-only need.
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

async function truncateAllTables(handle: PrismaClientHandle): Promise<void> {
  await handle.prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events RESTART IDENTITY CASCADE`;
}

interface TestApp {
  readonly app: NestExpressApplication;
  readonly handle: PrismaClientHandle;
}

async function createTestApiApp(): Promise<TestApp> {
  const handle = await createTestPrismaClient();
  const safeClose = async (): Promise<void> => {
    await handle.close();
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(handle, safeClose)],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
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
  return { app, handle };
}

let controlHandle: PrismaClientHandle;

beforeAll(async () => {
  controlHandle = await createTestPrismaClient();
});

afterAll(async () => {
  await controlHandle.close();
});

afterEach(async () => {
  await truncateAllTables(controlHandle);
});

describe("persistence boundary", () => {
  it("commits App A's writes durably — visible to a freshly created App B with its own Prisma client and pg pool", async () => {
    const appA = await createTestApiApp();

    const jobRes = await request(appA.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-BOUNDARY-1", summary: "billing outage impacting customers" });
    expect(jobRes.status).toBe(201);
    const jobId = jobRes.body.data.id as string;

    const runRes = await request(appA.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send();
    expect(runRes.status).toBe(201);
    const runId = runRes.body.data.run.id as string;

    // Closes App A entirely — its Nest app, Prisma client, and pg pool.
    await appA.app.close();

    const appB = await createTestApiApp();
    try {
      const jobReadback = await request(appB.app.getHttpServer()).get(`/v1/agent-jobs/${jobId}`);
      expect(jobReadback.status).toBe(200);
      expect(jobReadback.body.data.id).toBe(jobId);
      expect(jobReadback.body.data.runs).toEqual([
        expect.objectContaining({ id: runId, attemptNumber: 1, status: "COMPLETED" }),
      ]);

      const runReadback = await request(appB.app.getHttpServer()).get(`/v1/agent-runs/${runId}`);
      expect(runReadback.status).toBe(200);
      expect(runReadback.body.data.run.status).toBe("COMPLETED");
      expect(runReadback.body.data.outcome.type).toBe("COMPLETED");
      expect(runReadback.body.data.trace.length).toBeGreaterThan(0);
    } finally {
      await appB.app.close();
    }
  });
});

describe("job read model", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApiApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it("returns run summaries ordered by attemptNumber ASC after repeated POST run calls", async () => {
    const jobRes = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-MULTI-RUN", summary: "auth failures spiking" });
    const jobId = jobRes.body.data.id as string;

    const run1 = await request(testApp.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send();
    const run2 = await request(testApp.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send();
    expect(run1.status).toBe(201);
    expect(run2.status).toBe(201);
    // The deterministic provider factory reuses the same job-scoped
    // toolCallId for both runs — valid because tool-call identity is scoped
    // per persisted run, not globally unique.
    expect(run1.body.data.trace[0].toolCallId).toBe(run2.body.data.trace[0].toolCallId);

    const jobReadback = await request(testApp.app.getHttpServer()).get(`/v1/agent-jobs/${jobId}`);
    expect(jobReadback.status).toBe(200);
    expect(jobReadback.body.data.runs.map((r: { attemptNumber: number }) => r.attemptNumber)).toEqual([1, 2]);
    expect(jobReadback.body.data.runs.map((r: { id: string }) => r.id)).toEqual([
      run1.body.data.run.id,
      run2.body.data.run.id,
    ]);
  });

  it("returns 404 AGENT_JOB_NOT_FOUND for an unknown job id", async () => {
    const res = await request(testApp.app.getHttpServer()).get("/v1/agent-jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_JOB_NOT_FOUND");
  });

  it("returns 404 AGENT_RUN_NOT_FOUND for an unknown run id", async () => {
    const res = await request(testApp.app.getHttpServer()).get("/v1/agent-runs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_RUN_NOT_FOUND");
  });

  it("allows duplicate ticketId submissions, creating separate jobs", async () => {
    const first = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-DUP", summary: "first" });
    const second = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-DUP", summary: "second" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });
});
