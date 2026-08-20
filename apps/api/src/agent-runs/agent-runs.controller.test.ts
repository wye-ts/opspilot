import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import type { AgentJobRecord, PersistedAgentRun } from "@opspilot/database";
import { LiveRunAdmissionError, PersistenceError } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { ApiError, buildErrorEnvelope } from "../errors/api-error";
import type { AgentProviderFactory } from "../execution/api-provider-factory";
import type { LiveRunAdmissionDecisionLogger } from "../execution/live-run-budget-log";
import { createLiveRunAdmissionController } from "../execution/live-run-admission";
import { parseRunExecutionConfig, type RunExecutionConfig } from "../execution/run-execution-config";
import { createApiUsageHooks } from "../execution/usage-hooks";
import { AgentRunsController } from "./agent-runs.controller";

const JOB: AgentJobRecord = {
  id: "job-1",
  ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors" },
  externalTicketId: "TICKET-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PERSISTED_RUN: PersistedAgentRun = {
  job: JOB,
  run: {
    id: "run-1",
    jobId: "job-1",
    attemptNumber: 1,
    status: "COMPLETED",
    providerMode: "FAKE",
    modelIdentifier: null,
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:02:00.000Z",
    createdAt: "2026-01-01T00:01:00.000Z",
    // FAKE runs never carry a measured cost — see AgentRunRecord.
    estimatedCostNanoUsd: null,
    possibleUnobservedCost: false,
  },
  trace: [{ type: "REPORT_GENERATED" }],
  outcome: {
    type: "COMPLETED",
    report: {
      category: "SERVICE_DEGRADATION",
      summary: "s",
      rootCause: "r",
      customerImpact: "c",
      recommendedResolution: "rr",
      confidence: 0.5,
      evidence: [{ evidenceId: "run-1-call-1", sourceType: "TOOL_EXECUTION", finding: "f" }],
      suggestedActions: [],
    },
  },
};

function buildFakeService(overrides: Partial<AgentRunService> = {}): AgentRunService {
  return {
    createAgentJob: vi.fn(),
    executeAndPersist: vi.fn(),
    /**
     * Defaults to "no run bears this key".
     *
     * The safe default for a fixture, and deliberately so: `absent` is what sends
     * a request on to the full new-run gauntlet, which is what every pre-existing
     * test in this file was written to exercise. A default of `found` would have
     * quietly turned all of them into replay tests that assert nothing about
     * admission.
     */
    replayLiveRun: vi.fn().mockResolvedValue({ replay: "absent" }),
    retryFinalization: vi.fn(),
    reconcileLiveRunBudget: vi.fn(),
    getAgentRun: vi.fn(),
    getAgentJob: vi.fn(),
    ...overrides,
  } as AgentRunService;
}

function buildFakeToolRegistry(): ToolRegistry {
  return { find: vi.fn() } as unknown as ToolRegistry;
}

function buildFakeProviderFactory(): AgentProviderFactory {
  return { createProvider: vi.fn() };
}

function buildFakeResponse() {
  // `once`/`off` are what createRequestAbortHandle attaches; a LIVE run needs
  // them, and a FAKE run never touches them. `cookie` is what
  // authorizePublicTrial's visitor-identity stage attaches (issue #39).
  return {
    status: vi.fn(),
    setHeader: vi.fn(),
    cookie: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writableFinished: false,
  } as unknown as import("express").Response;
}

// A well-formed default so every pre-existing LIVE test keeps exercising what it
// was written to exercise. The tests that care about the key supply their own —
// including `null`, which means "send no header at all".
const DEFAULT_IDEMPOTENCY_KEY = "3f6b1d2c-8f4a-4a1e-9f0b-2c7d5e8a1b34";

function buildFakeRequest(
  options: {
    readonly token?: string;
    readonly ip?: string;
    readonly idempotencyKey?: string | null;
    /** Issue #39 — the solved Turnstile token, PUBLIC trial requests only. */
    readonly turnstileToken?: string;
  } = {},
): import("express").Request {
  const idempotencyKey =
    options.idempotencyKey === undefined ? DEFAULT_IDEMPOTENCY_KEY : options.idempotencyKey;
  return {
    ip: options.ip ?? "203.0.113.7",
    headers: {},
    header: (name: string) => {
      const lower = name.toLowerCase();
      if (lower === "x-opspilot-demo-token") return options.token;
      if (lower === "x-opspilot-turnstile-token") return options.turnstileToken;
      // `null` models an absent header — `header()` returns undefined for one,
      // which is exactly what the schema must reject.
      if (lower === "idempotency-key") return idempotencyKey ?? undefined;
      return undefined;
    },
  } as unknown as import("express").Request;
}

/**
 * Defaults to the safest posture a deployment can be in: deterministic by
 * default, no live capability, kill switch off. Every LIVE test opts in
 * explicitly, so nothing accidentally exercises the live path.
 */
function buildConfig(overrides: Partial<RunExecutionConfig> = {}): RunExecutionConfig {
  // Derived from the real parser on an empty environment rather than from a
  // hand-written literal, so the fixture cannot drift away from the shipped
  // defaults as safeguards are added.
  return { ...parseRunExecutionConfig({}), ...overrides };
}

/**
 * Builds the controller with the REAL admission controller rather than a fake.
 *
 * Admission is pure apart from the injected `isBudgetOpen`, so using the real one
 * means these tests exercise the actual canonical order — capability, kill
 * switch, token, rate limit, budget pre-check, concurrency — instead of a stub
 * that could drift away from it.
 */
function buildController(
  config: RunExecutionConfig,
  overrides: {
    readonly service?: AgentRunService;
    readonly providerFactory?: AgentProviderFactory;
    readonly isBudgetOpen?: () => Promise<boolean>;
    readonly logDecision?: LiveRunAdmissionDecisionLogger;
    // Issue #39 — only meaningful when `config.livePublicTrial.enabled`.
    readonly turnstileVerifier?: Parameters<typeof createLiveRunAdmissionController>[0]["turnstileVerifier"];
    readonly visitorIdentity?: Parameters<typeof createLiveRunAdmissionController>[0]["visitorIdentity"];
  } = {},
) {
  return new AgentRunsController(
    overrides.service ?? buildFakeService(),
    buildFakeToolRegistry(),
    overrides.providerFactory ?? buildFakeProviderFactory(),
    config,
    createLiveRunAdmissionController({
      config,
      isBudgetOpen: overrides.isBudgetOpen ?? (async () => true),
      // Silent by default so the decision line does not drown the suite's
      // output; the tests that care about it inject a recorder.
      logDecision: overrides.logDecision ?? (() => undefined),
      ...(overrides.turnstileVerifier ? { turnstileVerifier: overrides.turnstileVerifier } : {}),
      ...(overrides.visitorIdentity ? { visitorIdentity: overrides.visitorIdentity } : {}),
    }),
    createApiUsageHooks(),
  );
}

const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";

// Capability present, kill switch on, token configured — the only posture in
// which a LIVE run can actually be admitted.
function servableConfig(overrides: Partial<RunExecutionConfig> = {}): RunExecutionConfig {
  return buildConfig({
    ...parseRunExecutionConfig({
      ANTHROPIC_API_KEY: "sk-ant-test-do-not-use-0123456789",
      ANTHROPIC_MODEL: "claude-sonnet-5",
      LIVE_AGENT_RUNS_ENABLED: "true",
      LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
      // Required once LIVE is servable — see run-execution-config.ts.
      ANTHROPIC_MAX_RETRIES: "0",
    }),
    ...overrides,
  });
}

