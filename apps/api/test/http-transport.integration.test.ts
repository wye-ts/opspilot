import { Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import { PersistenceError } from "@opspilot/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentJobsController } from "../src/agent-jobs/agent-jobs.controller";
import { AgentRunsController } from "../src/agent-runs/agent-runs.controller";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { NotFoundController } from "../src/common/not-found.controller";
import { requestIdMiddleware } from "../src/common/request-id.middleware";
import type { DeterministicProviderFactory } from "../src/execution/deterministic-provider-factory";
import { AGENT_RUN_SERVICE, DETERMINISTIC_PROVIDER_FACTORY, TOOL_REGISTRY } from "../src/execution/execution.tokens";

// Mocked-service HTTP transport suite — real Nest HTTP app, real Express
// middleware pipeline (reproduced in the exact production order), Supertest.
// No PostgreSQL: only @opspilot/agent-runtime's AgentRunService boundary is
// mocked (see docs/12-agent-run-api.md).
const fakeAgentRunService: AgentRunService = {
  createAgentJob: vi.fn(),
  executeAndPersist: vi.fn(),
  retryFinalization: vi.fn(),
  getAgentRun: vi.fn(),
  getAgentJob: vi.fn(),
};
const fakeToolRegistry = { find: vi.fn() } as unknown as ToolRegistry;
const fakeProviderFactory: DeterministicProviderFactory = { createProvider: vi.fn() };

@Module({
  // NotFoundController's catch-all route is registered last so the
  // specific endpoint routes are matched first — mirrors app.module.ts's
  // production module-import order.
  controllers: [AgentJobsController, AgentRunsController, NotFoundController],
  providers: [
    { provide: AGENT_RUN_SERVICE, useValue: fakeAgentRunService },
    { provide: TOOL_REGISTRY, useValue: fakeToolRegistry },
    { provide: DETERMINISTIC_PROVIDER_FACTORY, useValue: fakeProviderFactory },
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
      .send({ ticketId: "T", summary: "s" });

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
