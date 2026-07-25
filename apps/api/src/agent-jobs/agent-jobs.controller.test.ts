import type { AgentRunService } from "@opspilot/agent-runtime";
import type { AgentJobRecord, PersistedAgentJob } from "@opspilot/database";
import { PersistenceError } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import { AgentJobsController } from "./agent-jobs.controller";

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

const JOB: AgentJobRecord = {
  id: "job-1",
  ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors" },
  externalTicketId: "TICKET-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AgentJobsController.createAgentJob", () => {
  it("returns the mapped job wrapped in a data envelope", async () => {
    const createAgentJob = vi.fn().mockResolvedValue(JOB);
    const controller = new AgentJobsController(buildFakeService({ createAgentJob }));

    const result = await controller.createAgentJob({ ticketId: "TICKET-1", summary: "Elevated errors" });

    expect(createAgentJob).toHaveBeenCalledWith({ ticketId: "TICKET-1", summary: "Elevated errors" });
    expect(result).toEqual({
      data: { id: "job-1", ticketId: "TICKET-1", summary: "Elevated errors", createdAt: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("maps a PersistenceError to an ApiError instead of leaking the raw error", async () => {
    const createAgentJob = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"));
    const controller = new AgentJobsController(buildFakeService({ createAgentJob }));

    await expect(controller.createAgentJob({ ticketId: "T", summary: "s" })).rejects.toBeInstanceOf(ApiError);
    await expect(controller.createAgentJob({ ticketId: "T", summary: "s" })).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE",
      status: 503,
    });
  });
});

describe("AgentJobsController.getAgentJob", () => {
  const persisted: PersistedAgentJob = { job: JOB, runs: [] };

  it("returns the mapped job detail wrapped in a data envelope", async () => {
    const getAgentJob = vi.fn().mockResolvedValue(persisted);
    const controller = new AgentJobsController(buildFakeService({ getAgentJob }));

    const result = await controller.getAgentJob("job-1");

    expect(getAgentJob).toHaveBeenCalledWith("job-1");
    expect(result).toEqual({
      data: {
        id: "job-1",
        ticketId: "TICKET-1",
        summary: "Elevated errors",
        createdAt: "2026-01-01T00:00:00.000Z",
        runs: [],
      },
    });
  });

  it("maps a not-found PersistenceError to AGENT_JOB_NOT_FOUND", async () => {
    const getAgentJob = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_NOT_FOUND", "no job"));
    const controller = new AgentJobsController(buildFakeService({ getAgentJob }));

    await expect(controller.getAgentJob("job-missing")).rejects.toMatchObject({
      code: "AGENT_JOB_NOT_FOUND",
      status: 404,
    });
  });

  it("maps an unknown thrown value to a fixed INTERNAL_ERROR", async () => {
    const getAgentJob = vi.fn().mockRejectedValue("raw throw");
    const controller = new AgentJobsController(buildFakeService({ getAgentJob }));

    await expect(controller.getAgentJob("job-1")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });
});