const LIVE_CAPABILITY_PRESENT = {
  kind: "present",
  selection: { providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" },
  // Never read on these paths: the fake service short-circuits before any
  // provider is built, so no client is ever constructed from it.
  anthropic: { apiKey: "unused-in-tests", timeoutMs: 45_000, maxRetries: 1 },
} as const satisfies RunExecutionConfig["liveCapability"];

describe("AgentRunsController.createAgentRun", () => {
  it("persists a run, sets 201 + Location, and never pre-reads the job via getAgentJob", async () => {
    const getAgentJob = vi.fn();
    const executeAndPersist = vi.fn().mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN });
    const service = buildFakeService({ executeAndPersist, getAgentJob });
    const controller = buildController(buildConfig(), { service: service });
    const res = buildFakeResponse();

    const result = await controller.createAgentRun("job-1", {}, buildFakeRequest(), res);

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", providerMode: "FAKE" }),
    );
    expect(getAgentJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/v1/agent-runs/run-1");
    expect(result).toEqual({ data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }) });
  });

  it("maps a thrown AgentRunServiceError to 500 AGENT_EXECUTION_CRASHED with the stable runId", async () => {
    const executeAndPersist = vi
      .fn()
      .mockRejectedValue(new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-9", { cause: new Error("boom") }));
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "AGENT_EXECUTION_CRASHED",
      status: 500,
      runId: "run-9",
    });
  });

  it("maps a run-creation persistence-unavailable result to AGENT_JOB_NOT_FOUND when the job row was not found", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "run-creation",
      error: new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "AGENT_JOB_NOT_FOUND",
      status: 404,
    });
  });

  it("maps a finalization persistence-unavailable result to INTERNAL_DATA_INVALID when the run row was not found", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "finalization",
      runId: "run-1",
      agentResult: { status: "completed", report: PERSISTED_RUN.outcome, trace: [] },
      error: new PersistenceError("PERSISTENCE_NOT_FOUND", "run vanished"),
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "INTERNAL_DATA_INVALID",
      status: 500,
    });
  });

  // Issue #37 Phase B — a canonical lifecycle event could not be persisted
  // mid-run. The run is left RUNNING; the caller gets the ordinary
  // persistence-unavailable behavior for its underlying cause.
  it("maps an event-emission persistence-unavailable result to 503 PERSISTENCE_UNAVAILABLE", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "event-emission",
      runId: "run-1",
      attemptedEventType: "TOOL_REQUESTED",
      error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "ledger down"),
      usageSummary: null,
      reservation: null,
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE",
      status: 503,
    });
  });

  it("maps an event-emission stream-invalid result to 500 INTERNAL_DATA_INVALID", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "event-emission",
      runId: "run-1",
      attemptedEventType: "REPORT_SUBMITTED",
      error: new PersistenceError("PERSISTENCE_EVENT_STREAM_INVALID", "stream invalid"),
      usageSummary: null,
      reservation: null,
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "INTERNAL_DATA_INVALID",
      status: 500,
    });
  });

  it("maps an event-emission NOT_FOUND to 500 INTERNAL_DATA_INVALID, never a 404", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "event-emission",
      runId: "run-1",
      attemptedEventType: "AGENT_STARTED",
      error: new PersistenceError("PERSISTENCE_NOT_FOUND", "run vanished"),
      usageSummary: null,
      reservation: null,
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "INTERNAL_DATA_INVALID",
      status: 500,
    });
  });

  // Codex Phase B review, finding M3 — exercised through the actual
  // ExecuteAndPersistResult path (not just the mapper in isolation), so a
  // future controller-level regression that stops passing "event-emission" as
  // the mapDomainError context would be caught here.
  it("maps an event-emission conflict to 500 INTERNAL_DATA_INVALID, never the client-facing 409", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "event-emission",
      runId: "run-1",
      attemptedEventType: "TOOL_REQUESTED",
      error: new PersistenceError("PERSISTENCE_CONFLICT", "conflicting canonical event"),
      usageSummary: null,
      reservation: null,
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "INTERNAL_DATA_INVALID",
      status: 500,
    });
  });

  it("maps a run-creation persistence-unavailable result to PERSISTENCE_UNAVAILABLE for a connection failure", async () => {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "unavailable",
      stage: "run-creation",
      error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"),
    });
    const controller = buildController(buildConfig(), { service: buildFakeService({ executeAndPersist }) });

    await expect(controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse())).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE",
      status: 503,
    });
  });

  it("passes a createProvider callback that delegates to the injected provider factory with the requested mode", async () => {
    const executeAndPersist = vi
      .fn()
      .mockImplementation(async (params: { createProvider: (job: AgentJobRecord) => unknown }) => {
        params.createProvider(JOB);
        return { persistence: "persisted", run: PERSISTED_RUN };
      });
    const createProvider = vi.fn();
    const controller = buildController(buildConfig(), {
      service: buildFakeService({ executeAndPersist }),
      providerFactory: { createProvider },
    });

    await controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse());

    // The mode travels with the job: the factory needs both to decide which
    // provider to build.
    expect(createProvider).toHaveBeenCalledWith(JOB, "FAKE");
  });
});

/**
 * Per-run provider selection, added in PR 6B1.
 *
 * The invariant these protect is that an explicitly requested LIVE run is
 * either served or refused — never quietly downgraded to FAKE, which would
 * produce a run that looks successful while proving nothing.
 */
describe("AgentRunsController.createAgentRun — per-run provider selection", () => {
  function controllerWith(config: RunExecutionConfig, executeAndPersist = vi.fn()) {
    executeAndPersist.mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN });
    return {
      executeAndPersist,
      controller: buildController(config, { service: buildFakeService({ executeAndPersist }) }),
    };
  }

  it("uses the server default when the body omits providerMode", async () => {
    const { controller, executeAndPersist } = controllerWith(buildConfig());

    await controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse());

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "FAKE", modelIdentifier: null }),
    );
  });

  it("honours an explicit FAKE request and records no model", async () => {
    const { controller, executeAndPersist } = controllerWith(buildConfig());

    await controller.createAgentRun(
      "job-1",
      { providerMode: "FAKE" },
      buildFakeRequest(),
      buildFakeResponse(),
    );

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "FAKE", modelIdentifier: null }),
    );
  });

  it("honours an explicit LIVE request when capability is present and the switch is on", async () => {
    const { controller, executeAndPersist } = controllerWith(servableConfig());

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      buildFakeResponse(),
    );

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" }),
    );
  });

  it("gives a LIVE run an abort context; a FAKE run gets none", async () => {
    const live = controllerWith(servableConfig());
    await live.controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      buildFakeResponse(),
    );

    const liveParams = live.executeAndPersist.mock.calls[0]?.[0];
    // Both source signals are preserved so finalization can tell a timeout
    // from a disconnect.
    expect(liveParams.abortContext.deadlineSignal).toBeInstanceOf(AbortSignal);
    expect(liveParams.abortContext.disconnectSignal).toBeInstanceOf(AbortSignal);
    expect(liveParams.abortContext.signal).toBeInstanceOf(AbortSignal);
    // The controller passes ONLY abortContext — never a separately-derived
    // `signal` alongside it. AgentRunService is the one place that derives an
    // effective signal (from abortContext.signal), so there is exactly one
    // signal source for the whole request, never two that could diverge.
    expect(liveParams.signal).toBeUndefined();

    const fake = controllerWith(buildConfig());
    await fake.controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse());

    const fakeParams = fake.executeAndPersist.mock.calls[0]?.[0];
    expect(fakeParams.signal).toBeUndefined();
    expect(fakeParams.abortContext).toBeUndefined();
  });

  it("refuses LIVE with 503 LIVE_NOT_CONFIGURED when no capability is configured", async () => {
    const { controller, executeAndPersist } = controllerWith(
      buildConfig({ liveAgentRunsEnabled: true }),
    );

    await expect(
      controller.createAgentRun(
        "job-1",
        { providerMode: "LIVE" },
        buildFakeRequest(),
        buildFakeResponse(),
      ),
    ).rejects.toMatchObject({ code: "LIVE_NOT_CONFIGURED", status: 503 });

    // Refused before any run row could exist.
    expect(executeAndPersist).not.toHaveBeenCalled();
  });

  it("refuses LIVE with 503 LIVE_RUNS_DISABLED when the kill switch is off", async () => {
    const { controller, executeAndPersist } = controllerWith(
      buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT }),
    );

    await expect(
      controller.createAgentRun(
        "job-1",
        { providerMode: "LIVE" },
        buildFakeRequest(),
        buildFakeResponse(),
      ),
    ).rejects.toMatchObject({ code: "LIVE_RUNS_DISABLED", status: 503 });

    expect(executeAndPersist).not.toHaveBeenCalled();
  });

  it("never downgrades a refused LIVE request to FAKE", async () => {
    // The single most important property here. A refusal must be a refusal —
    // silently running the deterministic provider instead would return a
    // plausible 201 that proves nothing about the live path.
    for (const config of [
      buildConfig({ liveAgentRunsEnabled: true }),
      buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT }),
    ]) {
      const { controller, executeAndPersist } = controllerWith(config);

      await expect(
        controller.createAgentRun(
          "job-1",
          { providerMode: "LIVE" },
          buildFakeRequest(),
          buildFakeResponse(),
        ),
      ).rejects.toBeInstanceOf(ApiError);

      expect(executeAndPersist).not.toHaveBeenCalled();
    }
  });

  it("leaves FAKE runs unaffected by capability or the kill switch", async () => {
    const { controller, executeAndPersist } = controllerWith(buildConfig());

    await controller.createAgentRun(
      "job-1",
      { providerMode: "FAKE" },
      buildFakeRequest(),
      buildFakeResponse(),
    );

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "FAKE" }),
    );
  });

  it("follows a LIVE server default when the body omits providerMode", async () => {
    const { controller, executeAndPersist } = controllerWith(
      servableConfig({ defaultRequestMode: "LIVE" }),
    );

    await controller.createAgentRun(
      "job-1",
      {},
      buildFakeRequest({ token: DEMO_TOKEN }),
      buildFakeResponse(),
    );

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE" }),
    );
  });
});

describe("AgentRunsController.getAgentRun", () => {
  it("returns the mapped run wrapped in a data envelope", async () => {
    const getAgentRun = vi.fn().mockResolvedValue(PERSISTED_RUN);
    const controller = buildController(buildConfig(), { service: buildFakeService({ getAgentRun }) });

    const result = await controller.getAgentRun("run-1");

    expect(getAgentRun).toHaveBeenCalledWith("run-1");
    expect(result).toEqual({ data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }) });
  });

  it("maps a not-found PersistenceError to AGENT_RUN_NOT_FOUND", async () => {
    const getAgentRun = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_NOT_FOUND", "no run"));
    const controller = buildController(buildConfig(), { service: buildFakeService({ getAgentRun }) });

    await expect(controller.getAgentRun("run-missing")).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
      status: 404,
    });
  });
});

/**
 * The canonical admission order, exercised end to end through the REAL admission
 * controller. Order is asserted by construction: each test leaves exactly one
 * gate closed and checks that its code — not a later gate's — is what comes back.
 */
