import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  appendInvestigationEvent,
  createJob,
  createPrismaClient,
  finalizeCompleted,
  finalizeFailed,
  startRun,
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

// Approval-fixture helpers, mirroring packages/database's own repository-tier
// integration test's fixture pattern exactly (agent-run-approval-repository.
// integration.test.ts) — these consume @opspilot/database's already-public
// createJob/startRun/finalizeCompleted/finalizeFailed exports directly to
// reach run states (RUNNING, FAILED) that the synchronous, FAKE-provider-only
// HTTP API cannot itself produce. This does not modify packages/database.
// Issue #60 Checkpoint B (§5): these approval fixtures now carry the full
// new-write #60 contract. The eligible report is ACTIONABLE with a grounded
// DRAFT_CUSTOMER_REPLY action (groundedBy cites e-1, present in report.evidence);
// the ineligible variant is ADVISORY with zero actions, so the existing
// approval eligibility predicate (status COMPLETED && suggestedActions.length
// >= 1, agent-run-approval-repository.ts) stays the untouched source of truth.
const APPROVAL_ELIGIBLE_REPORT = {
  category: "UNKNOWN" as const,
  summary: "A diagnostic check was performed.",
  rootCause: "Root cause.",
  customerImpact: "Impact.",
  recommendedResolution: "Draft a customer-facing reply acknowledging the diagnostic check for a human to review.",
  confidence: 0.5,
  evidence: [{ evidenceId: "e-1", sourceType: "TOOL_EXECUTION" as const, finding: "f", supports: ["ROOT_CAUSE" as const] }],
  evidenceState: "SUFFICIENT" as const,
  recommendationDisposition: "ACTIONABLE" as const,
  suggestedActions: [
    {
      type: "DRAFT_CUSTOMER_REPLY" as const,
      payload: { subject: "Update", body: "A human will follow up." },
      groundedBy: [{ evidenceId: "e-1" as const, sourceType: "TOOL_EXECUTION" as const }],
    },
  ],
};
const APPROVAL_EMPTY_ACTIONS_REPORT = {
  ...APPROVAL_ELIGIBLE_REPORT,
  suggestedActions: [],
  recommendationDisposition: "ADVISORY" as const,
};
/**
 * The canonical lifecycle prefix a direct (no-tool) run must already carry
 * before terminal finalization will accept it (issue #37 Phase B): terminal
 * finalization reducer-validates the whole stored stream before updating the
 * run's status. `RUN_CREATED` is written by `startRun` itself.
 */
async function appendDirectSuccessPrefix(prisma: PrismaClient, runId: string) {
  await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_VALIDATED" });
}

