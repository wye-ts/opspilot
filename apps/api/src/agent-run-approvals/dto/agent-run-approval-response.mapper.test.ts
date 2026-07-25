import type { AgentRunApprovalView } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { mapAgentRunApprovalResponse } from "./agent-run-approval-response.mapper";

const DECIDED_VIEW: AgentRunApprovalView = {
  runId: "8f14e45f-0000-0000-0000-000000000000",
  status: "APPROVED",
  reviewerName: "jacky",
  note: "note",
  decidedAt: new Date("2026-07-23T10:15:00.000Z"),
};

const PENDING_VIEW: AgentRunApprovalView = {
  runId: "8f14e45f-0000-0000-0000-000000000000",
  status: "PENDING",
  reviewerName: null,
  note: null,
  decidedAt: null,
};

describe("mapAgentRunApprovalResponse", () => {
  it("returns exactly the 5 documented keys, no more, no less", () => {
    const data = mapAgentRunApprovalResponse(DECIDED_VIEW);
    expect(Object.keys(data).sort()).toEqual(["decidedAt", "note", "reviewerName", "runId", "status"]);
  });

  it("maps a Date decidedAt to its ISO string", () => {
    const data = mapAgentRunApprovalResponse(DECIDED_VIEW);
    expect(data.decidedAt).toBe("2026-07-23T10:15:00.000Z");
  });

  it("maps a null decidedAt to null", () => {
    const data = mapAgentRunApprovalResponse(PENDING_VIEW);
    expect(data.decidedAt).toBeNull();
  });
});