describe("AgentRunsController.createAgentRun — LIVE admission", () => {
  function liveController(
    config: RunExecutionConfig,
    overrides: {
      readonly isBudgetOpen?: () => Promise<boolean>;
      readonly logDecision?: LiveRunAdmissionDecisionLogger;
    } = {},
  ) {
    const executeAndPersist = vi
      .fn()
      .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, usageSummary: null, reservation: null });
    const service = buildFakeService({ executeAndPersist });
    const providerFactory = buildFakeProviderFactory();
    return {
      executeAndPersist,
      service,
      providerFactory,
      controller: buildController(config, {
        service,
        providerFactory,
        ...(overrides.isBudgetOpen ? { isBudgetOpen: overrides.isBudgetOpen } : {}),
        ...(overrides.logDecision ? { logDecision: overrides.logDecision } : {}),
      }),
    };
  }

  async function requestLive(
    controller: AgentRunsController,
    request = buildFakeRequest({ token: DEMO_TOKEN }),
  ) {
    return controller.createAgentRun("job-1", { providerMode: "LIVE" }, request, buildFakeResponse());
  }

  describe("step 4 — shared access token", () => {
    it("refuses a LIVE request with no token", async () => {
      const { controller, executeAndPersist } = liveController(servableConfig());

      await expect(requestLive(controller, buildFakeRequest())).rejects.toMatchObject({
        code: "LIVE_RUN_ACCESS_DENIED",
        status: 401,
      });
      expect(executeAndPersist).not.toHaveBeenCalled();
    });

    it("refuses a LIVE request with the wrong token", async () => {
      const { controller, executeAndPersist } = liveController(servableConfig());

      await expect(
        requestLive(controller, buildFakeRequest({ token: "not-the-token" })),
      ).rejects.toMatchObject({ code: "LIVE_RUN_ACCESS_DENIED", status: 401 });
      expect(executeAndPersist).not.toHaveBeenCalled();
    });

    it("admits a LIVE request with the correct token", async () => {
      const { controller, executeAndPersist } = liveController(servableConfig());

      await requestLive(controller);

      expect(executeAndPersist).toHaveBeenCalledWith(
        expect.objectContaining({ providerMode: "LIVE" }),
      );
    });

    it("never echoes the presented token in the rejection", async () => {
      const { controller } = liveController(servableConfig());

      try {
        await requestLive(controller, buildFakeRequest({ token: "sneaky-guess-value" }));
        throw new Error("expected a rejection");
      } catch (error) {
        expect((error as Error).message).not.toContain("sneaky-guess-value");
        expect((error as Error).message).not.toContain(DEMO_TOKEN);
        expect((error as Error).message).toBe(
          "A valid live demo access token is required for a live agent run.",
        );
      }
    });

    it("ignores the token gate entirely for FAKE", async () => {
      // A FAKE request carrying no token — the public deterministic demo — must
      // keep working exactly as before.
      const { controller, executeAndPersist } = liveController(servableConfig());

      await controller.createAgentRun(
        "job-1",
        { providerMode: "FAKE" },
        buildFakeRequest(),
        buildFakeResponse(),
      );

      expect(executeAndPersist).toHaveBeenCalledWith(
        expect.objectContaining({ providerMode: "FAKE" }),
      );
    });

    it("checks capability and the kill switch BEFORE the token", async () => {
      // An operator with no credential should see LIVE_NOT_CONFIGURED, not a
      // misleading 401 about a token that would not help.
      const noCapability = liveController(buildConfig({ liveAgentRunsEnabled: true }));
      await expect(requestLive(noCapability.controller, buildFakeRequest())).rejects.toMatchObject({
        code: "LIVE_NOT_CONFIGURED",
      });

      const switchedOff = liveController(
        buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT, liveAgentRunsEnabled: false }),
      );
      await expect(requestLive(switchedOff.controller, buildFakeRequest())).rejects.toMatchObject({
        code: "LIVE_RUNS_DISABLED",
      });
    });
  });

  describe("step 5 — per-client rate limit", () => {
    it("rejects the third LIVE request in a window with Retry-After", async () => {
      // Default is 2 per 60s per client.
      const { controller } = liveController(servableConfig());

      await requestLive(controller);
      await requestLive(controller);

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "LIVE_RUN_RATE_LIMITED",
        status: 429,
        retryAfterSeconds: expect.any(Number),
      });
    });

    it("keeps separate clients independent", async () => {
      const { controller } = liveController(servableConfig());

      await requestLive(controller, buildFakeRequest({ token: DEMO_TOKEN, ip: "198.51.100.1" }));
      await requestLive(controller, buildFakeRequest({ token: DEMO_TOKEN, ip: "198.51.100.1" }));

      // A different client still has its full allowance.
      await expect(
        requestLive(controller, buildFakeRequest({ token: DEMO_TOKEN, ip: "198.51.100.2" })),
      ).resolves.toBeTruthy();
    });

    it("does not rate-limit FAKE requests", async () => {
      const { controller } = liveController(servableConfig());

      for (let i = 0; i < 5; i += 1) {
        await controller.createAgentRun(
          "job-1",
          { providerMode: "FAKE" },
          buildFakeRequest(),
          buildFakeResponse(),
        );
      }

      // Still admitted: FAKE never touched the limiter.
      await expect(requestLive(controller)).resolves.toBeTruthy();
    });

    it("applies the token gate before the rate limit", async () => {
      // An unauthenticated caller must not be able to burn a client's rate-limit
      // allowance.
      const { controller } = liveController(servableConfig());

      for (let i = 0; i < 5; i += 1) {
        await expect(requestLive(controller, buildFakeRequest())).rejects.toMatchObject({
          code: "LIVE_RUN_ACCESS_DENIED",
        });
      }

      await expect(requestLive(controller)).resolves.toBeTruthy();
    });
  });

  describe("step 6 — advisory budget pre-check", () => {
    it("refuses when the day's budget is already closed", async () => {
      const { controller, executeAndPersist } = liveController(servableConfig(), {
        isBudgetOpen: async () => false,
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "LIVE_RUN_BUDGET_EXHAUSTED",
        status: 429,
      });
      // Refused before any run row could exist.
      expect(executeAndPersist).not.toHaveBeenCalled();
    });

    /**
     * A database outage is one event, so it must have one public contract.
     *
     * The advisory read and the authoritative run-creation transaction touch the
     * same database; an outage hits whichever of them happens to run first. Before
     * this, the pre-check's PersistenceError escaped admission entirely and the
     * catch-all filter turned it into a 500 INTERNAL_ERROR, while the identical
     * outage one step later produced 503 PERSISTENCE_UNAVAILABLE. A caller could
     * therefore be told "we broke" or "try again shortly" for the same cause,
     * depending only on timing.
     */
    describe("when the advisory read itself fails", () => {
      const OUTAGE = () =>
        Promise.reject(new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused"));

      it("maps a PersistenceError to 503 PERSISTENCE_UNAVAILABLE", async () => {
        const { controller } = liveController(servableConfig(), { isBudgetOpen: OUTAGE });

        await expect(requestLive(controller)).rejects.toMatchObject({
          code: "PERSISTENCE_UNAVAILABLE",
          status: 503,
        });
      });

      it("fails closed: no run is created and no provider is built", async () => {
        const { controller, executeAndPersist, service, providerFactory } = liveController(
          servableConfig(),
          { isBudgetOpen: OUTAGE },
        );

        await expect(requestLive(controller)).rejects.toBeInstanceOf(ApiError);

        // Neither repository path was entered, so no AgentRun row could exist...
        expect(executeAndPersist).not.toHaveBeenCalled();
        expect(service.retryFinalization).not.toHaveBeenCalled();
        expect(service.reconcileLiveRunBudget).not.toHaveBeenCalled();
        // ...and nothing that could reach Anthropic was constructed.
        expect(providerFactory.createProvider).not.toHaveBeenCalled();
      });

      it("acquires no concurrency lease, so the failure cannot wedge the slot", async () => {
        // maxConcurrency is 1. If the failed pre-check had taken the lease and
        // then thrown past the release, this second request would come back
        // LIVE_RUN_CONCURRENCY_LIMIT instead of reaching the (still failing)
        // budget read.
        const { controller } = liveController(servableConfig(), { isBudgetOpen: OUTAGE });

        await expect(requestLive(controller)).rejects.toMatchObject({
          code: "PERSISTENCE_UNAVAILABLE",
        });
        await expect(requestLive(controller)).rejects.toMatchObject({
          code: "PERSISTENCE_UNAVAILABLE",
        });
      });

      it("exposes no database message, SQL, or DSN in the public error", async () => {
        const { controller } = liveController(servableConfig(), {
          isBudgetOpen: () =>
            Promise.reject(
              new PersistenceError(
                "PERSISTENCE_UNAVAILABLE",
                'isLiveRunBudgetOpen: postgres://demo_user:hunter2@db.internal/opspilot — SELECT * FROM "live_run_budget"',
              ),
            ),
        });

        const error = await requestLive(controller).then(
          () => {
            throw new Error("expected a rejection");
          },
          (thrown: unknown) => thrown as ApiError,
        );

        expect(error.message).toBe("The database is temporarily unavailable.");
        expect(error.message).not.toContain("postgres://");
        expect(error.message).not.toContain("hunter2");
        expect(error.message).not.toContain("SELECT");
        expect(JSON.stringify(buildErrorEnvelope(error, "req-1"))).not.toContain("postgres://");
      });

      it("gives the same code as the identical outage during run creation", async () => {
        // The consistency this whole block exists for, asserted directly: one
        // database-outage class, one public code, whichever step it lands on.
        const { controller: precheckController } = liveController(servableConfig(), {
          isBudgetOpen: OUTAGE,
        });
        const runCreationController = buildController(servableConfig(), {
          service: buildFakeService({
            executeAndPersist: vi.fn().mockResolvedValue({
              persistence: "unavailable",
              stage: "run-creation",
              error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused"),
            }),
          }),
        });

        const codes = await Promise.all(
          [precheckController, runCreationController].map((controller) =>
            requestLive(controller).then(
              () => "no-rejection",
              (thrown: unknown) => (thrown as ApiError).code,
            ),
          ),
        );

        expect(codes).toEqual(["PERSISTENCE_UNAVAILABLE", "PERSISTENCE_UNAVAILABLE"]);
      });

      it("still lets an unknown failure surface as itself", async () => {
        // Only persistence failures have a defined safe answer. Blanket-mapping
        // everything to 503 would dress a real bug up as "try again later".
        const { controller } = liveController(servableConfig(), {
          isBudgetOpen: () => Promise.reject(new TypeError("isBudgetOpen is not a function")),
        });

        await expect(requestLive(controller)).rejects.toBeInstanceOf(TypeError);
      });
    });
  });

  describe("steps 8 and 12 — transaction rejections and the lease", () => {
    it("maps an attempt-limit rejection from the transaction to 429", async () => {
      const executeAndPersist = vi
        .fn()
        .mockRejectedValue(new LiveRunAdmissionError("LIVE_RUN_ATTEMPT_LIMIT"));
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "LIVE_RUN_ATTEMPT_LIMIT",
        status: 429,
      });
    });

    it("maps a budget rejection from the transaction to 429", async () => {
      const executeAndPersist = vi
        .fn()
        .mockRejectedValue(new LiveRunAdmissionError("LIVE_RUN_BUDGET_EXHAUSTED"));
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "LIVE_RUN_BUDGET_EXHAUSTED",
        status: 429,
      });
    });

    it("releases the concurrency lease after a transaction rejection", async () => {
      // Default concurrency is 1, so a leaked lease would make the very next
      // request fail with LIVE_RUN_CONCURRENCY_LIMIT instead of being admitted.
      const executeAndPersist = vi
        .fn()
        .mockRejectedValueOnce(new LiveRunAdmissionError("LIVE_RUN_ATTEMPT_LIMIT"))
        .mockResolvedValue({
          persistence: "persisted",
          run: PERSISTED_RUN,
          usageSummary: null,
          reservation: null,
        });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await expect(requestLive(controller)).rejects.toBeTruthy();
      await expect(requestLive(controller)).resolves.toBeTruthy();
    });

    it("releases the concurrency lease after a crash", async () => {
      const executeAndPersist = vi
        .fn()
        .mockRejectedValueOnce(new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-1"))
        .mockResolvedValue({
          persistence: "persisted",
          run: PERSISTED_RUN,
          usageSummary: null,
          reservation: null,
        });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "AGENT_EXECUTION_CRASHED",
      });
      await expect(requestLive(controller)).resolves.toBeTruthy();
    });

    it("releases the concurrency lease after a successful run", async () => {
      const { controller } = liveController(servableConfig());

      await requestLive(controller);
      await expect(requestLive(controller)).resolves.toBeTruthy();
    });
  });

  describe("step 11 — reconciliation safety", () => {
    const USAGE = {
      providerCallsObserved: 2,
      inputTokens: 1_200,
      outputTokens: 400,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      estimatedCostNanoUsd: 17_956_000n,
      pricingStatus: "CURRENT" as const,
      possibleUnobservedCost: false,
    };
    const RESERVATION = { budgetDate: "2026-07-29", runsReserved: 1, isPublic: false };

    it("reconciles using the reservation's own budget date", async () => {
      const reconcileLiveRunBudget = vi.fn().mockResolvedValue(undefined);
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: USAGE,
        reservation: RESERVATION,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await requestLive(controller);

      expect(reconcileLiveRunBudget).toHaveBeenCalledWith(RESERVATION, USAGE);
    });

    // Issue #37 Phase B — an event-emission failure leaves the run RUNNING,
    // but the tokens were still spent and the reservation is still
    // outstanding. Skipping reconciliation here would latch the whole UTC day
    // closed (runs_reserved > runs_completed).
    it("reconciles usage and reservation for an event-emission failure, and releases the lease", async () => {
      const reconcileLiveRunBudget = vi.fn().mockResolvedValue(undefined);
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "unavailable",
        stage: "event-emission",
        runId: "run-1",
        attemptedEventType: "TOOL_COMPLETED",
        error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "ledger down"),
        usageSummary: USAGE,
        reservation: RESERVATION,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({ status: 503 });

      expect(reconcileLiveRunBudget).toHaveBeenCalledWith(RESERVATION, USAGE);
      // The lease was released too — otherwise this second request would be
      // refused with LIVE_RUN_CONCURRENCY_LIMIT rather than reaching the
      // service again.
      await expect(requestLive(controller)).rejects.toMatchObject({ status: 503 });
      expect(executeAndPersist).toHaveBeenCalledTimes(2);
    });

    it("preserves the response when reconciliation throws", async () => {
      // The run genuinely happened and the caller needs its id; turning that into
      // a 500 because a bookkeeping UPDATE failed would be strictly worse than a
      // stale budget row.
      const reconcileLiveRunBudget = vi.fn().mockRejectedValue(new Error("db went away"));
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: USAGE,
        reservation: RESERVATION,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      const result = await requestLive(controller);

      expect(result).toEqual({
        data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
      });
    });

    it("still releases the concurrency lease when reconciliation throws", async () => {
      const reconcileLiveRunBudget = vi.fn().mockRejectedValue(new Error("db went away"));
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: USAGE,
        reservation: RESERVATION,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await requestLive(controller);
      // Would be LIVE_RUN_CONCURRENCY_LIMIT if the inner finally had been skipped.
      await expect(requestLive(controller)).resolves.toBeTruthy();
    });

    /**
     * The thrown value here is deliberately a RAW driver-shaped error, not a
     * PersistenceError: the reconciliation call can fail below the layer that
     * normalizes messages, and that is exactly the case where an `error.message`
     * passthrough would put a connection string into the deployment's log
     * aggregator.
     */
    async function reconciliationFailureLine(thrown: unknown): Promise<string> {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const reconcileLiveRunBudget = vi.fn().mockRejectedValue(thrown);
        const executeAndPersist = vi.fn().mockResolvedValue({
          persistence: "persisted",
          run: PERSISTED_RUN,
          usageSummary: USAGE,
          reservation: RESERVATION,
        });
        const controller = buildController(servableConfig(), {
          service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
        });

        await requestLive(controller);

        expect(errorLog).toHaveBeenCalledTimes(1);
        return String(errorLog.mock.calls[0]?.[0]);
      } finally {
        errorLog.mockRestore();
      }
    }

    const DSN_MESSAGE =
      'connection to postgres://demo_user:hunter2@db.internal:5432/opspilot failed while running INSERT INTO "live_run_budget"';

    it("logs a reconciliation failure as fixed classifications only", async () => {
      const line = await reconciliationFailureLine(
        new PersistenceError("PERSISTENCE_UNAVAILABLE", DSN_MESSAGE),
      );

      expect(JSON.parse(line)).toEqual({
        event: "live_run_budget_reconciliation_failed",
        budgetDate: "2026-07-29",
        runId: "run-1",
        errorName: "PersistenceError",
        errorCode: "PERSISTENCE_UNAVAILABLE",
      });
    });

    it("never emits the raw error message, the DSN, its credential, or the SQL", async () => {
      const line = await reconciliationFailureLine(new Error(DSN_MESSAGE));

      // The whole message, and then each dangerous fragment of it independently —
      // so a partial or truncated passthrough fails this too.
      expect(line).not.toContain(DSN_MESSAGE);
      expect(line).not.toContain("postgres://");
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("db.internal");
      expect(line).not.toContain("INSERT INTO");
      expect(line).not.toContain("errorMessage");
      expect(line).not.toContain(DEMO_TOKEN);
      expect(line).not.toContain("sk-ant");
      // No stack frames.
      expect(line).not.toContain("at ");
    });

    /**
     * `error.name` is writable. `Object.assign(err, { name: "..." })` sets it to
     * anything, and an error crossing a package boundary is not something the
     * log module controls — so forwarding it would have been a free-text channel
     * wearing a fixed-field costume. The classification is derived from the
     * CONSTRUCTOR instead, which no assignment can influence.
     */
    it("ignores a hostile custom error.name carrying a DSN, credential, host, and SQL", async () => {
      const hostile = new Error("harmless");
      Object.assign(hostile, {
        name: 'postgres://demo_user:hunter2@db.internal:5432/opspilot SELECT * FROM "live_run_budget"',
      });

      const line = await reconciliationFailureLine(hostile);

      expect(JSON.parse(line)).toEqual({
        event: "live_run_budget_reconciliation_failed",
        budgetDate: "2026-07-29",
        runId: "run-1",
        // The closed classification, not the attacker-supplied name.
        errorName: "Error",
        errorCode: null,
      });
      expect(line).not.toContain("postgres://");
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("db.internal");
      expect(line).not.toContain("SELECT");
      expect(line).not.toContain("live_run_budget\\\"");
    });

    it("classifies a PersistenceError by constructor even when its name is overwritten", async () => {
      const disguised = new PersistenceError("PERSISTENCE_UNAVAILABLE", "down");
      Object.assign(disguised, { name: "sk-ant-not-a-real-key" });

      const line = await reconciliationFailureLine(disguised);

      expect(JSON.parse(line)).toMatchObject({
        errorName: "PersistenceError",
        errorCode: "PERSISTENCE_UNAVAILABLE",
      });
      expect(line).not.toContain("sk-ant");
    });

    it("emits only the three permitted classifications", async () => {
      const cases: readonly [unknown, string][] = [
        [new PersistenceError("PERSISTENCE_CONFLICT", "x"), "PersistenceError"],
        [new TypeError("x"), "Error"],
        [new RangeError("x"), "Error"],
        ["a thrown string", "UnknownError"],
        [{ name: "NotAnError" }, "UnknownError"],
      ];

      for (const [thrown, expected] of cases) {
        const line = await reconciliationFailureLine(thrown);
        expect(JSON.parse(line).errorName).toBe(expected);
      }
    });

    it("keeps the run response and releases the lease when the log SINK itself throws", async () => {
      // Reconciliation failed AND the logger failed. The run genuinely happened;
      // neither failure may turn its 201 into a 500 or strand the lease.
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {
        throw new Error("log transport unavailable");
      });
      try {
        const reconcileLiveRunBudget = vi.fn().mockRejectedValue(new Error("db went away"));
        const executeAndPersist = vi.fn().mockResolvedValue({
          persistence: "persisted",
          run: PERSISTED_RUN,
          usageSummary: USAGE,
          reservation: RESERVATION,
        });
        const controller = buildController(servableConfig(), {
          service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
        });

        const result = await requestLive(controller);

        expect(result).toEqual({
          data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
        });
        // Would be LIVE_RUN_CONCURRENCY_LIMIT if the throwing sink had skipped
        // the inner finally that releases the lease.
        await expect(requestLive(controller)).resolves.toBeTruthy();
      } finally {
        errorLog.mockRestore();
      }
    });

    it("classifies an unknown non-Error throw without inventing text for it", async () => {
      // A thrown string is the case where "just log the message" has no safe
      // meaning at all — there is no message, only caller data.
      const line = await reconciliationFailureLine(DSN_MESSAGE);

      expect(JSON.parse(line)).toEqual({
        event: "live_run_budget_reconciliation_failed",
        budgetDate: "2026-07-29",
        runId: "run-1",
        errorName: "UnknownError",
        errorCode: null,
      });
      expect(line).not.toContain("postgres://");
    });

    it("reconciles a crashed run from its internal execution context", async () => {
      // A crash after a provider call still spent money, so the budget must not
      // silently lose the reservation.
      const reconcileLiveRunBudget = vi.fn().mockResolvedValue(undefined);
      const crash = new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-1", {
        executionContext: { usageSummary: USAGE, reservation: RESERVATION },
      });
      const executeAndPersist = vi.fn().mockRejectedValue(crash);
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "AGENT_EXECUTION_CRASHED",
      });
      expect(reconcileLiveRunBudget).toHaveBeenCalledWith(RESERVATION, USAGE);
    });

    it("reconciles a run whose finalization failed but which did spend tokens", async () => {
      const reconcileLiveRunBudget = vi.fn().mockResolvedValue(undefined);
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "unavailable",
        stage: "finalization",
        runId: "run-1",
        agentResult: { status: "completed", report: {}, trace: [] },
        error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"),
        usageSummary: USAGE,
        reservation: RESERVATION,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(reconcileLiveRunBudget).toHaveBeenCalledWith(RESERVATION, USAGE);
    });

    it("does not reconcile a FAKE run, which has no reservation", async () => {
      const reconcileLiveRunBudget = vi.fn();
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: null,
        reservation: null,
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await controller.createAgentRun(
        "job-1",
        { providerMode: "FAKE" },
        buildFakeRequest(),
        buildFakeResponse(),
      );

      expect(reconcileLiveRunBudget).not.toHaveBeenCalled();
    });

    it("does not reconcile when run creation itself failed", async () => {
      // No provider call happened and no reservation was committed.
      const reconcileLiveRunBudget = vi.fn();
      const executeAndPersist = vi.fn().mockResolvedValue({
        persistence: "unavailable",
        stage: "run-creation",
        error: new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
      });
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist, reconcileLiveRunBudget }),
      });

      await expect(requestLive(controller)).rejects.toMatchObject({ code: "AGENT_JOB_NOT_FOUND" });
      expect(reconcileLiveRunBudget).not.toHaveBeenCalled();
    });
  });

  it("never falls back to FAKE after a LIVE rejection", async () => {
    const { controller, executeAndPersist } = liveController(servableConfig(), {
      isBudgetOpen: async () => false,
    });

    await expect(requestLive(controller)).rejects.toMatchObject({
      code: "LIVE_RUN_BUDGET_EXHAUSTED",
    });

    // The decisive assertion: no run of ANY mode was started.
    expect(executeAndPersist).not.toHaveBeenCalled();
  });

  it("passes the configured stage-aware output-token budget to a LIVE run", async () => {
    const { controller, executeAndPersist } = liveController(servableConfig());

    await requestLive(controller);

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        outputBudget: { investigationMaxOutputTokens: 1024, finalizationMaxOutputTokens: 3072 },
        liveAttemptLimit: 2,
      }),
    );
  });

  it("passes a budget reservation input carrying today's UTC date", async () => {
    const { controller, executeAndPersist } = liveController(servableConfig());

    await requestLive(controller);

    const params = executeAndPersist.mock.calls[0]?.[0];
    expect(params.budgetReservationInput).toEqual({
      budgetDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      dailyLimit: 10,
      costCeilingNanoUsd: 1_000_000_000n,
    });
  });
});

