import { Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { AgentRunServiceError, type AgentRunService, type RunbookRetriever, type ToolRegistry } from "@opspilot/agent-runtime";
import { PersistenceError } from "@opspilot/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentJobsController } from "../src/agent-jobs/agent-jobs.controller";
import type { AgentRunApprovalService } from "../src/agent-run-approvals/agent-run-approval.service";
import { AgentRunApprovalsController } from "../src/agent-run-approvals/agent-run-approvals.controller";
import { AGENT_RUN_APPROVAL_SERVICE } from "../src/agent-run-approvals/agent-run-approvals.tokens";
import { AgentRunsController } from "../src/agent-runs/agent-runs.controller";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { NotFoundController } from "../src/common/not-found.controller";
import { requestIdMiddleware } from "../src/common/request-id.middleware";
import type { AgentProviderFactory } from "../src/execution/api-provider-factory";
import {
  AGENT_RUN_SERVICE,
  AGENT_PROVIDER_FACTORY,
  LIVE_RUN_ADMISSION,
  RUN_EXECUTION_CONFIG,
  RUNBOOK_RETRIEVER,
  TOOL_REGISTRY,
  USAGE_HOOKS,
} from "../src/execution/execution.tokens";
import { createLiveRunAdmissionController } from "../src/execution/live-run-admission";
import { parseRunExecutionConfig, type RunExecutionConfig } from "../src/execution/run-execution-config";
import { createApiUsageHooks } from "../src/execution/usage-hooks";

// Mocked-service HTTP transport suite — real Nest HTTP app, real Express
// middleware pipeline (reproduced in the exact production order), Supertest.
// No PostgreSQL: only @opspilot/agent-runtime's AgentRunService boundary is
// mocked (see docs/12-agent-run-api.md).
const fakeAgentRunService: AgentRunService = {
  createAgentJob: vi.fn(),
  executeAndPersist: vi.fn(),
  // Defaults to "no run bears this key", so a LIVE request in these suites
  // reaches new-run admission exactly as it did before step 4b existed.
  replayLiveRun: vi.fn().mockResolvedValue({ replay: "absent" }),
  retryFinalization: vi.fn(),
  reconcileLiveRunBudget: vi.fn(),
  getAgentRun: vi.fn(),
  getAgentJob: vi.fn(),
  getInvestigationState: vi.fn(),
};
const fakeToolRegistry = { find: vi.fn() } as unknown as ToolRegistry;
const fakeProviderFactory: AgentProviderFactory = { createProvider: vi.fn() };
// Issue #72: AgentRunsController now also depends on RUNBOOK_RETRIEVER. This
// suite is about HTTP transport, not retrieval, so a retriever that never
// returns a chunk is sufficient — the controller must still be constructible.
const fakeRunbookRetriever: RunbookRetriever = { retrieve: vi.fn().mockResolvedValue([]) };
// The safest posture a deployment can be in: deterministic by default, no live
// capability, kill switch off. This suite exercises the HTTP transport, which
// should not depend on the live path at all — and with this config a stray LIVE
// request would be refused rather than attempted.
// Derived from the real parser on an empty environment, so the fixture tracks
// the shipped defaults instead of drifting from them.
const runExecutionConfig: RunExecutionConfig = parseRunExecutionConfig({});
const fakeAgentRunApprovalService: AgentRunApprovalService = {
  recordApprovalDecision: vi.fn(),
  getApprovalDecision: vi.fn(),
};

@Module({
  // NotFoundController's catch-all route is registered last so the
  // specific endpoint routes are matched first — mirrors app.module.ts's
  // production module-import order.
  controllers: [AgentJobsController, AgentRunsController, AgentRunApprovalsController, NotFoundController],
  providers: [
    { provide: AGENT_RUN_SERVICE, useValue: fakeAgentRunService },
    { provide: TOOL_REGISTRY, useValue: fakeToolRegistry },
    { provide: AGENT_PROVIDER_FACTORY, useValue: fakeProviderFactory },
    { provide: RUN_EXECUTION_CONFIG, useValue: runExecutionConfig },
    // The REAL admission controller over a stub budget read. These suites are
    // about HTTP transport and static assets, and the config above has no live
    // capability, so admission refuses every LIVE request long before the
    // budget matters — but the controller still has to be constructible.
    {
      provide: LIVE_RUN_ADMISSION,
      useValue: createLiveRunAdmissionController({
        config: runExecutionConfig,
        isBudgetOpen: async () => true,
      }),
    },
    { provide: USAGE_HOOKS, useValue: createApiUsageHooks() },
    { provide: AGENT_RUN_APPROVAL_SERVICE, useValue: fakeAgentRunApprovalService },
    { provide: RUNBOOK_RETRIEVER, useValue: fakeRunbookRetriever },
  ],
})
class HttpTransportTestModule {}

const JOB = {
  id: "0313ac34-6394-4f6d-9be1-ec277daa69dd",
  ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors" },
  externalTicketId: "TICKET-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const RUN = {
  id: "834cb857-2832-410e-ba3e-a10574a42a6d",
  jobId: JOB.id,
  attemptNumber: 1,
  status: "COMPLETED",
  providerMode: "FAKE",
  modelIdentifier: null,
  startedAt: "2026-01-01T00:01:00.000Z",
  finishedAt: "2026-01-01T00:02:00.000Z",
  createdAt: "2026-01-01T00:01:00.000Z",
  // A FAKE run made no provider call, so there is no measured cost.
  estimatedCostNanoUsd: null,
  possibleUnobservedCost: false,
};

const PERSISTED_RUN = {
  job: JOB,
  run: RUN,
  trace: [{ type: "REPORT_GENERATED" as const }],
  outcome: {
    type: "COMPLETED" as const,
    report: {
      category: "SERVICE_DEGRADATION" as const,
      summary: "s",
      rootCause: "r",
      customerImpact: "c",
      recommendedResolution: "rr",
      confidence: 0.5,
      evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" as const, finding: "f" }],
      suggestedActions: [],
    },
  },
};

const INVESTIGATION_STATE = {
  job: JOB,
  run: RUN,
  trace: PERSISTED_RUN.trace,
  outcome: PERSISTED_RUN.outcome,
  events: [
    { runId: RUN.id, sequence: 1, recordedAt: "2026-01-01T00:01:00.000Z", payload: { type: "RUN_CREATED" as const } },
    { runId: RUN.id, sequence: 2, recordedAt: "2026-01-01T00:01:01.000Z", payload: { type: "AGENT_STARTED" as const } },
    { runId: RUN.id, sequence: 3, recordedAt: "2026-01-01T00:01:02.000Z", payload: { type: "REPORT_SUBMITTED" as const } },
    { runId: RUN.id, sequence: 4, recordedAt: "2026-01-01T00:01:03.000Z", payload: { type: "REPORT_VALIDATED" as const } },
    { runId: RUN.id, sequence: 5, recordedAt: "2026-01-01T00:02:00.000Z", payload: { type: "RUN_COMPLETED" as const } },
  ],
};

const APPROVAL_VIEW = {
  runId: RUN.id,
  status: "APPROVED" as const,
  reviewerName: "jacky",
  note: null,
  decidedAt: new Date("2026-07-23T10:15:00.000Z"),
};

const PENDING_APPROVAL_VIEW = {
  runId: RUN.id,
  status: "PENDING" as const,
  reviewerName: null,
  note: null,
  decidedAt: null,
};

let app: NestExpressApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [HttpTransportTestModule] }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    abortOnError: false,
    logger: false,
    bodyParser: false,
  });

  // Manually reproduces main.ts's exact production middleware order.
  app.use(requestIdMiddleware);
  app.use(jsonBodyParser);
  app.use(jsonParserErrorHandler);
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("route successes", () => {
  it("POST /v1/agent-jobs -> 201 with the mapped job and a request ID", async () => {
    (fakeAgentRunService.createAgentJob as ReturnType<typeof vi.fn>).mockResolvedValue(JOB);

    const res = await request(app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-1", summary: "Elevated errors" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      data: { id: JOB.id, ticketId: "TICKET-1", summary: "Elevated errors", createdAt: JOB.createdAt },
    });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /v1/agent-jobs/:jobId -> 200 with the job detail", async () => {
    (fakeAgentRunService.getAgentJob as ReturnType<typeof vi.fn>).mockResolvedValue({ job: JOB, runs: [RUN] });

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(JOB.id);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /v1/agent-jobs/:jobId/investigation -> 200 with the investigation state", async () => {
    (fakeAgentRunService.getInvestigationState as ReturnType<typeof vi.fn>).mockResolvedValue(
      INVESTIGATION_STATE,
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}/investigation`);

    expect(res.status).toBe(200);
    expect(res.body.data.job.id).toBe(JOB.id);
    expect(res.body.data.run.id).toBe(RUN.id);
    expect(res.body.data.trace).toEqual(INVESTIGATION_STATE.trace);
    expect(res.body.data.outcome).toEqual(INVESTIGATION_STATE.outcome);
    expect(res.body.data.events).toHaveLength(5);
    expect(res.body.data.events[0].payload.type).toBe("RUN_CREATED");
    expect(res.body.data.events[4].payload.type).toBe("RUN_COMPLETED");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /v1/agent-jobs/:jobId/investigation -> exact response key-set and no forbidden fields (Verification gap 2)", async () => {
    (fakeAgentRunService.getInvestigationState as ReturnType<typeof vi.fn>).mockResolvedValue(
      INVESTIGATION_STATE,
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}/investigation`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["data"]);
    // Issue #58 Checkpoint C: stopReason is an additive derived field on this
    // response only (§9.2) — the exact key set must include it.
    expect(Object.keys(res.body.data).sort()).toEqual(["events", "job", "outcome", "run", "stopReason", "trace"]);
    expect(Object.keys(res.body.data.job).sort()).toEqual(["createdAt", "id", "summary", "ticketId"]);
    expect(Object.keys(res.body.data.run).sort()).toEqual(
      ["attemptNumber", "createdAt", "estimatedCostUsd", "finishedAt", "id", "jobId", "modelIdentifier", "providerMode", "startedAt", "status"].sort(),
    );
    // COMPLETED-variant outcome — union-appropriate exact key set.
    expect(Object.keys(res.body.data.outcome).sort()).toEqual(["report", "type"]);
    expect(Object.keys(res.body.data.outcome.report).sort()).toEqual(
      ["category", "confidence", "customerImpact", "evidence", "recommendedResolution", "rootCause", "suggestedActions", "summary"].sort(),
    );
    expect(Object.keys(res.body.data.outcome.report.evidence[0]).sort()).toEqual(["evidenceId", "finding", "sourceType"]);

    expect(res.body.data.events).toHaveLength(5);
    for (const event of res.body.data.events) {
      expect(Object.keys(event).sort()).toEqual(["payload", "recordedAt", "runId", "sequence"]);
    }
    // Each payload's own exact key set, union-appropriate per event type —
    // every event in this fixture carries a bare `{ type }` marker fact.
    for (const event of res.body.data.events) {
      expect(Object.keys(event.payload)).toEqual(["type"]);
    }

    // Privacy: the FULL serialized response contains none of the forbidden
    // fields — clientRequestId, provider prompt/response, raw tool
    // input/output, database/internal persistence error text.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("clientRequestId");
    expect(serialized.toLowerCase()).not.toContain("prompt");
    expect(serialized.toLowerCase()).not.toContain("tool_input");
    expect(serialized.toLowerCase()).not.toContain("tool_output");
    expect(serialized.toLowerCase()).not.toMatch(/prisma|\bsql\b|stack trace|postgres/);
  });

  it("GET /v1/agent-jobs/:jobId/investigation -> field-bearing union members serialize with their exact allowed payload keys, and the full response excludes every forbidden field (Verification gap I)", async () => {
    // A realistic FAILED lifecycle exercising every field-bearing canonical
    // event type the plan calls out — TOOL_REQUESTED, TOOL_COMPLETED,
    // TOOL_FAILED, REPORT_VALIDATION_FAILED, RUN_FAILED — each using the
    // exact valid contract shape from packages/contracts/src/investigation-event.ts
    // (never an invented/invalid fixture).
    const FIELD_BEARING_EVENTS = [
      { runId: RUN.id, sequence: 1, recordedAt: "2026-01-01T00:01:00.000Z", payload: { type: "RUN_CREATED" as const } },
      { runId: RUN.id, sequence: 2, recordedAt: "2026-01-01T00:01:01.000Z", payload: { type: "AGENT_STARTED" as const } },
      {
        runId: RUN.id,
        sequence: 3,
        recordedAt: "2026-01-01T00:01:02.000Z",
        payload: { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" },
      },
      {
        runId: RUN.id,
        sequence: 4,
        recordedAt: "2026-01-01T00:01:03.000Z",
        payload: { type: "TOOL_COMPLETED" as const, toolCallId: "call-1", toolName: "get_service_status" },
      },
      { runId: RUN.id, sequence: 5, recordedAt: "2026-01-01T00:01:04.000Z", payload: { type: "REPORT_SUBMITTED" as const } },
      {
        runId: RUN.id,
        sequence: 6,
        recordedAt: "2026-01-01T00:01:05.000Z",
        payload: { type: "REPORT_VALIDATION_FAILED" as const, failureCode: "REPORT_EVIDENCE_INVALID" as const },
      },
      {
        runId: RUN.id,
        sequence: 7,
        recordedAt: "2026-01-01T00:01:06.000Z",
        payload: { type: "TOOL_REQUESTED" as const, toolCallId: "call-2", toolName: "get_logs" },
      },
      {
        runId: RUN.id,
        sequence: 8,
        recordedAt: "2026-01-01T00:01:07.000Z",
        payload: { type: "TOOL_FAILED" as const, toolCallId: "call-2", toolName: "get_logs", failureCode: "TOOL_EXECUTION_FAILED" as const },
      },
      {
        runId: RUN.id,
        sequence: 9,
        recordedAt: "2026-01-01T00:01:08.000Z",
        payload: { type: "RUN_FAILED" as const, failureCode: "TOOL_EXECUTION_FAILED" as const, failedStage: "DIAGNOSTIC_EXECUTION" as const },
      },
    ];
    const failedInvestigationState = {
      job: JOB,
      run: { ...RUN, status: "FAILED", finishedAt: "2026-01-01T00:02:00.000Z" },
      trace: [],
      outcome: { type: "FAILED" as const, code: "TOOL_EXECUTION_FAILED", message: "A diagnostic tool failed while executing." },
      events: FIELD_BEARING_EVENTS,
    };
    (fakeAgentRunService.getInvestigationState as ReturnType<typeof vi.fn>).mockResolvedValue(
      failedInvestigationState,
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}/investigation`);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(9);
    // FAILED-variant outcome — union-appropriate exact key set.
    expect(Object.keys(res.body.data.outcome).sort()).toEqual(["code", "message", "type"]);

    const byType = new Map<string, Record<string, unknown>>(
      (res.body.data.events as { payload: { type: string } }[]).map((event) => [event.payload.type, event.payload as Record<string, unknown>]),
    );
    expect(Object.keys(byType.get("TOOL_REQUESTED")!).sort()).toEqual(["toolCallId", "toolName", "type"]);
    expect(Object.keys(byType.get("TOOL_COMPLETED")!).sort()).toEqual(["toolCallId", "toolName", "type"]);
    expect(Object.keys(byType.get("TOOL_FAILED")!).sort()).toEqual(["failureCode", "toolCallId", "toolName", "type"]);
    expect(Object.keys(byType.get("REPORT_VALIDATION_FAILED")!).sort()).toEqual(["failureCode", "type"]);
    expect(Object.keys(byType.get("RUN_FAILED")!).sort()).toEqual(["failedStage", "failureCode", "type"]);

    // Privacy: the FULL serialized response excludes every forbidden field
    // named in the fix prompt, checked as an exact (case-insensitive)
    // literal match rather than a loose substring — so a camelCase
    // `toolInput`/`stackTrace` cannot slip past a snake_case-only check.
    const serialized = JSON.stringify(res.body).toLowerCase();
    const forbidden = [
      "clientRequestId",
      "providerPrompt",
      "providerResponse",
      "prompt",
      "responseText",
      "rawInput",
      "rawOutput",
      "toolInput",
      "toolOutput",
      "tool_input",
      "tool_output",
      "prisma",
      "sql",
      "stack",
      "stackTrace",
      "postgres",
    ];
    for (const field of forbidden) {
      expect(serialized).not.toContain(field.toLowerCase());
    }
  });

  it("POST /v1/agent-jobs/:jobId/runs -> 201 with Location header and no body pre-read of the job", async () => {
    (fakeAgentRunService.executeAndPersist as ReturnType<typeof vi.fn>).mockResolvedValue({
      persistence: "persisted",
      run: PERSISTED_RUN,
    });

    const res = await request(app.getHttpServer()).post(`/v1/agent-jobs/${JOB.id}/runs`).send();

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/agent-runs/${RUN.id}`);
    expect(res.body.data.run.id).toBe(RUN.id);
    expect(fakeAgentRunService.getAgentJob).not.toHaveBeenCalled();
  });

  it("GET /v1/agent-runs/:runId -> 200 with the full run detail", async () => {
    (fakeAgentRunService.getAgentRun as ReturnType<typeof vi.fn>).mockResolvedValue(PERSISTED_RUN);

    const res = await request(app.getHttpServer()).get(`/v1/agent-runs/${RUN.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.run.id).toBe(RUN.id);
    expect(res.body.data.trace).toEqual(PERSISTED_RUN.trace);
    expect(res.body.data.outcome).toEqual(PERSISTED_RUN.outcome);
  });
});

describe("malformed route parameters", () => {
  it.each([
    ["GET", "/v1/agent-jobs/not-a-uuid"],
    ["POST", "/v1/agent-jobs/not-a-uuid/runs"],
    ["GET", "/v1/agent-runs/not-a-uuid"],
    // Verification gap 2 (independent review, Codex review): the malformed-route
    // table did not previously include the investigation endpoint.
    ["GET", "/v1/agent-jobs/not-a-uuid/investigation"],
  ] as const)("%s %s -> 400 ROUTE_PARAMETER_INVALID", async (method, path) => {
    const res = method === "GET" ? await request(app.getHttpServer()).get(path) : await request(app.getHttpServer()).post(path);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ROUTE_PARAMETER_INVALID");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("body parsing edge cases", () => {
  it("malformed JSON -> stable 400 JSON envelope, never an Express HTML page", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/agent-jobs")
      .set("Content-Type", "application/json")
      .send('{"bad json');

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    expect(res.text).not.toContain("<html");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("a text/plain non-JSON body on the run endpoint is rejected, never silently accepted as empty", async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${JOB.id}/runs`)
      .set("Content-Type", "text/plain")
      .send("hello");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    expect(fakeAgentRunService.executeAndPersist).not.toHaveBeenCalled();
  });

  it("a body over 32 KB -> stable 413 REQUEST_BODY_TOO_LARGE", async () => {
    const oversized = JSON.stringify({ ticketId: "T", summary: "a".repeat(40_000) });

    const res = await request(app.getHttpServer())
      .post("/v1/agent-jobs")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("REQUEST_BODY_TOO_LARGE");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it.each([
    ["no body", undefined],
    ["{}", {}],
  ] as const)("run body accepts %s", async (_label, body) => {
    (fakeAgentRunService.executeAndPersist as ReturnType<typeof vi.fn>).mockResolvedValue({
      persistence: "persisted",
      run: PERSISTED_RUN,
    });

    const req = request(app.getHttpServer()).post(`/v1/agent-jobs/${JOB.id}/runs`);
    const res = body === undefined ? await req.send() : await req.send(body);

    expect(res.status).toBe(201);
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"oops"'],
    ["a populated object", '{"unexpected":true}'],
  ] as const)("run body rejects %s", async (_label, rawJson) => {
    const res = await request(app.getHttpServer())
      .post(`/v1/agent-jobs/${JOB.id}/runs`)
      .set("Content-Type", "application/json")
      .send(rawJson);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    expect(fakeAgentRunService.executeAndPersist).not.toHaveBeenCalled();
  });
});

