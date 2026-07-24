import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import type { AgentJobRecord, PersistedAgentRun } from "@opspilot/database";
import { PersistenceError } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import type { DeterministicProviderFactory } from "../execution/deterministic-provider-factory";
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

function buildFakeProviderFactory(): DeterministicProviderFactory {
  return { createProvider: vi.fn() };
}

function buildFakeResponse() {
  return { status: vi.fn(), setHeader: vi.fn() } as unknown as import("express").Response;
}

describe("AgentRunsController.createAgentRun", () => {
  it("persists a run, sets 201 + Location, and never pre-reads the job via getAgentJob", async () => {
    const getAgentJob = vi.fn();
    const executeAndPersist = vi.fn().mockResolvedValue({ persistence: "persisted", run: PERSISTED_RUN });
    const service = buildFakeService({ executeAndPersist, getAgentJob });
    const controller = new AgentRunsController(service, buildFakeToolRegistry(), buildFakeProviderFactory());
    const res = buildFakeResponse();

    const result = await controller.createAgentRun("job-1", {}, res);

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
    );

    await expect(controller.createAgentRun("job-1", {}, buildFakeResponse())).rejects.toMatchObject({
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
    );

    await expect(controller.createAgentRun("job-1", {}, buildFakeResponse())).rejects.toMatchObject({
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
    );

    await expect(controller.createAgentRun("job-1", {}, buildFakeResponse())).rejects.toMatchObject({
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
    );

    await expect(controller.createAgentRun("job-1", {}, buildFakeResponse())).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE",
      status: 503,
    });
  });

  it("passes a createProvider callback that delegates to the injected deterministic provider factory", async () => {
    const executeAndPersist = vi.fn().mockImplementation(async (params: { createProvider: (job: AgentJobRecord) => unknown }) => {
      params.createProvider(JOB);
      return { persistence: "persisted", run: PERSISTED_RUN };
    });
    const createProvider = vi.fn();
    const controller = new AgentRunsController(
      buildFakeService({ executeAndPersist }),
      buildFakeToolRegistry(),
      { createProvider },
    );

    await controller.createAgentRun("job-1", {}, buildFakeResponse());

    expect(createProvider).toHaveBeenCalledWith(JOB);
  });
});

describe("AgentRunsController.getAgentRun", () => {
  it("returns the mapped run wrapped in a data envelope", async () => {
    const getAgentRun = vi.fn().mockResolvedValue(PERSISTED_RUN);
    const controller = new AgentRunsController(
      buildFakeService({ getAgentRun }),
      buildFakeToolRegistry(),
      buildFakeProviderFactory(),
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
    );

    await expect(controller.getAgentRun("run-missing")).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
      status: 404,
    });
  });
});