/**
 * STEP 1b — the client request key.
 *
 * A LIVE run's `Idempotency-Key` is what lets a recovery ask for the SAME thing
 * rather than a second paid one. It is validated with the request body, BEFORE
 * admission, and the ordering is deliberate: a malformed key must not be able to
 * consume another client's rate-limit budget or take the single concurrency
 * lease on its way to a 400.
 */
describe("AgentRunsController.createAgentRun — LIVE idempotency key", () => {
  function liveController() {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "persisted",
      run: PERSISTED_RUN,
      usageSummary: null,
      reservation: null,
      execution: "started",
    });
    const service = buildFakeService({ executeAndPersist });
    return {
      executeAndPersist,
      controller: buildController(servableConfig(), { service }),
    };
  }

  function live(
    controller: AgentRunsController,
    request: import("express").Request,
    res = buildFakeResponse(),
  ) {
    return controller.createAgentRun("job-1", { providerMode: "LIVE" }, request, res);
  }

  describe.each([
    ["absent", null],
    ["blank", ""],
    ["whitespace", "   "],
    ["not a UUID", "not-a-uuid"],
    ["a UUID with stray text", "3f6b1d2c-8f4a-4a1e-9f0b-2c7d5e8a1b34-extra"],
    ["oversized", "a".repeat(5_000)],
  ])("a %s key", (_label, idempotencyKey) => {
    it("is refused with 400 and never reaches execution", async () => {
      const { controller, executeAndPersist } = liveController();

      await expect(
        live(controller, buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey })),
      ).rejects.toMatchObject({ code: "LIVE_RUN_IDEMPOTENCY_KEY_INVALID", status: 400 });

      // Nothing was created, nothing was reserved, and no provider could have
      // been built — the rejection happens before the service is touched at all.
      expect(executeAndPersist).not.toHaveBeenCalled();
    });
  });

  it("gives every malformed key the same code and message", async () => {
    const { controller } = liveController();

    const rejections = await Promise.all(
      [null, "", "not-a-uuid"].map((key) =>
        live(controller, buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey: key })).then(
          () => {
            throw new Error("expected a rejection");
          },
          (error: unknown) => error as ApiError,
        ),
      ),
    );

    // Absent, blank, and malformed are indistinguishable from outside. Telling
    // them apart would publish how the value is parsed and tells an honest
    // caller nothing the documented requirement does not.
    const messages = new Set(rejections.map((error) => `${error.code}:${error.message}`));
    expect(messages.size).toBe(1);
    // And the message never echoes what was sent.
    expect(rejections[2]!.message).not.toContain("not-a-uuid");
  });

  it("is rejected BEFORE the access token is checked", async () => {
    const { controller, executeAndPersist } = liveController();

    // No token AND no key. The key wins, because request-shape validation
    // precedes admission — the same ordering the body pipe already has.
    await expect(
      live(controller, buildFakeRequest({ idempotencyKey: null })),
    ).rejects.toMatchObject({ code: "LIVE_RUN_IDEMPOTENCY_KEY_INVALID" });
    expect(executeAndPersist).not.toHaveBeenCalled();
  });

  it("does not consume the rate limit or the concurrency lease", async () => {
    const { controller } = liveController();
    const bad = buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey: null });

    // The configured window allows two LIVE requests; three malformed ones
    // would exhaust it if they were counted. They are not.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(live(controller, bad)).rejects.toMatchObject({
        code: "LIVE_RUN_IDEMPOTENCY_KEY_INVALID",
      });
    }

    // A well-formed request still succeeds, which also proves the single
    // concurrency slot was never taken and never leaked.
    await expect(
      live(controller, buildFakeRequest({ token: DEMO_TOKEN })),
    ).resolves.toBeTruthy();
  });

  it("forwards the accepted key to the service, unchanged", async () => {
    const { controller, executeAndPersist } = liveController();
    const key = "9c1e7f60-4b2a-4d38-9c55-1f0a3e6b7d21";

    await live(controller, buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey: key }));

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE", clientRequestId: key }),
    );
  });

  it("accepts an uppercase UUID without rewriting it", async () => {
    const { controller, executeAndPersist } = liveController();
    const key = "9C1E7F60-4B2A-4D38-9C55-1F0A3E6B7D21";

    await live(controller, buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey: key }));

    // Case folding is the `uuid` column's job, not the controller's: PostgreSQL
    // stores a canonical form, so the two casings are already the same key.
    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: key }),
    );
  });

  describe("FAKE is untouched", () => {
    it("needs no key and is sent none", async () => {
      const executeAndPersist = vi
        .fn()
        .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, execution: "started" });
      const controller = buildController(buildConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      const result = await controller.createAgentRun(
        "job-1",
        { providerMode: "FAKE" },
        buildFakeRequest({ idempotencyKey: null }),
        buildFakeResponse(),
      );

      expect(result).toBeTruthy();
      const params = executeAndPersist.mock.calls[0]?.[0];
      expect(params.providerMode).toBe("FAKE");
      // Not merely absent-by-default: `clientRequestId` is a live-only input and
      // the service REFUSES a FAKE call that carries one.
      expect(params.clientRequestId).toBeUndefined();
    });

    it("ignores a key that a caller sends anyway", async () => {
      const executeAndPersist = vi
        .fn()
        .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, execution: "started" });
      const controller = buildController(buildConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await controller.createAgentRun(
        "job-1",
        { providerMode: "FAKE" },
        buildFakeRequest({ idempotencyKey: "9c1e7f60-4b2a-4d38-9c55-1f0a3e6b7d21" }),
        buildFakeResponse(),
      );

      expect(executeAndPersist.mock.calls[0]?.[0].clientRequestId).toBeUndefined();
    });
  });
});