async function createEligibleApprovalRun(prisma: PrismaClient, ticketId: string) {
  const job = await createJob(prisma, { ticketId, summary: "Approval fixture run" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await appendDirectSuccessPrefix(prisma, started.run.id);
  return finalizeCompleted(prisma, started.run.id, APPROVAL_ELIGIBLE_REPORT);
}

async function createIneligibleEmptyActionsRun(prisma: PrismaClient, ticketId: string) {
  const job = await createJob(prisma, { ticketId, summary: "Approval fixture run" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  await appendDirectSuccessPrefix(prisma, started.run.id);
  return finalizeCompleted(prisma, started.run.id, APPROVAL_EMPTY_ACTIONS_REPORT);
}

async function createRunningApprovalRun(prisma: PrismaClient, ticketId: string) {
  const job = await createJob(prisma, { ticketId, summary: "Approval fixture run" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  return started.run;
}

async function createFailedApprovalRun(prisma: PrismaClient, ticketId: string) {
  const job = await createJob(prisma, { ticketId, summary: "Approval fixture run" });
  const started = await startRun(prisma, job.id, "FAKE", null);
  // The prefix a TOOL_NOT_FOUND run really produces: the provider requested
  // the tool, the registry lookup failed, the run ended in DIAGNOSTIC_EXECUTION.
  await appendInvestigationEvent(prisma, started.run.id, { type: "AGENT_STARTED" });
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_REQUESTED",
    toolCallId: "call-1",
    toolName: "get_service_status",
    // Issue #58 Checkpoint B (§4): first diagnostic request — no evidence yet.
    assessment: { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] },
  });
  await appendInvestigationEvent(prisma, started.run.id, {
    type: "TOOL_FAILED",
    toolCallId: "call-1",
    toolName: "get_service_status",
    failureCode: "TOOL_NOT_FOUND",
  });
  return finalizeFailed(prisma, started.run.id, "TOOL_NOT_FOUND", "DIAGNOSTIC_EXECUTION");
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
      .send({ ticketId: "TICKET-DUP", summary: "first duplicate submission" });
    const second = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-DUP", summary: "second duplicate submission" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });
});

describe("approval", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApiApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it("records a first APPROVED decision on a COMPLETED run with suggested actions -> 201 + Location", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-1");

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/agent-runs/${run.id}/approval`);
    expect(res.body.data.status).toBe("APPROVED");
  });

  it("creates a first REJECTED decision on an eligible run -> 201 + Location, then GET proves REJECTED with reviewerName/note and an ISO decidedAt", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-2");

    const postRes = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "REJECTED", reviewerName: "jacky", note: "Not appropriate." });
    expect(postRes.status).toBe(201);
    expect(postRes.headers.location).toBe(`/v1/agent-runs/${run.id}/approval`);

    const getRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}/approval`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.status).toBe("REJECTED");
    expect(getRes.body.data.reviewerName).toBe("jacky");
    expect(getRes.body.data.note).toBe("Not appropriate.");
    expect(typeof getRes.body.data.decidedAt).toBe("string");
    expect(new Date(getRes.body.data.decidedAt as string).toISOString()).toBe(getRes.body.data.decidedAt);
  });

  it("replays an identical APPROVED decision -> 200 with the original decidedAt unchanged", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-3");
    const body = { decision: "APPROVED" as const, reviewerName: "jacky" };

    const first = await request(testApp.app.getHttpServer()).post(`/v1/agent-runs/${run.id}/approval`).send(body);
    const second = await request(testApp.app.getHttpServer()).post(`/v1/agent-runs/${run.id}/approval`).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.location).toBeUndefined();
    expect(second.body.data.decidedAt).toBe(first.body.data.decidedAt);
  });

  it("rejects a same-decision-different-note replay with 409 AGENT_RUN_APPROVAL_ALREADY_DECIDED", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-4");
    await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky", note: "a" });

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky", note: "b" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_RUN_APPROVAL_ALREADY_DECIDED");
  });

  it("rejects a same-decision-different-reviewerName replay with 409 AGENT_RUN_APPROVAL_ALREADY_DECIDED", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-5");
    await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "someone-else" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_RUN_APPROVAL_ALREADY_DECIDED");
  });

  it("rejects a conflicting opposite decision with 409, leaving the stored row unchanged", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-6");
    const first = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    const conflict = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "REJECTED", reviewerName: "jacky" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("AGENT_RUN_APPROVAL_ALREADY_DECIDED");

    const getRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}/approval`);
    expect(getRes.body.data.status).toBe("APPROVED");
    expect(getRes.body.data.decidedAt).toBe(first.body.data.decidedAt);
  });

  it("rejects recording a decision on a RUNNING run with 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE", async () => {
    const run = await createRunningApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-7");

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_RUN_NOT_APPROVAL_ELIGIBLE");
  });

  it("rejects recording a decision on a FAILED run with 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE", async () => {
    const run = await createFailedApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-8");

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_RUN_NOT_APPROVAL_ELIGIBLE");
  });

  it("rejects recording a decision on a COMPLETED run with an empty suggestedActions array with 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE", async () => {
    const run = await createIneligibleEmptyActionsRun(testApp.handle.prisma, "TICKET-API-APPROVAL-9");

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("AGENT_RUN_NOT_APPROVAL_ELIGIBLE");
  });

  it("returns 404 AGENT_RUN_NOT_FOUND for a well-formed but nonexistent runId, on both GET and POST", async () => {
    const missingRunId = "00000000-0000-0000-0000-000000000000";

    const getRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${missingRunId}/approval`);
    expect(getRes.status).toBe(404);
    expect(getRes.body.error.code).toBe("AGENT_RUN_NOT_FOUND");

    const postRes = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${missingRunId}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });
    expect(postRes.status).toBe(404);
    expect(postRes.body.error.code).toBe("AGENT_RUN_NOT_FOUND");
  });

  it("two concurrent conflicting decisions: exactly one 201, one 409, exactly one row persisted", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-10");

    const [first, second] = await Promise.all([
      request(testApp.app.getHttpServer())
        .post(`/v1/agent-runs/${run.id}/approval`)
        .send({ decision: "APPROVED", reviewerName: "a" }),
      request(testApp.app.getHttpServer())
        .post(`/v1/agent-runs/${run.id}/approval`)
        .send({ decision: "REJECTED", reviewerName: "b" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const getRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}/approval`);
    expect(["APPROVED", "REJECTED"]).toContain(getRes.body.data.status);

    const count = await testApp.handle.prisma.agentRunApproval.count({ where: { runId: run.id } });
    expect(count).toBe(1);
  });

  it("two concurrent identical decisions: exactly one 201, one 200, exactly one row persisted, same decidedAt", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-11");
    const body = { decision: "APPROVED" as const, reviewerName: "jacky" };

    const [first, second] = await Promise.all([
      request(testApp.app.getHttpServer()).post(`/v1/agent-runs/${run.id}/approval`).send(body),
      request(testApp.app.getHttpServer()).post(`/v1/agent-runs/${run.id}/approval`).send(body),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(first.body.data.decidedAt).toBe(second.body.data.decidedAt);

    const count = await testApp.handle.prisma.agentRunApproval.count({ where: { runId: run.id } });
    expect(count).toBe(1);
  });

  it("GET reflects a decision recorded via a different app instance (appA writes, appB reads)", async () => {
    const appA = await createTestApiApp();
    let runId: string;
    try {
      const run = await createEligibleApprovalRun(appA.handle.prisma, "TICKET-API-APPROVAL-12");
      runId = run.id;

      const postRes = await request(appA.app.getHttpServer())
        .post(`/v1/agent-runs/${runId}/approval`)
        .send({ decision: "APPROVED", reviewerName: "jacky" });
      expect(postRes.status).toBe(201);
    } finally {
      await appA.app.close();
    }

    const appB = await createTestApiApp();
    try {
      const getRes = await request(appB.app.getHttpServer()).get(`/v1/agent-runs/${runId}/approval`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.status).toBe("APPROVED");
      expect(getRes.body.data.reviewerName).toBe("jacky");
    } finally {
      await appB.app.close();
    }
  });

  it("an ordinary deterministic ticket completes with an ADVISORY, empty-suggestedActions report, and GET .../approval returns NOT_ELIGIBLE", async () => {
    const jobRes = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-API-APPROVAL-ORDINARY", summary: "billing errors reported" });
    const jobId = jobRes.body.data.id as string;

    const runRes = await request(testApp.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send();
    expect(runRes.status).toBe(201);
    // Issue #60 Checkpoint B: an ordinary deterministic report stays
    // ADVISORY + [] through persistence and readback.
    expect(runRes.body.data.outcome.report.recommendationDisposition).toBe("ADVISORY");
    expect(runRes.body.data.outcome.report.suggestedActions).toEqual([]);
    const runId = runRes.body.data.run.id as string;

    const approvalRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${runId}/approval`);
    expect(approvalRes.status).toBe(200);
    // The existing eligibility source of truth (agent-run-approval-repository)
    // reports NOT_ELIGIBLE for zero suggested actions.
    expect(approvalRes.body.data.status).toBe("NOT_ELIGIBLE");
  });

  it("TICKET-APPROVAL-DEMO completes with one ACTIONABLE grounded DRAFT_CUSTOMER_REPLY; GET is PENDING, POST approves it, GET is then APPROVED", async () => {
    const jobRes = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval workflow demo" });
    const jobId = jobRes.body.data.id as string;

    const runRes = await request(testApp.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send();
    expect(runRes.status).toBe(201);
    // Issue #60 Checkpoint B (§5): the completed report persists
    // recommendationDisposition ACTIONABLE, >= 1 suggested action, and the
    // action's groundedBy is a real report evidence locator (the demo run's
    // completed tool call, `<jobId>-call-1`).
    expect(runRes.body.data.outcome.report.recommendationDisposition).toBe("ACTIONABLE");
    expect(runRes.body.data.outcome.report.suggestedActions).toHaveLength(1);
    expect(runRes.body.data.outcome.report.suggestedActions[0].type).toBe("DRAFT_CUSTOMER_REPLY");
    expect(runRes.body.data.outcome.report.evidence[0].evidenceId).toBe(`${jobId}-call-1`);
    expect(runRes.body.data.outcome.report.suggestedActions[0].groundedBy).toEqual([
      { evidenceId: `${jobId}-call-1`, sourceType: "TOOL_EXECUTION" },
    ]);
    const runId = runRes.body.data.run.id as string;

    const pendingRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${runId}/approval`);
    expect(pendingRes.status).toBe(200);
    // The existing approval path reports the run as eligible / pending.
    expect(pendingRes.body.data.status).toBe("PENDING");

    const postRes = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${runId}/approval`)
      .send({ decision: "APPROVED", reviewerName: "demo-reviewer", note: "Approved via test." });
    expect(postRes.status).toBe(201);

    const approvedRes = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${runId}/approval`);
    expect(approvedRes.status).toBe(200);
    expect(approvedRes.body.data.status).toBe("APPROVED");
  });

  it("an approval row on an ineligible run -> GET returns a safe 500 INTERNAL_DATA_INVALID", async () => {
    const run = await createRunningApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-13");
    await testApp.handle.prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;

    const res = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}/approval`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_DATA_INVALID");
  });

  it("the same impossible state -> POST also returns a safe 500 INTERNAL_DATA_INVALID", async () => {
    const run = await createRunningApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-14");
    await testApp.handle.prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;

    const res = await request(testApp.app.getHttpServer())
      .post(`/v1/agent-runs/${run.id}/approval`)
      .send({ decision: "APPROVED", reviewerName: "jacky" });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_DATA_INVALID");
  });

  it("a stored approval row with a runtime-invalid but DB-constraint-valid shape -> GET returns a safe 500 INTERNAL_DATA_INVALID", async () => {
    const run = await createEligibleApprovalRun(testApp.handle.prisma, "TICKET-API-APPROVAL-15");
    // ' jacky ' passes agent_run_approvals_reviewer_name_not_blank_chk
    // (btrim(...) > 0) but fails AgentRunApprovalRowSchema's canonical-
    // whitespace revalidation on read (packages/database/src/validation.ts).
    await testApp.handle.prisma
      .$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', ' jacky ')`;

    const res = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}/approval`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_DATA_INVALID");
  });
});

/**
 * Issue #37 Phase B — the read surface after the switchover.
 *
 * The response SHAPE is unchanged: same `{ job, run, trace, outcome }` DTO,
 * no canonical `events[]`, no `clientRequestId`. What changes is that a
 * RUNNING run now has rows to project, and that the two early tool failures
 * project a `TOOL_REQUESTED` the pre-#37 response never carried.
 */
describe("GET /v1/agent-runs/:runId — canonical projection", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApiApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it("returns a PARTIAL projected legacy trace for a RUNNING run, through the existing shape", async () => {
    const prisma = testApp.handle.prisma;
    const job = await createJob(prisma, {
      ticketId: "TICKET-API-RUNNING-1",
      summary: "A mid-flight investigation run for partial trace projection",
    });
    const started = await startRun(prisma, job.id, "FAKE", null);

    // Mid-execution: the agent started and requested a tool, nothing more.
    await appendInvestigationEvent(prisma, started.run.id, { type: "AGENT_STARTED" });
    await appendInvestigationEvent(prisma, started.run.id, {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
      // Issue #58 Checkpoint B (§4): first diagnostic request — no evidence yet.
      assessment: { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] },
    });

    const res = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${started.run.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toEqual({ type: "RUNNING" });
    // Lifecycle-only events (RUN_CREATED, AGENT_STARTED) stay hidden.
    expect(res.body.data.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);

    // The response shape is unchanged: no canonical events[] anywhere, and the
    // internal idempotency key is never exposed.
    expect(Object.keys(res.body.data).sort()).toEqual(["job", "outcome", "run", "trace"]);
    expect(res.body.data).not.toHaveProperty("events");
    expect(JSON.stringify(res.body)).not.toContain("clientRequestId");
  });

  it("projects TOOL_REQUESTED but never TOOL_FAILED for an early tool failure", async () => {
    const run = await createFailedApprovalRun(testApp.handle.prisma, "TICKET-API-EARLY-TOOL-FAIL");

    const res = await request(testApp.app.getHttpServer()).get(`/v1/agent-runs/${run.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toMatchObject({ type: "FAILED", code: "TOOL_NOT_FOUND" });
    // The documented, intentional content change: canonical persistence records
    // TOOL_REQUESTED before registry lookup, so it now surfaces here. TOOL_FAILED
    // remains hidden — TraceTimeline has no case for it.
    expect(res.body.data.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
    expect(JSON.stringify(res.body.data.trace)).not.toContain("TOOL_FAILED");
  });

  it("keeps a completed FAKE run's trace in the legacy union, with REPORT_GENERATED", async () => {
    const createRes = await request(testApp.app.getHttpServer())
      .post("/v1/agent-jobs")
      .send({ ticketId: "TICKET-API-COMPLETED-1", summary: "A full synchronous FAKE investigation run" });
    const jobId = createRes.body.data.id;

    const runRes = await request(testApp.app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`).send({});
    expect(runRes.status).toBe(201);

    const traceTypes = runRes.body.data.trace.map((event: { type: string }) => event.type);
    // Only the four legacy variants ever reach an existing consumer.
    for (const type of traceTypes) {
      expect(["RETRIEVAL_COMPLETED", "TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]).toContain(type);
    }
    expect(traceTypes).toContain("REPORT_GENERATED");
    expect(runRes.body.data).not.toHaveProperty("events");
  });
});
