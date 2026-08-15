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
    evidenceState: "SUFFICIENT",
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
    // Issue #58 Checkpoint B (§4): every NEW canonical TOOL_REQUESTED append
    // requires a validated assessment. The first request has no evidence yet
    // (NO_EVIDENCE_YET); later requests are STATUS_UNRESOLVED grounded on the
    // completed calls that precede them.
    // Chronological grounding: supportedBy must cite only calls completed
    // STRICTLY BEFORE this request — never the current call's own id, which
    // has not completed yet (Codex whole-issue review finding: callIds must
    // be sliced to the calls preceding this one, not the array including it).
    const assessment =
      index === 0
        ? { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] }
        : {
            evidenceState: "INSUFFICIENT",
            continuationReason: "STATUS_UNRESOLVED",
            supportedBy: callIds.slice(0, index).map((evidenceId) => ({ evidenceId, sourceType: "TOOL_EXECUTION" })),
          };
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: callId,
      toolName: "get_service_status",
      assessment,
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

// Issue #58 Checkpoint C — report fixtures for the stopReason acceptance
// matrix (§6). Each is schema-valid under the conditional-cardinality
// invariants (§5.5): non-SUFFICIENT always carries rootCause: null.
function insufficientReport(callIds: readonly string[]): ResolutionReport {
  return {
    category: "UNKNOWN",
    summary: "Insufficient evidence gathered from the available diagnostics.",
    rootCause: null,
    customerImpact: "Impact could not be determined from the available evidence.",
    recommendedResolution: "Gather more diagnostics before acting.",
    confidence: 0.3,
    evidence: callIds.map((callId) => ({
      evidenceId: callId,
      sourceType: "TOOL_EXECUTION",
      finding: `Tool call ${callId} was inconclusive.`,
    })),
    evidenceState: "INSUFFICIENT",
    suggestedActions: [],
  };
}

function conflictingReport(callIds: readonly string[]): ResolutionReport {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "Two diagnostics disagree about the same service's status.",
    rootCause: null,
    customerImpact: "Cannot be determined while the signals conflict.",
    recommendedResolution: "Manually verify payments-gateway status before acting.",
    confidence: 0.4,
    evidence: callIds.map((callId, index) => ({
      evidenceId: callId,
      sourceType: "TOOL_EXECUTION",
      finding: index === 0 ? `Tool call ${callId} reported DEGRADED.` : `Tool call ${callId} reported OPERATIONAL.`,
    })),
    evidenceState: "CONFLICTING",
    suggestedActions: [],
  };
}

function sufficientNonCausalReport(callIds: readonly string[]): ResolutionReport {
  return {
    category: "UNKNOWN",
    summary: "Service checked and found healthy.",
    rootCause: null,
    customerImpact: "No customer impact identified.",
    recommendedResolution: "No action required.",
    confidence: 0.9,
    evidence: callIds.map((callId) => ({
      evidenceId: callId,
      sourceType: "TOOL_EXECUTION",
      finding: `Tool call ${callId} reported OPERATIONAL — no degradation found.`,
    })),
    evidenceState: "SUFFICIENT",
    suggestedActions: [],
  };
}

/**
 * Issue #58 Checkpoint C (§6 stopReason matrix): seeds a completed run with
 * `toolCallCount` serial TOOL_REQUESTED -> TOOL_COMPLETED pairs (each
 * INSUFFICIENT/STATUS_UNRESOLVED-grounded on the calls before it, matching
 * createMultiStepCompletedRun's assessment shape), optionally announces
 * REPORT_GENERATION_STARTED before the report events (the harness-owned
 * forced-finalization fact stopReason derivation keys off, independent of
 * the report's own evidenceState — Scenario F), then finalizes with
 * `buildReport`. `toolCallCount: 0` seeds no TOOL_REQUESTED at all
 * (Scenario C0).
 */
async function createReportedRun(
  prisma: PrismaClient,
  ticketId: string,
  args: {
    toolCallCount: number;
    forceFinalization: boolean;
    buildReport: (callIds: readonly string[]) => ResolutionReport;
  },
): Promise<AgentJobRecord> {
  const job = await createJob(prisma, { ticketId, summary: "Issue #58 Checkpoint C stopReason fixture" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await appendInvestigationEvent(prisma, started.run.id, { type: "AGENT_STARTED" });
  const callIds: string[] = [];
  for (let index = 0; index < args.toolCallCount; index += 1) {
    const callId = `call-${index + 1}`;
    callIds.push(callId);
    const assessment =
      index === 0
        ? { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] }
        : {
            evidenceState: "INSUFFICIENT",
            continuationReason: "STATUS_UNRESOLVED",
            supportedBy: callIds.slice(0, index).map((evidenceId) => ({ evidenceId, sourceType: "TOOL_EXECUTION" })),
          };
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: callId,
      toolName: "get_service_status",
      assessment,
    });
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_COMPLETED",
      toolCallId: callId,
      toolName: "get_service_status",
    });
  }
  if (args.forceFinalization) {
    await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_GENERATION_STARTED" });
  }
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_VALIDATED" });
  await finalizeCompleted(prisma, started.run.id, args.buildReport(callIds));
  return job;
}

