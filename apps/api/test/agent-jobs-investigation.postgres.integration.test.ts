import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  appendInvestigationEvent,
  createJob,
  createPrismaClient,
  finalizeCompleted,
  startRun,
  type AgentJobRecord,
  type PrismaClient,
  type PrismaClientHandle,
} from "@opspilot/database";
import type { ResolutionReport } from "@opspilot/contracts";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { requestIdMiddleware } from "../src/common/request-id.middleware";

// Issue #57 Checkpoint C — API/polling/history reconstruction proof. A
// persisted multi-step canonical stream (seeded through the already-public
// @opspilot/database repository functions, exactly like the existing
// agent-run-api.postgres.integration.test.ts fixtures) must be read back
// through the REAL `GET /v1/agent-jobs/:jobId/investigation` endpoint with
// every repeated TOOL_* event intact, in canonical sequence order — never
// dropped, never reordered by type/timestamp, never treated as corruption.
//
// Shares the same physical test database as the other integration suites;
// must only run via the root `test:integration:sequential` chain.

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
  await handle.prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
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

function completedReport(callIds: readonly string[]): ResolutionReport {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "Multi-step diagnostic completed.",
    rootCause: "The bounded diagnostic loop ran to completion.",
    customerImpact: "Impact assessed via repeated diagnostics.",
    recommendedResolution: "Monitor the affected services.",
    confidence: 0.8,
    evidence: callIds.map((callId) => ({
      evidenceId: callId,
      sourceType: "TOOL_EXECUTION",
      finding: `Tool call ${callId} completed successfully.`,
    })),
    suggestedActions: [],
  };
}

/**
 * Seeds a completed run whose canonical stream carries `count` serial
 * TOOL_REQUESTED -> TOOL_COMPLETED pairs. At the reviewed bound
 * (count === MAX_DIAGNOSTIC_TOOL_CALLS) REPORT_GENERATION_STARTED is present
 * (forced finalization); below it, absent (voluntary early report). Written
 * through the public database functions, not raw SQL.
 */
async function createMultiStepCompletedRun(
  prisma: PrismaClient,
  ticketId: string,
  count: number,
): Promise<AgentJobRecord> {
  const job = await createJob(prisma, { ticketId, summary: "Multi-step diagnostic run" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await appendInvestigationEvent(prisma, started.run.id, { type: "AGENT_STARTED" });
  const callIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const callId = `call-${index + 1}`;
    callIds.push(callId);
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: callId,
      toolName: "get_service_status",
    });
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_COMPLETED",
      toolCallId: callId,
      toolName: "get_service_status",
    });
  }
  if (count >= 3) {
    await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_GENERATION_STARTED" });
  }
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_VALIDATED" });
  await finalizeCompleted(prisma, started.run.id, completedReport(callIds));
  return job;
}

describe("issue #57 Checkpoint C — GET /v1/agent-jobs/:jobId/investigation reconstructs repeated tool events", () => {
  let app: NestExpressApplication;
  // A dedicated control handle for truncation and fixture seeding, kept
  // separate from the app's own Prisma client (which AppModule owns and
  // closes when the Nest app closes — closing it twice throws). Mirrors the
  // existing agent-run-api.postgres.integration.test.ts pattern exactly.
  let controlHandle: PrismaClientHandle;

  beforeAll(async () => {
    controlHandle = await createTestPrismaClient();
    const testApp = await createTestApiApp();
    app = testApp.app;
  });

  afterEach(async () => {
    await truncateAllTables(controlHandle);
  });

  afterAll(async () => {
    await app.close();
    await controlHandle.close();
  });

  it("returns every repeated TOOL_* event in canonical sequence for the forced-finalization (max bound) run", async () => {
    const job = await createMultiStepCompletedRun(controlHandle.prisma, "TKT-57-forced", 3);

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    // All 12 events present, sequences contiguous and ascending — nothing
    // dropped, and nothing reordered by type or timestamp.
    expect(data.events).toHaveLength(12);
    expect(data.events.map((event: { sequence: number }) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(data.events.map((event: { payload: { type: string } }) => event.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);

    // Repeated TOOL_REQUESTED / TOOL_COMPLETED rows survive intact — not
    // collapsed, and not misread as corruption.
    const requested = data.events
      .filter((event: { payload: { type: string } }) => event.payload.type === "TOOL_REQUESTED")
      .map((event: { payload: { toolCallId: string } }) => event.payload.toolCallId);
    const completed = data.events
      .filter((event: { payload: { type: string } }) => event.payload.type === "TOOL_COMPLETED")
      .map((event: { payload: { toolCallId: string } }) => event.payload.toolCallId);
    expect(requested).toEqual(["call-1", "call-2", "call-3"]);
    expect(completed).toEqual(["call-1", "call-2", "call-3"]);

    // Terminal snapshot semantics unchanged: COMPLETED with the report.
    expect(data.run.status).toBe("COMPLETED");
    expect(data.outcome.type).toBe("COMPLETED");
    expect(data.outcome.report.category).toBe("SERVICE_DEGRADATION");

    // The legacy trace projection carries the same repeated events.
    expect(data.trace.filter((event: { type: string }) => event.type === "TOOL_REQUESTED")).toHaveLength(3);
    expect(data.trace.filter((event: { type: string }) => event.type === "TOOL_COMPLETED")).toHaveLength(3);
  });

  it("keeps the voluntary early-report stream intact (no REPORT_GENERATION_STARTED injected, no reordering)", async () => {
    const job = await createMultiStepCompletedRun(controlHandle.prisma, "TKT-57-voluntary", 2);

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    expect(data.events).toHaveLength(9);
    expect(data.events.map((event: { payload: { type: string } }) => event.payload.type)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
    // The endpoint must not synthesize a REPORT_GENERATION_STARTED the run
    // never produced.
    expect(
      data.events.some(
        (event: { payload: { type: string } }) => event.payload.type === "REPORT_GENERATION_STARTED",
      ),
    ).toBe(false);
    expect(data.events.filter((event: { payload: { type: string } }) => event.payload.type === "TOOL_REQUESTED")).toHaveLength(2);
    expect(data.run.status).toBe("COMPLETED");
    expect(data.outcome.type).toBe("COMPLETED");
  });
});
