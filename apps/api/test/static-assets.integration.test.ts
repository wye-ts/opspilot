import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { AgentRunService, ToolRegistry } from "@opspilot/agent-runtime";
import type { PrismaClientHandle } from "@opspilot/database";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AgentRunsController } from "../src/agent-runs/agent-runs.controller";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "../src/common/json-body-parser";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { NotFoundController } from "../src/common/not-found.controller";
import { requestIdMiddleware } from "../src/common/request-id.middleware";
import { createSpaFallbackMiddleware } from "../src/common/spa-fallback.middleware";
import { isWebDistServable } from "../src/common/web-assets";
import type { AgentProviderFactory } from "../src/execution/api-provider-factory";
import {
  AGENT_RUN_SERVICE,
  AGENT_PROVIDER_FACTORY,
  LIVE_RUN_ADMISSION,
  RUN_EXECUTION_CONFIG,
  TOOL_REGISTRY,
  USAGE_HOOKS,
} from "../src/execution/execution.tokens";
import { createLiveRunAdmissionController } from "../src/execution/live-run-admission";
import { parseRunExecutionConfig, type RunExecutionConfig } from "../src/execution/run-execution-config";
import { createApiUsageHooks } from "../src/execution/usage-hooks";
import { HealthController } from "../src/health/health.controller";
import { PRISMA_CLIENT_HANDLE } from "../src/persistence/prisma.tokens";

// Single-origin routing boundary proof (see docs/08-cicd-deployment.md and
// docs/10-engineering-challenges.md Challenge 5) — real Nest HTTP app, real
// Express middleware pipeline reproduced in the exact production order from
// main.ts, Supertest, and a temp-directory web-dist fixture. No database:
// only the AgentRunService and PrismaClientHandle boundaries are mocked.
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
};
const fakeToolRegistry = { find: vi.fn() } as unknown as ToolRegistry;
const fakeProviderFactory: AgentProviderFactory = { createProvider: vi.fn() };
// The safest posture a deployment can be in: deterministic by default, no live
// capability, kill switch off. This suite is about static-asset routing and
// should not depend on the live path at all.
// Derived from the real parser on an empty environment, so the fixture tracks
// the shipped defaults instead of drifting from them.
const runExecutionConfig: RunExecutionConfig = parseRunExecutionConfig({});
const fakeQueryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
const fakePrismaHandle = { prisma: { $queryRaw: fakeQueryRaw } } as unknown as PrismaClientHandle;

@Module({
  // NotFoundController's catch-all route is registered last so the
  // specific endpoint routes are matched first — mirrors app.module.ts's
  // production module-import order.
  controllers: [AgentRunsController, HealthController, NotFoundController],
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
    { provide: PRISMA_CLIENT_HANDLE, useValue: fakePrismaHandle },
  ],
})
class StaticAssetsTestModule {}

async function buildApp(webDistDir: string | undefined): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [StaticAssetsTestModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    abortOnError: false,
    logger: false,
    bodyParser: false,
  });

  // Manually reproduces main.ts's exact production middleware order.
  app.use(requestIdMiddleware);

  if (webDistDir !== undefined && isWebDistServable(webDistDir)) {
    app.useStaticAssets(webDistDir, {
      index: "index.html",
      setHeaders: (res, filePath) => {
        const relativePath = path.relative(webDistDir, filePath);
        if (relativePath === "index.html") {
          res.setHeader("Cache-Control", "no-cache");
        } else if (relativePath.startsWith(`assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.use(createSpaFallbackMiddleware(webDistDir));
  }

  app.use(jsonBodyParser);
  app.use(jsonParserErrorHandler);
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.init();
  return app;
}

describe("with a built web dist present", () => {
  let webDistDir: string;
  let app: NestExpressApplication;

  beforeAll(async () => {
    webDistDir = mkdtempSync(path.join(tmpdir(), "opspilot-web-dist-"));
    mkdirSync(path.join(webDistDir, "assets"), { recursive: true });
    writeFileSync(path.join(webDistDir, "index.html"), '<html><body><div id="root"></div></body></html>');
    writeFileSync(path.join(webDistDir, "assets", "app-abc123.js"), "console.log('hi');");

    app = await buildApp(webDistDir);
  });

  afterAll(async () => {
    await app.close();
    rmSync(webDistDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET / -> 200, text/html, contains the app shell", async () => {
    const res = await request(app.getHttpServer()).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain('<div id="root">');
  });

  it("GET /assets/<fixture>.js -> 200, JS content type, immutable cache header", async () => {
    const res = await request(app.getHttpServer()).get("/assets/app-abc123.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("GET / sets Cache-Control: no-cache on index.html", async () => {
    const res = await request(app.getHttpServer()).get("/");

    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("GET /v1/definitely-not-a-route -> JSON ROUTE_NOT_FOUND envelope, never index.html", async () => {
    const res = await request(app.getHttpServer()).get("/v1/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(res.text).not.toContain('<div id="root">');
  });

  it("GET /v1/agent-runs/not-a-uuid -> the existing validation error envelope, unchanged", async () => {
    const res = await request(app.getHttpServer()).get("/v1/agent-runs/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ROUTE_PARAMETER_INVALID");
  });

  it("GET /deep/link -> 200 index.html (SPA fallback)", async () => {
    const res = await request(app.getHttpServer()).get("/deep/link");

    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it("GET /missing.js -> 404, never the app shell", async () => {
    const res = await request(app.getHttpServer()).get("/missing.js");

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it("POST /unknown -> never the app shell", async () => {
    const res = await request(app.getHttpServer()).post("/unknown");

    expect(res.text).not.toContain('<div id="root">');
  });

  it("GET /v1/health/live -> 200 without touching the mocked database", async () => {
    const res = await request(app.getHttpServer()).get("/v1/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "ok" } });
    expect(fakeQueryRaw).not.toHaveBeenCalled();
  });

  // Express routing is case-insensitive by default (case-sensitive routing
  // is not enabled anywhere in this app), so an alternate-case request to a
  // real API path must reach the same real route the lowercase path does —
  // never the SPA fallback's index.html. Grounded in the actual observed
  // response, not an assumption: this is the real Nest route responding.
  it("GET /V1/health/live -> reaches the real health route (API JSON), never the app shell", async () => {
    const res = await request(app.getHttpServer()).get("/V1/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "ok" } });
    expect(res.text).not.toContain('<div id="root">');
  });
});

describe("with no web dist present", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await buildApp(undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET / -> the pre-existing API-only behavior (JSON 404, not the app shell)", async () => {
    const res = await request(app.getHttpServer()).get("/");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("all /v1/** routes remain unchanged", async () => {
    const res = await request(app.getHttpServer()).get("/v1/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: "ok" } });
  });
});
