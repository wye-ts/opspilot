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
  // them, and a FAKE run never touches them.
  return {
    status: vi.fn(),
    setHeader: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writableFinished: false,
  } as unknown as import("express").Response;
}

function buildFakeRequest(
  options: { readonly token?: string; readonly ip?: string } = {},
): import("express").Request {
  return {
    ip: options.ip ?? "203.0.113.7",
    header: (name: string) =>
      name.toLowerCase() === "x-opspilot-demo-token" ? options.token : undefined,
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
    const RESERVATION = { budgetDate: "2026-07-29", runsReserved: 1 };

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

  it("passes the configured output-token ceiling to a LIVE run", async () => {
    const { controller, executeAndPersist } = liveController(servableConfig());

    await requestLive(controller);

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 1024, liveAttemptLimit: 2 }),
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