describe("domain error branches", () => {
  it("404 AGENT_JOB_NOT_FOUND when the job does not exist", async () => {
    (fakeAgentRunService.getAgentJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_JOB_NOT_FOUND");
  });

  it("404 AGENT_JOB_NOT_FOUND when investigation state job does not exist", async () => {
    (fakeAgentRunService.getInvestigationState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}/investigation`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_JOB_NOT_FOUND");
  });

  it("500 INTERNAL_DATA_INVALID for a corrupt canonical stream", async () => {
    (fakeAgentRunService.getInvestigationState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_VALIDATION_FAILED", "corrupt"),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}/investigation`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_DATA_INVALID");
  });

  it("404 AGENT_RUN_NOT_FOUND when the run does not exist", async () => {
    (fakeAgentRunService.getAgentRun as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_NOT_FOUND", "no run"),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-runs/${RUN.id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AGENT_RUN_NOT_FOUND");
  });

  it("409 PERSISTENCE_CONFLICT when job creation hits a conflicting persisted state", async () => {
    (fakeAgentRunService.createAgentJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_CONFLICT", "conflict"),
    );

    const res = await request(app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "T", summary: "A conflicting submission" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PERSISTENCE_CONFLICT");
  });

  it("503 PERSISTENCE_UNAVAILABLE when the database is unreachable", async () => {
    (fakeAgentRunService.getAgentJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_UNAVAILABLE", "down"),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PERSISTENCE_UNAVAILABLE");
  });

  it("500 AGENT_EXECUTION_CRASHED when the orchestrator crashes, never leaking the raw cause", async () => {
    const sentinelSecret = "sk-super-secret-do-not-leak";
    (fakeAgentRunService.executeAndPersist as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-9", { cause: new Error(sentinelSecret) }),
    );

    const res = await request(app.getHttpServer()).post(`/v1/agent-jobs/${JOB.id}/runs`).send();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("AGENT_EXECUTION_CRASHED");
    expect(res.body.error.runId).toBe("run-9");
    expect(res.text).not.toContain(sentinelSecret);
  });

  it("500 INTERNAL_ERROR for a raw unexpected throw, never leaking its message", async () => {
    const sentinelSecret = "sk-super-secret-do-not-leak";
    (fakeAgentRunService.getAgentJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(sentinelSecret));

    const res = await request(app.getHttpServer()).get(`/v1/agent-jobs/${JOB.id}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(res.text).not.toContain(sentinelSecret);
  });
});

describe("request ID behavior", () => {
  it("ignores an inbound X-Request-Id and always generates its own", async () => {
    (fakeAgentRunService.getAgentJob as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
    );

    const res = await request(app.getHttpServer())
      .get(`/v1/agent-jobs/${JOB.id}`)
      .set("X-Request-Id", "attacker-supplied-id");

    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-request-id"]).not.toBe("attacker-supplied-id");
  });
});

describe("approval routes", () => {
  describe("POST validation/transport", () => {
    it("APPROVED first creation -> 201 + Location + data envelope", async () => {
      (fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
        view: APPROVAL_VIEW,
        outcome: "created",
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky" });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/v1/agent-runs/${RUN.id}/approval`);
      expect(res.body).toEqual({
        data: {
          runId: RUN.id,
          status: "APPROVED",
          reviewerName: "jacky",
          note: null,
          decidedAt: "2026-07-23T10:15:00.000Z",
        },
      });
    });

    it("REJECTED first creation -> 201 + Location", async () => {
      (fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
        view: { ...APPROVAL_VIEW, status: "REJECTED" },
        outcome: "created",
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "REJECTED", reviewerName: "jacky" });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/v1/agent-runs/${RUN.id}/approval`);
      expect(res.body.data.status).toBe("REJECTED");
    });

    it("note omitted -> the service receives no note property (never null)", async () => {
      const recordApprovalDecision = fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>;
      recordApprovalDecision.mockResolvedValue({ view: APPROVAL_VIEW, outcome: "created" });

      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky" });

      expect(res.status).toBe(201);
      const [, body] = recordApprovalDecision.mock.calls[0] as [string, Record<string, unknown>];
      expect(Object.prototype.hasOwnProperty.call(body, "note")).toBe(false);
    });

    it("note present -> the service receives it", async () => {
      const recordApprovalDecision = fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>;
      recordApprovalDecision.mockResolvedValue({ view: APPROVAL_VIEW, outcome: "created" });

      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky", note: "Looks correct." });

      expect(res.status).toBe(201);
      const [, body] = recordApprovalDecision.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.note).toBe("Looks correct.");
    });

    it("trims reviewerName/note -> the service receives already-normalized values", async () => {
      const recordApprovalDecision = fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>;
      recordApprovalDecision.mockResolvedValue({ view: APPROVAL_VIEW, outcome: "created" });

      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "  jacky  ", note: "  a note  " });

      expect(res.status).toBe(201);
      const [, body] = recordApprovalDecision.mock.calls[0] as [string, Record<string, unknown>];
      expect(body.reviewerName).toBe("jacky");
      expect(body.note).toBe("a note");
    });

    it("invalid decision value -> 400 REQUEST_BODY_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "MAYBE", reviewerName: "jacky" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
      expect(fakeAgentRunApprovalService.recordApprovalDecision).not.toHaveBeenCalled();
    });

    it("blank reviewerName -> 400 REQUEST_BODY_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "   " });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    });

    it("reviewerName exceeding 100 characters -> 400 REQUEST_BODY_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "a".repeat(101) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    });

    it("note exceeding 1000 characters -> 400 REQUEST_BODY_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky", note: "a".repeat(1001) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    });

    it("unknown body key -> 400 REQUEST_BODY_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post(`/v1/agent-runs/${RUN.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky", extra: "nope" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("REQUEST_BODY_INVALID");
    });

    it("non-UUID :runId -> 400 ROUTE_PARAMETER_INVALID", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/agent-runs/not-a-uuid/approval")
        .send({ decision: "APPROVED", reviewerName: "jacky" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ROUTE_PARAMETER_INVALID");
      expect(fakeAgentRunApprovalService.recordApprovalDecision).not.toHaveBeenCalled();
    });
  });

  describe("GET", () => {
    it("mocked PENDING view -> 200", async () => {
      (fakeAgentRunApprovalService.getApprovalDecision as ReturnType<typeof vi.fn>).mockResolvedValue(
        PENDING_APPROVAL_VIEW,
      );

      const res = await request(app.getHttpServer()).get(`/v1/agent-runs/${RUN.id}/approval`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: { runId: RUN.id, status: "PENDING", reviewerName: null, note: null, decidedAt: null },
      });
    });

    it("non-UUID :runId -> 400 ROUTE_PARAMETER_INVALID", async () => {
      const res = await request(app.getHttpServer()).get("/v1/agent-runs/not-a-uuid/approval");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ROUTE_PARAMETER_INVALID");
    });
  });

  it("error responses from this route never leak a sentinel secret value", async () => {
    const sentinelSecret = "sk-super-secret-do-not-leak";
    (fakeAgentRunApprovalService.getApprovalDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_NOT_FOUND", sentinelSecret),
    );

    const res = await request(app.getHttpServer()).get(`/v1/agent-runs/${RUN.id}/approval`);

    expect(res.status).toBe(404);
    expect(res.text).not.toContain(sentinelSecret);
  });

  it("mandatory: mocked PERSISTENCE_UNAVAILABLE on POST -> 503, exact catalog message, requestId present, sentinel absent", async () => {
    const sentinelSecret = "sentinel internal message";
    (fakeAgentRunApprovalService.recordApprovalDecision as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PersistenceError("PERSISTENCE_UNAVAILABLE", sentinelSecret),
    );

    const res = await request(app.getHttpServer())
      .post(`/v1/agent-runs/${RUN.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(res.body.error.message).toBe("The database is temporarily unavailable.");
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.text).not.toContain(sentinelSecret);
  });
});

describe("unknown routes", () => {
  it("GET on an unmatched path -> stable 404 ROUTE_NOT_FOUND JSON envelope, never raw Nest content", async () => {
    const res = await request(app.getHttpServer()).get("/v1/this-route-does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested route was not found.",
        requestId: expect.any(String),
      },
    });
    expect(res.headers["x-request-id"]).toBeTruthy();
    // Never Nest's own default NotFoundException body/message shape, the
    // raw request path, or an HTML error page.
    expect(res.text).not.toContain("Cannot GET");
    expect(res.text).not.toContain("<html");
    expect(JSON.stringify(res.body)).not.toContain("this-route-does-not-exist");
  });

  it("POST on an unmatched path also produces the same stable 404 envelope", async () => {
    const res = await request(app.getHttpServer()).post("/v1/also-unknown");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