/**
 * Issue #58 Checkpoint C (§3, §7): seeds the genuine current-run conflict
 * ledger — call-1 (NO_EVIDENCE_YET) -> call-2 (STATUS_UNRESOLVED citing
 * call-1) -> call-3, whose assessment is the POSITIVE CONFLICT_UNRESOLVED
 * request grounded on both already-completed disagreeing observations
 * (call-1, call-2) — then a voluntary CONFLICTING report citing all three.
 * No REPORT_GENERATION_STARTED: the model chose to stop, the bound was never
 * reached.
 */
async function createConflictLedgerRun(prisma: PrismaClient, ticketId: string): Promise<AgentJobRecord> {
  const job = await createJob(prisma, { ticketId, summary: "Conflicting payments-gateway signals" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await appendInvestigationEvent(prisma, started.run.id, { type: "AGENT_STARTED" });

  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_REQUESTED",
    toolCallId: "call-1",
    toolName: "conflicting_status_probe",
    assessment: { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] },
  });
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_COMPLETED",
    toolCallId: "call-1",
    toolName: "conflicting_status_probe",
  });

  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_REQUESTED",
    toolCallId: "call-2",
    toolName: "conflicting_status_probe",
    assessment: {
      evidenceState: "INSUFFICIENT",
      continuationReason: "STATUS_UNRESOLVED",
      supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
    },
  });
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_COMPLETED",
    toolCallId: "call-2",
    toolName: "conflicting_status_probe",
  });

  // The positive CONFLICT_UNRESOLVED request (Revision 3 P2-3): grounded on
  // BOTH already-completed disagreeing observations, requesting a further
  // check to adjudicate. Reaches the canonical ledger with its assessment
  // persisted — the run continues rather than being rejected.
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_REQUESTED",
    toolCallId: "call-3",
    toolName: "conflicting_status_probe",
    assessment: {
      evidenceState: "CONFLICTING",
      continuationReason: "CONFLICT_UNRESOLVED",
      supportedBy: [
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
      ],
    },
  });
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_COMPLETED",
    toolCallId: "call-3",
    toolName: "conflicting_status_probe",
  });

  // call-3 is the THIRD diagnostic call — the reviewed bound
  // (MAX_DIAGNOSTIC_TOOL_CALLS = 3) is now spent, so the canonical ledger
  // contract requires REPORT_GENERATION_STARTED before the report events:
  // the run is honestly still conflicting when forced finalization ends it,
  // not resolved merely because a third diagnostic was attempted (§3.2/§3.3).
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_GENERATION_STARTED" });
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, started.run.id, { type: "REPORT_VALIDATED" });
  await finalizeCompleted(prisma, started.run.id, conflictingReport(["call-1", "call-2", "call-3"]));
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

  it("chronological grounding: every persisted TOOL_REQUESTED assessment cites only calls completed strictly before it, never its own toolCallId (Codex whole-issue review finding)", async () => {
    const job = await createMultiStepCompletedRun(controlHandle.prisma, "TKT-57-grounding", 3);

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    const requested = data.events.filter(
      (event: { payload: { type: string } }) => event.payload.type === "TOOL_REQUESTED",
    );
    expect(requested).toHaveLength(3);

    const completedBeforeThisRequest: string[] = [];
    for (const event of requested) {
      const supportedByIds = (event.payload.assessment.supportedBy as Array<{ evidenceId: string }>).map(
        (locator) => locator.evidenceId,
      );
      // Every cited locator must already be a call that completed strictly
      // BEFORE this request — reproduces the self-citation bug when it
      // fails: the buggy fixture pushed the current call into `callIds`
      // before building the assessment, so call-N's supportedBy would wrongly
      // include call-N itself, which has not completed yet.
      for (const evidenceId of supportedByIds) {
        expect(completedBeforeThisRequest).toContain(evidenceId);
      }
      expect(supportedByIds).not.toContain(event.payload.toolCallId);
      completedBeforeThisRequest.push(event.payload.toolCallId);
    }
    // Exact expected grounding per position: call-1 cites nothing, call-2
    // cites only call-1, call-3 cites only call-1 and call-2.
    expect(requested[0].payload.assessment.supportedBy).toEqual([]);
    expect(requested[1].payload.assessment.supportedBy).toEqual([
      { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
    ]);
    expect(requested[2].payload.assessment.supportedBy).toEqual([
      { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
      { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
    ]);
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

describe("issue #58 Checkpoint C — genuine current-run conflict ledger round-trip", () => {
  let app: NestExpressApplication;
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

  it("persists and reads back the full conflict stream, including the positive CONFLICT_UNRESOLVED request, in canonical order", async () => {
    const job = await createConflictLedgerRun(controlHandle.prisma, "TKT-58-conflict");

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

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
    expect(
      data.events.map((event: { sequence: number }) => event.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // The assessment on every TOOL_REQUESTED survives the DB round trip,
    // including source types and the positive CONFLICT_UNRESOLVED request.
    const requested = data.events.filter(
      (event: { payload: { type: string } }) => event.payload.type === "TOOL_REQUESTED",
    );
    expect(requested).toHaveLength(3);
    expect(requested[0].payload.assessment).toEqual({
      evidenceState: "INSUFFICIENT",
      continuationReason: "NO_EVIDENCE_YET",
      supportedBy: [],
    });
    expect(requested[1].payload.assessment).toEqual({
      evidenceState: "INSUFFICIENT",
      continuationReason: "STATUS_UNRESOLVED",
      supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
    });
    expect(requested[2].payload.toolCallId).toBe("call-3");
    expect(requested[2].payload.assessment).toEqual({
      evidenceState: "CONFLICTING",
      continuationReason: "CONFLICT_UNRESOLVED",
      supportedBy: [
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
      ],
    });

    // The reviewed diagnostic-call bound (3) was reached by call-3, so
    // forced finalization truthfully ended the run — REPORT_GENERATION_STARTED
    // is present, and attempting a third diagnostic never implied the
    // conflict was resolved.
    expect(
      data.events.some(
        (event: { payload: { type: string } }) => event.payload.type === "REPORT_GENERATION_STARTED",
      ),
    ).toBe(true);

    // The legacy trace projection still omits the assessment field, exactly
    // as the record/write split intends (§5.3) — it carries only the fields
    // the pre-#58 AgentTraceEvent contract already had.
    const traceRequested = data.trace.filter((event: { type: string }) => event.type === "TOOL_REQUESTED");
    expect(traceRequested).toHaveLength(3);
    for (const traceEvent of traceRequested) {
      expect(traceEvent).not.toHaveProperty("assessment");
    }

    // Final outcome: both disagreeing sides preserved, no fabricated
    // resolution.
    expect(data.outcome.type).toBe("COMPLETED");
    expect(data.outcome.report.evidenceState).toBe("CONFLICTING");
    expect(data.outcome.report.rootCause).toBeNull();
    expect(data.outcome.report.evidence.map((e: { evidenceId: string }) => e.evidenceId).sort()).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);

    // F — the harness-owned forced-finalization fact wins regardless of the
    // final report's evidenceState: even though the report is honestly
    // still CONFLICTING, REPORT_GENERATION_STARTED makes this BOUND_EXHAUSTED,
    // not NO_JUSTIFIED_DIAGNOSTIC.
    expect(data.stopReason).toBe("BOUND_EXHAUSTED");
  });
});

describe("issue #58 Checkpoint C — stopReason readback matrix (§6)", () => {
  let app: NestExpressApplication;
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

  async function fetchStopReason(jobId: string): Promise<unknown> {
    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${jobId}/investigation`)
      .expect(200);
    return response.body.data.stopReason;
  }

  it("A — voluntary SUFFICIENT stop after one diagnostic, no REPORT_GENERATION_STARTED -> SUFFICIENT_EVIDENCE", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-a", {
      toolCallCount: 1,
      forceFinalization: false,
      buildReport: completedReport,
    });
    expect(await fetchStopReason(job.id)).toBe("SUFFICIENT_EVIDENCE");
  });

  it("C — voluntary INSUFFICIENT stop with a real observation, no REPORT_GENERATION_STARTED -> NO_JUSTIFIED_DIAGNOSTIC", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-c", {
      toolCallCount: 1,
      forceFinalization: false,
      buildReport: insufficientReport,
    });
    expect(await fetchStopReason(job.id)).toBe("NO_JUSTIFIED_DIAGNOSTIC");
  });

  it("D — voluntary CONFLICTING stop below the diagnostic bound, no REPORT_GENERATION_STARTED -> NO_JUSTIFIED_DIAGNOSTIC", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-d", {
      toolCallCount: 2,
      forceFinalization: false,
      buildReport: conflictingReport,
    });

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    expect(data.outcome.report.evidenceState).toBe("CONFLICTING");
    expect(data.outcome.report.rootCause).toBeNull();
    // The protocol-implied stop judgment, not a harness-proven one — the
    // model voluntarily reported while genuinely conflicting; the 3-call
    // bound was never reached.
    expect(data.stopReason).toBe("NO_JUSTIFIED_DIAGNOSTIC");
  });

  it("C0 — zero-evidence insufficient stop, no TOOL_REQUESTED at all -> NO_JUSTIFIED_DIAGNOSTIC", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-c0", {
      toolCallCount: 0,
      forceFinalization: false,
      buildReport: insufficientReport,
    });

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    expect(data.events.some((event: { payload: { type: string } }) => event.payload.type === "TOOL_REQUESTED")).toBe(
      false,
    );
    expect(data.outcome.report.evidence).toEqual([]);
    expect(data.stopReason).toBe("NO_JUSTIFIED_DIAGNOSTIC");
  });

  it("F — REPORT_GENERATION_STARTED present -> BOUND_EXHAUSTED, winning regardless of the final report's evidenceState", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-f", {
      toolCallCount: 3,
      forceFinalization: true,
      buildReport: insufficientReport,
    });
    expect(await fetchStopReason(job.id)).toBe("BOUND_EXHAUSTED");
  });

  it("G — SUFFICIENT report with rootCause null (grounded non-causal verdict), no REPORT_GENERATION_STARTED -> SUFFICIENT_EVIDENCE", async () => {
    const job = await createReportedRun(controlHandle.prisma, "TKT-58-g", {
      toolCallCount: 1,
      forceFinalization: false,
      buildReport: sufficientNonCausalReport,
    });

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    expect(data.outcome.report.evidenceState).toBe("SUFFICIENT");
    expect(data.outcome.report.rootCause).toBeNull();
    expect(data.stopReason).toBe("SUFFICIENT_EVIDENCE");
  });

  it("legacy — a pre-#58 COMPLETED report with no evidenceState and no REPORT_GENERATION_STARTED -> null", async () => {
    const job = await createJob(controlHandle.prisma, { ticketId: "TKT-58-legacy", summary: "Legacy report readback" });
    const started = await startRun(controlHandle.prisma, job.id, "FAKE", null);
    await appendInvestigationEvent(controlHandle.prisma, started.run.id, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(controlHandle.prisma, started.run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
      assessment: { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] },
    });
    await appendInvestigationEvent(controlHandle.prisma, started.run.id, {
      type: "TOOL_COMPLETED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    await appendInvestigationEvent(controlHandle.prisma, started.run.id, { type: "REPORT_SUBMITTED" });
    await appendInvestigationEvent(controlHandle.prisma, started.run.id, { type: "REPORT_VALIDATED" });

    // A genuine pre-#58 stored report shape — no evidenceState key at all.
    // finalizeCompleted validates against the strict write schema (which
    // REQUIRES evidenceState), so a legacy row must be written directly,
    // exactly as any row written before issue #58 shipped would already
    // exist in production. The report column is raw jsonb (schema.prisma).
    const legacyReport = {
      category: "SERVICE_DEGRADATION",
      summary: "Legacy pre-#58 report.",
      rootCause: "notification-service is degraded.",
      customerImpact: "Some customers are receiving delayed notifications.",
      recommendedResolution: "Monitor notification-service until it recovers.",
      confidence: 0.7,
      evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "notification-service reported status DEGRADED." }],
      suggestedActions: [],
    };
    await controlHandle.prisma.$executeRaw`
      UPDATE agent_runs
      SET status = 'COMPLETED', finished_at = now(), report = ${JSON.stringify(legacyReport)}::jsonb
      WHERE id = ${started.run.id}::uuid`;

    const response = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${job.id}/investigation`)
      .expect(200);
    const { data } = response.body;

    expect(data.outcome.type).toBe("COMPLETED");
    expect(data.outcome.report.rootCause).toBe("notification-service is degraded.");
    expect(data.outcome.report).not.toHaveProperty("evidenceState");
    expect(data.stopReason).toBeNull();
  });
});