/**
 * The REPLAY response, and the legacy-context refusal.
 *
 * Both are new answers the run endpoint can give, and both are decided by the
 * authoritative transaction rather than here — the controller's job is to render
 * them honestly.
 */
describe("AgentRunsController.createAgentRun — replay and legacy-context responses", () => {
  function controllerReturning(result: unknown) {
    const executeAndPersist = vi.fn().mockResolvedValue(result);
    return {
      executeAndPersist,
      controller: buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      }),
    };
  }

  it("answers 200, not 201, for a replayed run", async () => {
    const { controller } = controllerReturning({
      persistence: "persisted",
      run: PERSISTED_RUN,
      usageSummary: null,
      reservation: null,
      execution: "replayed",
    });
    const res = buildFakeResponse();

    const result = await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      res,
    );

    // Nothing was created, so Created would be false — and a client counting
    // 201s would count one paid attempt too many.
    expect(res.status).toHaveBeenCalledWith(200);
    // Location still names where the run lives, and the body is identical to a
    // freshly created one so a caller that only wants the run need not care.
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/v1/agent-runs/run-1");
    expect(result).toEqual({
      data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
    });
  });

  it("answers 201 for a run this request actually started", async () => {
    const { controller } = controllerReturning({
      persistence: "persisted",
      run: PERSISTED_RUN,
      usageSummary: null,
      reservation: null,
      execution: "started",
    });
    const res = buildFakeResponse();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("maps LIVE_RUN_CONTEXT_INVALID to a stable 422 with an actionable message", async () => {
    const executeAndPersist = vi
      .fn()
      .mockRejectedValue(new LiveRunAdmissionError("LIVE_RUN_CONTEXT_INVALID"));
    const controller = buildController(servableConfig(), {
      service: buildFakeService({ executeAndPersist }),
    });

    const error = await controller
      .createAgentRun("job-1", { providerMode: "LIVE" }, buildFakeRequest({ token: DEMO_TOKEN }), buildFakeResponse())
      .then(
        () => {
          throw new Error("expected a rejection");
        },
        (thrown: unknown) => thrown as ApiError,
      );

    expect(error.code).toBe("LIVE_RUN_CONTEXT_INVALID");
    // 422, not the 429 the previous two-way ternary would have produced for any
    // code that was not the attempt limit.
    expect(error.status).toBe(422);
    expect(error.message).toContain("15–2000 character summary");
    // No stored summary, no measured length, no schema name, no SQL.
    expect(error.message).not.toMatch(/schema|zod|summary\.length|SELECT|ticket_context/i);
  });

  it("looks the key up BEFORE executing, and never executes on a hit", async () => {
    const executeAndPersist = vi.fn();
    const replayLiveRun = vi.fn().mockResolvedValue({ replay: "found", run: PERSISTED_RUN });
    const controller = buildController(servableConfig(), {
      service: buildFakeService({ executeAndPersist, replayLiveRun }),
    });
    const res = buildFakeResponse();

    const result = await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      res,
    );

    expect(replayLiveRun).toHaveBeenCalledWith({
      jobId: "job-1",
      clientRequestId: DEFAULT_IDEMPOTENCY_KEY,
    });
    // The whole point: the run is returned without the service ever being asked
    // to execute one.
    expect(executeAndPersist).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/v1/agent-runs/run-1");
    expect(result).toEqual({
      data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
    });
  });

  it("still maps the two 429 admission rejections correctly", async () => {
    for (const [code, status] of [
      ["LIVE_RUN_ATTEMPT_LIMIT", 429],
      ["LIVE_RUN_BUDGET_EXHAUSTED", 429],
    ] as const) {
      const executeAndPersist = vi.fn().mockRejectedValue(new LiveRunAdmissionError(code));
      const controller = buildController(servableConfig(), {
        service: buildFakeService({ executeAndPersist }),
      });

      await expect(
        controller.createAgentRun(
          "job-1",
          { providerMode: "LIVE" },
          buildFakeRequest({ token: DEMO_TOKEN }),
          buildFakeResponse(),
        ),
      ).rejects.toMatchObject({ code, status });
    }
  });
});

