import type { AgentRunApprovalView, RecordApprovalDecisionResult } from "@opspilot/database";
import { AgentRunApprovalError, PersistenceError } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunApprovalService } from "./agent-run-approval.service";
import { AgentRunApprovalsController } from "./agent-run-approvals.controller";

function buildFakeService(overrides: Partial<AgentRunApprovalService> = {}): AgentRunApprovalService {
  return {
    recordApprovalDecision: vi.fn(),
    getApprovalDecision: vi.fn(),
    ...overrides,
  } as AgentRunApprovalService;
}

function buildFakeResponse() {
  return { status: vi.fn(), setHeader: vi.fn() } as unknown as import("express").Response;
}

const VIEW: AgentRunApprovalView = {
  runId: "run-1",
  status: "APPROVED",
  reviewerName: "jacky",
  note: null,
  decidedAt: new Date("2026-07-23T10:15:00.000Z"),
};

describe("AgentRunApprovalsController.recordApprovalDecision", () => {
  it("returns 201 with a Location header on first recording", async () => {
    const recordApprovalDecision = vi
      .fn()
      .mockResolvedValue({ view: VIEW, outcome: "created" } satisfies RecordApprovalDecisionResult);
    const controller = new AgentRunApprovalsController(buildFakeService({ recordApprovalDecision }));
    const res = buildFakeResponse();

    const result = await controller.recordApprovalDecision(
      "run-1",
      { decision: "APPROVED", reviewerName: "jacky" },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/v1/agent-runs/run-1/approval");
    expect(result).toEqual({ data: expect.objectContaining({ runId: "run-1", status: "APPROVED" }) });
  });

  it("returns 200 with no Location header on an idempotent replay", async () => {
    const recordApprovalDecision = vi
      .fn()
      .mockResolvedValue({ view: VIEW, outcome: "replayed" } satisfies RecordApprovalDecisionResult);
    const controller = new AgentRunApprovalsController(buildFakeService({ recordApprovalDecision }));
    const res = buildFakeResponse();

    await controller.recordApprovalDecision("run-1", { decision: "APPROVED", reviewerName: "jacky" }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("maps AgentRunApprovalError(RUN_NOT_APPROVAL_ELIGIBLE) to a 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE ApiError", async () => {
    const recordApprovalDecision = vi
      .fn()
      .mockRejectedValue(new AgentRunApprovalError("RUN_NOT_APPROVAL_ELIGIBLE", "run-1"));
    const controller = new AgentRunApprovalsController(buildFakeService({ recordApprovalDecision }));

    await expect(
      controller.recordApprovalDecision("run-1", { decision: "APPROVED", reviewerName: "jacky" }, buildFakeResponse()),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_APPROVAL_ELIGIBLE", status: 409 });
  });

  it("maps AgentRunApprovalError(APPROVAL_ALREADY_DECIDED) to a 409 AGENT_RUN_APPROVAL_ALREADY_DECIDED ApiError, with runId attached", async () => {
    const recordApprovalDecision = vi
      .fn()
      .mockRejectedValue(new AgentRunApprovalError("APPROVAL_ALREADY_DECIDED", "run-1"));
    const controller = new AgentRunApprovalsController(buildFakeService({ recordApprovalDecision }));

    await expect(
      controller.recordApprovalDecision("run-1", { decision: "APPROVED", reviewerName: "jacky" }, buildFakeResponse()),
    ).rejects.toMatchObject({ code: "AGENT_RUN_APPROVAL_ALREADY_DECIDED", status: 409, runId: "run-1" });
  });

  it("maps PersistenceError(PERSISTENCE_NOT_FOUND) to a 404 AGENT_RUN_NOT_FOUND ApiError", async () => {
    const recordApprovalDecision = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_NOT_FOUND", "no run"));
    const controller = new AgentRunApprovalsController(buildFakeService({ recordApprovalDecision }));

    await expect(
      controller.recordApprovalDecision("run-1", { decision: "APPROVED", reviewerName: "jacky" }, buildFakeResponse()),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND", status: 404 });
  });
});

describe("AgentRunApprovalsController.getApprovalDecision", () => {
  it("returns the service's view unchanged, mapped through mapAgentRunApprovalResponse", async () => {
    const getApprovalDecision = vi.fn().mockResolvedValue(VIEW);
    const controller = new AgentRunApprovalsController(buildFakeService({ getApprovalDecision }));

    const result = await controller.getApprovalDecision("run-1");

    expect(getApprovalDecision).toHaveBeenCalledWith("run-1");
    expect(result).toEqual({
      data: expect.objectContaining({ runId: "run-1", status: "APPROVED", decidedAt: "2026-07-23T10:15:00.000Z" }),
    });
  });

  it("maps PersistenceError(PERSISTENCE_NOT_FOUND) to a 404 AGENT_RUN_NOT_FOUND ApiError", async () => {
    const getApprovalDecision = vi.fn().mockRejectedValue(new PersistenceError("PERSISTENCE_NOT_FOUND", "no run"));
    const controller = new AgentRunApprovalsController(buildFakeService({ getApprovalDecision }));

    await expect(controller.getApprovalDecision("run-1")).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
      status: 404,
    });
  });
});
