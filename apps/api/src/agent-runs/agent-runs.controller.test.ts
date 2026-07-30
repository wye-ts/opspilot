import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import type { AgentJobRecord, PersistedAgentRun } from "@opspilot/database";
import { PersistenceError } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import type { AgentProviderFactory } from "../execution/api-provider-factory";
import type { RunExecutionConfig } from "../execution/run-execution-config";
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

function buildFakeRequest() {
  return {} as unknown as import("express").Request;
}

/**
 * Defaults to the safest posture a deployment can be in: deterministic by
 * default, no live capability, kill switch off. Every LIVE test opts in
 * explicitly, so nothing accidentally exercises the live path.
 */
function buildConfig(overrides: Partial<RunExecutionConfig> = {}): RunExecutionConfig {
  return {
    defaultRequestMode: "FAKE",
    liveCapability: { kind: "absent" },
    liveAgentRunsEnabled: false,
    providerDeadlineMs: 120_000,
    ...overrides,
  };
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
    const controller = new AgentRunsController(
      service, buildFakeToolRegistry(), buildFakeProviderFactory(),
      buildConfig(),
    );
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
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

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
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

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
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

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
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

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
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      { createProvider },
      buildConfig(),
    );

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
      controller: new AgentRunsController(
        buildFakeService({ executeAndPersist }),
        buildFakeToolRegistry(),
        buildFakeProviderFactory(),
        config,
      ),
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
    const { controller, executeAndPersist } = controllerWith(
      buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT, liveAgentRunsEnabled: true }),
    );

    await controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest(),
      buildFakeResponse(),
    );

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" }),
    );
  });

  it("gives a LIVE run an abort context; a FAKE run gets none", async () => {
    const live = controllerWith(
      buildConfig({ liveCapability: LIVE_CAPABILITY_PRESENT, liveAgentRunsEnabled: true }),
    );
    await live.controller.createAgentRun(
      "job-1",
      { providerMode: "LIVE" },
      buildFakeRequest(),
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
      buildConfig({
        defaultRequestMode: "LIVE",
        liveCapability: LIVE_CAPABILITY_PRESENT,
        liveAgentRunsEnabled: true,
      }),
    );

    await controller.createAgentRun("job-1", {}, buildFakeRequest(), buildFakeResponse());

    expect(executeAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE" }),
    );
  });
});

describe("AgentRunsController.getAgentRun", () => {
  it("returns the mapped run wrapped in a data envelope", async () => {
    const getAgentRun = vi.fn().mockResolvedValue(PERSISTED_RUN);
    const controller = new AgentRunsController(
      buildFakeService({ getAgentRun }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

    const result = await controller.getAgentRun("run-1");

    expect(getAgentRun).toHaveBeenCalledWith("run-1");
    expect(result).toEqual({ data: expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }) });
  });

  it("maps a not-found PersistenceError to AGENT_RUN_NOT_FOUND", async () => {
    const getAgentRun = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_NOT_FOUND", "no run"));
    const controller = new AgentRunsController(
      buildFakeService({ getAgentRun }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
      buildConfig(),
    );

    await expect(controller.getAgentRun("run-missing")).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
      status: 404,
    });
  });
});
