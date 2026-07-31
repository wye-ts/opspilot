import { randomUUID } from "node:crypto";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import {
  createJob,
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
 * Idempotent LIVE creation and legacy-context eligibility, through the REAL HTTP
 * stack against a REAL PostgreSQL — not a mocked service.
 *
 * NO PROVIDER IS EVER REACHED, and every case below is arranged so that this is
 * a property of the code path rather than of luck:
 *
 *   400  rejected at step 1b, before admission even runs;
 *   422  rejected inside the authoritative transaction, before the reservation;
 *   200  answered by the replay lookup, which returns BEFORE any provider is
 *        constructed — the pre-existing run row is inserted here directly, so no
 *        request in this file ever executes an agent.
 *
 * The configured Anthropic key is a placeholder and no network call is made. The
 * assertions on `agent_runs` and `live_run_budget` are what prove it: a provider
 * call is only ever made for a run this API created, so "no new row and no new
 * reservation" is "no provider call".
 */

const PLACEHOLDER_KEY = "sk-ant-test-do-not-use-0123456789";
const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";
const TOKEN_HEADER = "X-OpsPilot-Demo-Token";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** A report shaped the way a COMPLETED row must carry one. */
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
  LIVE_RUN_DAILY_LIMIT: "10",
  LIVE_RUN_DAILY_COST_CEILING_USD: "1.00",
  // Raised so a sequence of requests in one suite is never refused at step 5
  // instead of at the step under test.
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
  /**
   * THE NO-SPEND GUARD, asserted after every single test in this file.
   *
   * A LIVE provider call is impossible without a committed budget reservation:
   * the reservation is taken inside the authoritative transaction, and the
   * provider is only ever constructed AFTER that transaction commits. So "no row
   * in live_run_budget" is not a proxy for "no provider call" — it is the same
   * fact, read from the one place that cannot be bypassed.
   *
   * Asserted here rather than per test so a future case added to this file
   * cannot quietly start spending: it has to arrange its LIVE request to be
   * refused or replayed, exactly as every case below does.
   */
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM live_run_budget`;
  const reservations = Number(row?.count ?? 0n);

  await prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
  await prisma.$executeRaw`DELETE FROM live_run_budget`;

  expect(reservations, "a LIVE reservation was committed — this suite must never execute a paid run").toBe(0);
});

function post(jobId: string) {
  return request(app.getHttpServer()).post(`/v1/agent-jobs/${jobId}/runs`);
}

async function newJob(ticketId: string) {
  return createJob(prisma, { ticketId, summary: `HTTP coverage for ${ticketId}` });
}

/** A job today's `POST /v1/agent-jobs` would refuse, written the way history did. */
async function legacyJob(ticketId: string, summary: string): Promise<string> {
  const context = JSON.stringify({ ticketId, summary });
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO agent_jobs (ticket_context, external_ticket_id)
    VALUES (${context}::jsonb, ${ticketId})
    RETURNING id`;
  return row!.id;
}

/**
 * A LIVE run that ALREADY EXISTS for a key — the durable state left behind when
 * the provider executed and the response was lost, or finalization rolled back.
 *
 * Inserted directly rather than produced by a request, precisely so that no test
 * in this file has to execute a paid run to reach the replay path.
 */