/**
 * REPLAY BEFORE SPEND ADMISSION — the ordering defect, and its fix.
 *
 * The bug: steps 2–7 ran as one block, so a request could not be RECOGNIZED as a
 * repeat until after every gate governing NEW spending had let it through. That
 * made the documented 200 replay unreachable in exactly the situations it exists
 * for, and the worst of them was self-inflicted:
 *
 *   the original request consumes the day's final reservation (or fails to
 *   reconcile, latching the day) -> its response is lost -> the recovery repeats
 *   the same key -> the advisory budget gate refuses at step 6, before any
 *   lookup -> the run that already exists can never be handed back
 *
 * The same held for an exhausted rate window and a busy concurrency slot.
 *
 * Every test here closes one gate and asserts that a request whose key names an
 * existing run is still answered 200 — while a request with a NEW key against the
 * same closed gate is still refused with exactly the code it always was.
 */
describe("AgentRunsController.createAgentRun — replay bypasses new-run spend admission", () => {
  const EXISTING_RUN: PersistedAgentRun = {
    ...PERSISTED_RUN,
    run: { ...PERSISTED_RUN.run, providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" },
  };

  /**
   * A controller wired so every observable spend gate is watched.
   *
   * `isBudgetOpen` is a spy rather than a constant, because "was the budget even
   * READ?" is a stronger claim than "did the budget answer allow it?" — a replay
   * must not consult the day's headroom at all.
   */
  function build(options: {
    readonly replay?: unknown;
    readonly isBudgetOpen?: () => Promise<boolean>;
    readonly config?: RunExecutionConfig;
  } = {}) {
    const executeAndPersist = vi.fn().mockResolvedValue({
      persistence: "persisted",
      run: PERSISTED_RUN,
      usageSummary: null,
      reservation: null,
      execution: "started",
    });
    const replayLiveRun = vi.fn().mockResolvedValue(options.replay ?? { replay: "absent" });
    const reconcileLiveRunBudget = vi.fn();
    const isBudgetOpen = vi.fn(options.isBudgetOpen ?? (async () => true));
    const service = buildFakeService({ executeAndPersist, replayLiveRun, reconcileLiveRunBudget });
    const providerFactory = buildFakeProviderFactory();
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();

    return {
      executeAndPersist,
      replayLiveRun,
      reconcileLiveRunBudget,
      isBudgetOpen,
      providerFactory,
      logDecision,
      controller: buildController(options.config ?? servableConfig(), {
        service,
        providerFactory,
        isBudgetOpen,
        logDecision,
      }),
    };
  }

  const FOUND = { replay: "found", run: EXISTING_RUN } as const;

  function live(
    controller: AgentRunsController,
    request = buildFakeRequest({ token: DEMO_TOKEN }),
    res = buildFakeResponse(),
  ) {
    return controller.createAgentRun("job-1", { providerMode: "LIVE" }, request, res);
  }

  /** Every "no new spend happened" assertion, in one place. */
  function expectNoNewRunWork(harness: ReturnType<typeof build>) {
    expect(harness.isBudgetOpen).not.toHaveBeenCalled();
    expect(harness.executeAndPersist).not.toHaveBeenCalled();
    expect(harness.providerFactory.createProvider).not.toHaveBeenCalled();
    expect(harness.reconcileLiveRunBudget).not.toHaveBeenCalled();
  }

  it("replays with 200 when the day's budget is exhausted", async () => {
    const harness = build({ replay: FOUND, isBudgetOpen: async () => false });
    const res = buildFakeResponse();

    const result = await live(harness.controller, buildFakeRequest({ token: DEMO_TOKEN }), res);

    // The advisory gate that would have refused a new run was never even read.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(result).toEqual({
      data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
    });
    expectNoNewRunWork(harness);
  });

  it("replays with 200 when the day is latched by an unreconciled reservation", async () => {
    // A latched day is indistinguishable from an exhausted one at this boundary
    // — `isLiveRunBudgetOpen` answers false for both — which is precisely why the
    // recovery must not depend on the difference.
    const harness = build({ replay: FOUND, isBudgetOpen: async () => false });

    await live(harness.controller);

    expectNoNewRunWork(harness);
  });

  it("replays with 200 when the per-client rate window is exhausted", async () => {
    const harness = build({ replay: FOUND });
    const request = buildFakeRequest({ token: DEMO_TOKEN });

    // The window allows 2. Four replays later it is still untouched — a replay
    // consumes nothing, so it cannot exhaust the window and cannot be refused by
    // one that a NEW request already exhausted.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = buildFakeResponse();
      await live(harness.controller, request, res);
      expect(res.status).toHaveBeenCalledWith(200);
    }

    expectNoNewRunWork(harness);
  });

  it("replays with 200 while the single concurrency slot is occupied", async () => {
    // The realistic race: the ORIGINAL request is still in flight, holding the
    // one lease, when the recovery arrives. maxConcurrency is 1, so before the
    // split this recovery was refused 429 — by its own original attempt.
    const harness = build();
    let releaseOriginal!: (result: unknown) => void;
    const originalExecution = new Promise((resolve) => {
      releaseOriginal = resolve;
    });
    harness.executeAndPersist.mockReturnValue(originalExecution);

    // Started, deliberately NOT awaited: the lease is held for the whole call.
    const original = live(harness.controller);
    // Settles every intermediate await (the lookup, the advisory read) so the
    // original is genuinely parked inside executeAndPersist, holding the lease.
    await vi.waitFor(() => expect(harness.executeAndPersist).toHaveBeenCalled());

    harness.replayLiveRun.mockResolvedValue(FOUND);
    const res = buildFakeResponse();
    await live(harness.controller, buildFakeRequest({ token: DEMO_TOKEN }), res);

    expect(res.status).toHaveBeenCalledWith(200);

    releaseOriginal({
      persistence: "persisted",
      run: PERSISTED_RUN,
      usageSummary: null,
      reservation: null,
      execution: "started",
    });
    await original;
  });

  it("acquires no concurrency lease, so repeated replays never wedge the slot", async () => {
    // maxConcurrency is 1. If a replay took the lease without releasing it, the
    // NEW-key request afterwards would come back LIVE_RUN_CONCURRENCY_LIMIT.
    const harness = build({ replay: FOUND });

    for (let attempt = 0; attempt < 3; attempt += 1) await live(harness.controller);

    harness.replayLiveRun.mockResolvedValue({ replay: "absent" });
    await expect(live(harness.controller)).resolves.toBeTruthy();
  });

  describe("a NEW key against the same closed gate is still refused", () => {
    it("keeps 429 LIVE_RUN_BUDGET_EXHAUSTED when the budget is closed", async () => {
      const harness = build({ isBudgetOpen: async () => false });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "LIVE_RUN_BUDGET_EXHAUSTED",
        status: 429,
      });
      expect(harness.executeAndPersist).not.toHaveBeenCalled();
    });

    it("keeps 429 LIVE_RUN_RATE_LIMITED when the window is exhausted", async () => {
      const harness = build();

      await live(harness.controller);
      await live(harness.controller);

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "LIVE_RUN_RATE_LIMITED",
        status: 429,
      });
    });

    it("keeps 503 PERSISTENCE_UNAVAILABLE when the advisory read fails", async () => {
      const harness = build({
        isBudgetOpen: () =>
          Promise.reject(new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused")),
      });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "PERSISTENCE_UNAVAILABLE",
        status: 503,
      });
    });
  });

  describe("a replay still requires authorization", () => {
    it("refuses with 401 before the lookup runs, whatever the key names", async () => {
      const harness = build({ replay: FOUND });

      await expect(live(harness.controller, buildFakeRequest())).rejects.toMatchObject({
        code: "LIVE_RUN_ACCESS_DENIED",
        status: 401,
      });

      // The decisive assertion: an unauthenticated caller cannot even ask whether
      // a key exists, so a 200 can never be used to probe for one.
      expect(harness.replayLiveRun).not.toHaveBeenCalled();
      expectNoNewRunWork(harness);
    });

    it("refuses with 503 LIVE_NOT_CONFIGURED before the lookup runs", async () => {
      const harness = build({ replay: FOUND, config: buildConfig({ liveAgentRunsEnabled: true }) });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "LIVE_NOT_CONFIGURED",
      });
      expect(harness.replayLiveRun).not.toHaveBeenCalled();
    });

    it("refuses with 503 LIVE_RUNS_DISABLED before the lookup runs", async () => {
      const harness = build({
        replay: FOUND,
        config: buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT }),
      });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "LIVE_RUNS_DISABLED",
      });
      expect(harness.replayLiveRun).not.toHaveBeenCalled();
    });

    it("refuses a malformed key with 400 before the lookup runs", async () => {
      const harness = build({ replay: FOUND });

      await expect(
        live(harness.controller, buildFakeRequest({ token: DEMO_TOKEN, idempotencyKey: null })),
      ).rejects.toMatchObject({ code: "LIVE_RUN_IDEMPOTENCY_KEY_INVALID", status: 400 });
      expect(harness.replayLiveRun).not.toHaveBeenCalled();
    });
  });

  describe("when the lookup itself cannot complete", () => {
    it("answers 503 and does NOT fall through to new-run admission", async () => {
      const harness = build({
        replay: {
          replay: "unavailable",
          error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused"),
        },
      });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "PERSISTENCE_UNAVAILABLE",
        status: 503,
      });

      // The unsafe alternative would be to treat "could not read" as "no run
      // exists" and start a second paid execution for a request that may already
      // have run. Nothing downstream was touched.
      expectNoNewRunWork(harness);
    });

    it("answers 404 AGENT_JOB_NOT_FOUND when the job does not exist", async () => {
      const harness = build({
        replay: {
          replay: "unavailable",
          error: new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
        },
      });

      // The same code the authoritative transaction produces for the same cause.
      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "AGENT_JOB_NOT_FOUND",
        status: 404,
      });
      expectNoNewRunWork(harness);
    });

    it("exposes no database message or DSN in the public error", async () => {
      const harness = build({
        replay: {
          replay: "unavailable",
          error: new PersistenceError(
            "PERSISTENCE_UNAVAILABLE",
            'replayLiveRun: postgres://demo_user:hunter2@db.internal/opspilot — SELECT * FROM "agent_runs"',
          ),
        },
      });

      const error = await live(harness.controller).then(
        () => {
          throw new Error("expected a rejection");
        },
        (thrown: unknown) => thrown as ApiError,
      );

      expect(error.message).toBe("The database is temporarily unavailable.");
      expect(JSON.stringify(buildErrorEnvelope(error, "req-1"))).not.toContain("hunter2");
    });
  });

  describe("the admission decision log", () => {
    it("records a replay as `replayed`, exactly once", async () => {
      const harness = build({ replay: FOUND });

      await live(harness.controller);

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "replayed", code: null },
      ]);
    });

    it("records a genuinely admitted run as `admitted`, exactly once", async () => {
      const harness = build();

      await live(harness.controller);

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "admitted", code: null },
      ]);
    });

    it("records a failed lookup as one rejection under its public code", async () => {
      const harness = build({
        replay: {
          replay: "unavailable",
          error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused"),
        },
      });

      await expect(live(harness.controller)).rejects.toBeInstanceOf(ApiError);

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "rejected", code: "PERSISTENCE_UNAVAILABLE" },
      ]);
    });

    /**
     * THE RACE THIS FILE'S BUG REPORT DESCRIBES.
     *
     * The Stage-B lookup (step 4b) finds nothing, so the request proceeds
     * through every new-run spend gate — but a CONCURRENT same-key request
     * commits first, and this request's own authoritative transaction (step 8)
     * discovers that row and answers `execution: "replayed"` instead of
     * creating one. The decision log must reflect what actually happened, not
     * what looked likely when the spend gates passed.
     */
    it("logs `replayed`, not `admitted`, when the authoritative transaction loses the race", async () => {
      const harness = build();
      // replay defaults to "absent" (see `build`), so the request reaches
      // admitNewRun and passes every spend gate — and ONLY THEN does the
      // authoritative transaction reveal the concurrent replay.
      harness.executeAndPersist.mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: null,
        reservation: null,
        execution: "replayed",
      });

      const res = buildFakeResponse();
      await live(harness.controller, buildFakeRequest({ token: DEMO_TOKEN }), res);

      // The response is honest about it too — 200, not 201.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "replayed", code: null },
      ]);
    });

    it("logs `rejected` once when the authoritative transaction refuses before creating or replaying anything", async () => {
      const harness = build();
      harness.executeAndPersist.mockRejectedValue(new LiveRunAdmissionError("LIVE_RUN_ATTEMPT_LIMIT"));

      await expect(live(harness.controller)).rejects.toMatchObject({ code: "LIVE_RUN_ATTEMPT_LIMIT" });

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "rejected", code: "LIVE_RUN_ATTEMPT_LIMIT" },
      ]);
    });

    it("logs `rejected` once for a run-creation persistence failure — nothing was ever created", async () => {
      const harness = build();
      harness.executeAndPersist.mockResolvedValue({
        persistence: "unavailable",
        stage: "run-creation",
        error: new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"),
      });

      await expect(live(harness.controller)).rejects.toMatchObject({ code: "AGENT_JOB_NOT_FOUND" });

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "rejected", code: "AGENT_JOB_NOT_FOUND" },
      ]);
    });

    it("logs `rejected` once for a new-run spend-admission gate closing (budget)", async () => {
      const harness = build({ isBudgetOpen: async () => false });

      await expect(live(harness.controller)).rejects.toMatchObject({
        code: "LIVE_RUN_BUDGET_EXHAUSTED",
      });

      expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "rejected", code: "LIVE_RUN_BUDGET_EXHAUSTED" },
      ]);
    });

    /**
     * A run that genuinely STARTED keeps its `admitted` classification even
     * when something later goes wrong — a crashed provider call or a failed
     * finalization write are facts about EXECUTION, not about admission. Both
     * are reachable only after the authoritative transaction already created
     * the run (the replay exit returns long before any provider is built), so
     * neither is a rejection of admission.
     */
    describe("a genuinely started run keeps `admitted` even when it later fails", () => {
      it("when the provider crashes", async () => {
        const harness = build();
        harness.executeAndPersist.mockRejectedValue(
          new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-1"),
        );

        await expect(live(harness.controller)).rejects.toMatchObject({
          code: "AGENT_EXECUTION_CRASHED",
        });

        expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
          { decision: "admitted", code: null },
        ]);
      });

      it("when finalization fails to persist", async () => {
        const harness = build();
        harness.executeAndPersist.mockResolvedValue({
          persistence: "unavailable",
          stage: "finalization",
          runId: "run-1",
          agentResult: { status: "completed", report: {}, trace: [] },
          error: new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"),
          usageSummary: null,
          reservation: null,
        });

        await expect(live(harness.controller)).rejects.toMatchObject({
          code: "PERSISTENCE_UNAVAILABLE",
        });

        expect(harness.logDecision.mock.calls.map(([params]) => params)).toEqual([
          { decision: "admitted", code: null },
        ]);
      });
    });

    it("a throwing log sink changes neither the response nor the lease release", async () => {
      const harness = build();
      harness.logDecision.mockImplementation(() => {
        throw new Error("log transport unavailable");
      });

      const result = await live(harness.controller);

      expect(result).toEqual({
        data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }),
      });
      // Would be LIVE_RUN_CONCURRENCY_LIMIT if the exploding sink had prevented
      // the lease from being released.
      await expect(live(harness.controller)).resolves.toBeTruthy();
    });

    it("never logs the idempotency key or the access token", async () => {
      const harness = build();
      harness.executeAndPersist.mockResolvedValue({
        persistence: "persisted",
        run: PERSISTED_RUN,
        usageSummary: null,
        reservation: null,
        execution: "replayed",
      });

      await live(harness.controller);

      const serialized = JSON.stringify(harness.logDecision.mock.calls);
      expect(serialized).not.toContain(DEFAULT_IDEMPOTENCY_KEY);
      expect(serialized).not.toContain(DEMO_TOKEN);
    });
  });

  it.each(["RUNNING", "COMPLETED", "FAILED"] as const)(
    "replays a %s run identically, with no side effects",
    async (status) => {
      // Status is deliberately not consulted. A RUNNING replay is the NORMAL
      // shape of the case this exists for — the provider executed and
      // finalization failed — and re-running the agent because a row looks
      // unfinished is the duplicate charge the key prevents.
      const harness = build({
        replay: {
          replay: "found",
          run: { ...EXISTING_RUN, run: { ...EXISTING_RUN.run, status } },
        },
        isBudgetOpen: async () => false,
      });
      const res = buildFakeResponse();

      await live(harness.controller, buildFakeRequest({ token: DEMO_TOKEN }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expectNoNewRunWork(harness);
    },
  );

  it("never downgrades a replay-eligible LIVE request to FAKE", async () => {
    const harness = build({ replay: FOUND, isBudgetOpen: async () => false });

    await live(harness.controller);

    // No run of ANY mode was started — the returned run is the one that already
    // existed, and it is LIVE.
    expect(harness.executeAndPersist).not.toHaveBeenCalled();
  });
});