async function existingLiveRun(
  jobId: string,
  clientRequestId: string,
  status: "RUNNING" | "COMPLETED" | "FAILED" = "RUNNING",
) {
  // agent_runs_terminal_outcome_chk ties status to finished_at/report/
  // failure_code, so each status is written with the shape it requires.
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

async function runCount(jobId: string) {
  return prisma.agentRun.count({ where: { jobId } });
}

async function budgetRowCount() {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM live_run_budget`;
  return Number(row?.count ?? 0n);
}

describe("the Idempotency-Key header", () => {
  it.each([
    ["absent", undefined],
    ["blank", ""],
    ["malformed", "not-a-uuid"],
    ["oversized", "a".repeat(4_000)],
  ])("refuses a LIVE run with a %s key, with 400 and no durable trace", async (_label, key) => {
    const job = await newJob("TKT-http-key-invalid");

    const pending = post(job.id).set(TOKEN_HEADER, DEMO_TOKEN);
    if (key !== undefined) pending.set(IDEMPOTENCY_HEADER, key);
    const response = await pending.send({ providerMode: "LIVE" }).expect(400);

    expect(response.body.error.code).toBe("LIVE_RUN_IDEMPOTENCY_KEY_INVALID");
    // Rejected at step 1b, so nothing downstream ran: no run row, and the day's
    // budget row was never even created.
    expect(await runCount(job.id)).toBe(0);
    expect(await budgetRowCount()).toBe(0);
  });

  it("never echoes the offending value", async () => {
    const job = await newJob("TKT-http-key-echo");

    const response = await post(job.id)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, "definitely-not-a-uuid")
      .send({ providerMode: "LIVE" })
      .expect(400);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("definitely-not-a-uuid");
    expect(serialized).not.toContain(DEMO_TOKEN);
  });

  it("is required BEFORE the access token is checked", async () => {
    const job = await newJob("TKT-http-key-before-token");

    // Neither header. The key answers first, because request-shape validation
    // precedes admission.
    const response = await post(job.id).send({ providerMode: "LIVE" }).expect(400);

    expect(response.body.error.code).toBe("LIVE_RUN_IDEMPOTENCY_KEY_INVALID");
  });

  it("is not required for FAKE, which stores no key", async () => {
    const job = await newJob("TKT-http-fake-no-key");

    const response = await post(job.id).send({ providerMode: "FAKE" }).expect(201);

    expect(response.body.data.run.providerMode).toBe("FAKE");
    const rows = await prisma.agentRun.findMany({
      where: { jobId: job.id },
      select: { clientRequestId: true },
    });
    expect(rows).toEqual([{ clientRequestId: null }]);
  });

  it("leaves FAKE deterministic and repeatable with no key at all", async () => {
    const job = await newJob("TKT-http-fake-repeat");

    await post(job.id).send({ providerMode: "FAKE" }).expect(201);
    await post(job.id).send({ providerMode: "FAKE" }).expect(201);

    // Two genuine runs. A deterministic run spends nothing, so repeating one is
    // harmless and is deliberately NOT made idempotent.
    expect(await runCount(job.id)).toBe(2);
  });
});

describe("replaying a key that already names a run", () => {
  it("answers 200 with the existing RUNNING run, creating nothing", async () => {
    const job = await newJob("TKT-http-replay-running");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key, "RUNNING");

    const response = await post(job.id)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(200);

    // 200, not 201: this request created nothing.
    expect(response.body.data.run.id).toBe(runId);
    expect(response.body.data.run.status).toBe("RUNNING");
    expect(response.headers.location).toBe(`/v1/agent-runs/${runId}`);
    // The three facts that together mean "no provider call": no second row, no
    // attempt consumed, and no reservation taken.
    expect(await runCount(job.id)).toBe(1);
    expect(await budgetRowCount()).toBe(0);
  });

  it.each(["COMPLETED", "FAILED"] as const)("answers 200 for an existing %s run too", async (status) => {
    const job = await newJob(`TKT-http-replay-${status}`);
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key, status);

    const response = await post(job.id)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(200);

    expect(response.body.data.run.id).toBe(runId);
    expect(await runCount(job.id)).toBe(1);
    expect(await budgetRowCount()).toBe(0);
  });

  it("replays repeatedly without ever accumulating a second run", async () => {
    const job = await newJob("TKT-http-replay-repeat");
    const key = randomUUID();
    const runId = await existingLiveRun(job.id, key);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post(job.id)
        .set(TOKEN_HEADER, DEMO_TOKEN)
        .set(IDEMPOTENCY_HEADER, key)
        .send({ providerMode: "LIVE" })
        .expect(200);
      expect(response.body.data.run.id).toBe(runId);
    }

    expect(await runCount(job.id)).toBe(1);
    expect(await budgetRowCount()).toBe(0);
  });

  it("does not let one job replay another job's run", async () => {
    const owner = await newJob("TKT-http-replay-owner");
    // The other job is deliberately INELIGIBLE, so this request is refused
    // inside the transaction rather than executing a real run. That keeps the
    // suite's no-spend invariant intact while still proving the thing under
    // test: uniqueness is (job_id, client_request_id), so the key finds nothing
    // to replay here and the request continues to the ordinary rules.
    const other = await legacyJob("TKT-http-replay-other", "short");
    const key = randomUUID();
    const ownerRunId = await existingLiveRun(owner.id, key);

    const response = await post(other)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(422);

    // The failure that would matter is a 200 carrying the OWNER's run. It never
    // gets close: the lookup is scoped to the job in the URL.
    expect(JSON.stringify(response.body)).not.toContain(ownerRunId);
    expect(await runCount(other)).toBe(0);
    // And the owner's run is untouched.
    expect(await runCount(owner.id)).toBe(1);
  });

  it("still requires the access token for a replay", async () => {
    const job = await newJob("TKT-http-replay-unauth");
    const key = randomUUID();
    await existingLiveRun(job.id, key);

    // Idempotency is not an authentication bypass. A replay reads a run row, and
    // the protected endpoint stays protected.
    const response = await post(job.id)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(401);

    expect(response.body.error.code).toBe("LIVE_RUN_ACCESS_DENIED");
  });
});

describe("a job created under older input rules", () => {
  it("is refused for LIVE with a stable 422 and an actionable message", async () => {
    const jobId = await legacyJob("TKT-http-legacy", "Disk full");

    const response = await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(422);

    expect(response.body.error.code).toBe("LIVE_RUN_CONTEXT_INVALID");
    expect(response.body.error.message).toContain("15–2000 character summary");
    // No attempt consumed, no reservation taken, no run created — the
    // transaction rolled back before any of it.
    expect(await runCount(jobId)).toBe(0);
    expect(await budgetRowCount()).toBe(0);
  });

  it("leaks nothing about the stored value or the validation internals", async () => {
    // Distinctive AND ineligible: nine characters, well under the floor, so the
    // request is refused inside the transaction and never reaches a provider.
    const jobId = await legacyJob("TKT-http-legacy-opaque", "Sh4rd9Dsk");

    const response = await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(422);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("Sh4rd9Dsk");
    expect(serialized).not.toMatch(/ticket_context|zod|SELECT|too_small|invalid_type/i);
    expect(serialized).not.toContain(DEMO_TOKEN);
  });

  it("still serves the same job over GET and over FAKE", async () => {
    const jobId = await legacyJob("TKT-http-legacy-compatible", "Disk full");

    // Stored-read compatibility is untouched: the run is created, and reading it
    // back returns the stored summary exactly as persisted.
    const created = await post(jobId).send({ providerMode: "FAKE" }).expect(201);
    const runId = created.body.data.run.id;

    const read = await request(app.getHttpServer()).get(`/v1/agent-runs/${runId}`).expect(200);
    expect(read.body.data.job.summary).toBe("Disk full");
  });

  it("returns 422 every time, never intermittently succeeding", async () => {
    const jobId = await legacyJob("TKT-http-legacy-stable", "short");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(jobId)
        .set(TOKEN_HEADER, DEMO_TOKEN)
        .set(IDEMPOTENCY_HEADER, randomUUID())
        .send({ providerMode: "LIVE" })
        .expect(422);
      expect(response.body.error.code).toBe("LIVE_RUN_CONTEXT_INVALID");
    }

    expect(await runCount(jobId)).toBe(0);
    expect(await budgetRowCount()).toBe(0);
  });

  it("refuses a summary padded to hundreds of kilobytes, however valid its trimmed value", async () => {
    // The headline risk a parse-only eligibility check left open: 200 kB of
    // whitespace around 26 valid characters. The trimmed length sails through
    // 15..2000, and the prompt that would have been paid for is 200,000
    // characters long — because the provider is sent the STORED value, not the
    // schema's trimmed output.
    const inner = "Elevated error rate on API";
    const jobId = await legacyJob(
      "TKT-http-legacy-padded",
      `${" ".repeat(100_000)}${inner}${" ".repeat(100_000)}`,
    );

    const response = await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(422);

    expect(response.body.error.code).toBe("LIVE_RUN_CONTEXT_INVALID");
    expect(await runCount(jobId)).toBe(0);
    // The suite-wide no-spend guard checks this too; asserting it here as well
    // makes the claim local to the case that most needs it.
    expect(await budgetRowCount()).toBe(0);
  });

  it("refuses an over-long legacy ticket id on the same rule", async () => {
    const jobId = await legacyJob(`TKT-${"z".repeat(70)}`, "Elevated API error rate on billing");

    const response = await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(422);

    expect(response.body.error.code).toBe("LIVE_RUN_CONTEXT_INVALID");
    expect(await budgetRowCount()).toBe(0);
  });

  it("replays an existing run for a legacy job rather than refusing it", async () => {
    const jobId = await legacyJob("TKT-http-legacy-replay", "short");
    const key = randomUUID();
    const runId = await existingLiveRun(jobId, key);

    // The key lookup precedes the eligibility check, so a run that already
    // exists — and was therefore already paid for — is still recoverable. A rule
    // about what may START cannot change what a finished run cost.
    const response = await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, key)
      .send({ providerMode: "LIVE" })
      .expect(200);

    expect(response.body.data.run.id).toBe(runId);

    // A NEW key against the same ineligible job is still refused.
    await post(jobId)
      .set(TOKEN_HEADER, DEMO_TOKEN)
      .set(IDEMPOTENCY_HEADER, randomUUID())
      .send({ providerMode: "LIVE" })
      .expect(422);
  });
});