/**
 * Issue #39 — PUBLIC trial wiring through the real controller: the
 * `publicTrial` block reaches `executeAndPersist`, and the attempt limit is
 * the fixed 1, never LIVE_RUN_MAX_ATTEMPTS_PER_JOB.
 */
describe("AgentRunsController.createAgentRun — PUBLIC trial (issue #39)", () => {
  const TURNSTILE_SECRET = "turnstile-secret-do-not-use-1f14e45fceea";
  const VISITOR_SECRET = "visitor-secret-do-not-use-9f14e45fceea";
  const TURNSTILE_SITE_KEY = "turnstile-site-key-do-not-use";
  const VISITOR_ID = "11111111-1111-4111-8111-111111111111";

  function publicTrialConfig(overrides: Partial<RunExecutionConfig> = {}): RunExecutionConfig {
    return buildConfig({
      ...parseRunExecutionConfig({
        ANTHROPIC_API_KEY: "sk-ant-test-do-not-use-0123456789",
        ANTHROPIC_MODEL: "claude-sonnet-5",
        LIVE_AGENT_RUNS_ENABLED: "true",
        ANTHROPIC_MAX_RETRIES: "0",
        LIVE_PUBLIC_TRIAL_ENABLED: "true",
        TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
        TURNSTILE_SITE_KEY,
        LIVE_PUBLIC_TRIAL_VISITOR_SECRET: VISITOR_SECRET,
      }),
      ...overrides,
    });
  }

  function publicController(configOverrides: Partial<RunExecutionConfig> = {}) {
    const executeAndPersist = vi
      .fn()
      .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, usageSummary: null, reservation: null });
    const service = buildFakeService({ executeAndPersist });
    const controller = buildController(publicTrialConfig(configOverrides), {
      service,
      turnstileVerifier: { verify: async () => true },
      visitorIdentity: { mintVisitorId: () => VISITOR_ID, resolveVisitorId: () => null, setVisitorCookie: () => undefined },
    });
    return { controller, executeAndPersist };
  }

  it("passes publicTrial through to executeAndPersist, with the fixed 5/day and $0.50 policy numbers", async () => {
    const { controller, executeAndPersist } = publicController();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ turnstileToken: "solved-token" }),
      buildFakeResponse(),
    );

    const params = executeAndPersist.mock.calls[0]?.[0];
    expect(params.publicTrial).toEqual({
      visitorId: VISITOR_ID,
      publicDailyLimit: 5,
      publicCostCeilingNanoUsd: 500_000_000n,
    });
  });

  it("uses the fixed attempt limit of 1, never LIVE_RUN_MAX_ATTEMPTS_PER_JOB", async () => {
    const { controller, executeAndPersist } = publicController();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ turnstileToken: "solved-token" }),
      buildFakeResponse(),
    );

    expect(executeAndPersist.mock.calls[0]?.[0].liveAttemptLimit).toBe(1);
  });

  function privateLiveController() {
    const executeAndPersist = vi
      .fn()
      .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, usageSummary: null, reservation: null });
    const service = buildFakeService({ executeAndPersist });
    return { executeAndPersist, controller: buildController(servableConfig(), { service }) };
  }

  it("keeps the private path's configurable attempt limit unaffected", async () => {
    const { controller, executeAndPersist } = privateLiveController();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      buildFakeResponse(),
    );

    expect(executeAndPersist.mock.calls[0]?.[0].liveAttemptLimit).toBe(2);
  });

  it("omits publicTrial entirely on the private token path", async () => {
    const { controller, executeAndPersist } = privateLiveController();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ token: DEMO_TOKEN }),
      buildFakeResponse(),
    );

    expect(executeAndPersist.mock.calls[0]?.[0]).not.toHaveProperty("publicTrial");
  });

  it("refuses with LIVE_RUN_TURNSTILE_FAILED when the challenge fails, before executeAndPersist is ever called", async () => {
    const executeAndPersist = vi.fn();
    const service = buildFakeService({ executeAndPersist });
    const controller = buildController(publicTrialConfig(), {
      service,
      turnstileVerifier: { verify: async () => false },
      visitorIdentity: { mintVisitorId: () => VISITOR_ID, resolveVisitorId: () => null, setVisitorCookie: () => undefined },
    });

    await expect(
      controller.createAgentRun(
        "job-1",
        { providerMode: "LIVE" },
        buildFakeRequest({ turnstileToken: "bad-token" }),
        buildFakeResponse(),
      ),
    ).rejects.toMatchObject({ code: "LIVE_RUN_TURNSTILE_FAILED", status: 401 });
    expect(executeAndPersist).not.toHaveBeenCalled();
  });

  it("calls setVisitorCookie exactly once, unconditionally on a solved challenge", async () => {
    const setVisitorCookie = vi.fn();
    const executeAndPersist = vi
      .fn()
      .mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN, usageSummary: null, reservation: null });
    const controller = buildController(publicTrialConfig(), {
      service: buildFakeService({ executeAndPersist }),
      turnstileVerifier: { verify: async () => true },
      visitorIdentity: { mintVisitorId: () => VISITOR_ID, resolveVisitorId: () => null, setVisitorCookie },
    });
    const res = buildFakeResponse();

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest({ turnstileToken: "solved-token" }),
      res,
    );

    expect(setVisitorCookie).toHaveBeenCalledTimes(1);
    expect(setVisitorCookie).toHaveBeenCalledWith(res, VISITOR_ID);
  });
});
