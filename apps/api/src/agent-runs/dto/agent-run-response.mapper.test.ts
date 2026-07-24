import type { AgentJobRecord, AgentRunRecord, PersistedAgentRun } from "@opspilot/database";
import type { ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import { mapAgentRunResponse } from "./agent-run-response.mapper";

const JOB: AgentJobRecord = {
  id: "job-1",
  ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors" },
  externalTicketId: "TICKET-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const RUN: AgentRunRecord = {
  id: "run-1",
  jobId: "job-1",
  attemptNumber: 1,
  status: "COMPLETED",
  providerMode: "FAKE",
  modelIdentifier: null,
  startedAt: "2026-01-01T00:01:00.000Z",
  finishedAt: "2026-01-01T00:02:00.000Z",
  createdAt: "2026-01-01T00:01:00.000Z",
};

const REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "s",
  rootCause: "r",
  customerImpact: "c",
  recommendedResolution: "rr",
  confidence: 0.5,
  evidence: [{ evidenceId: "run-1-call-1", sourceType: "TOOL_EXECUTION", finding: "f" }],
  suggestedActions: [],
};

describe("mapAgentRunResponse", () => {
  it("returns exactly the public top-level key set", () => {
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: RUN,
      trace: [{ type: "REPORT_GENERATED" }],
      outcome: { type: "COMPLETED", report: REPORT },
    };
    const data = mapAgentRunResponse(persisted);
    expect(Object.keys(data).sort()).toEqual(["job", "outcome", "run", "trace"]);
  });

  it("job sub-object has exactly the public job key set", () => {
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: RUN,
      trace: [],
      outcome: { type: "COMPLETED", report: REPORT },
    };
    const data = mapAgentRunResponse(persisted);
    expect(Object.keys(data.job).sort()).toEqual(["createdAt", "id", "summary", "ticketId"]);
  });

  it("run sub-object has exactly the public run key set and no hidden database fields", () => {
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: RUN,
      trace: [],
      outcome: { type: "COMPLETED", report: REPORT },
    };
    const data = mapAgentRunResponse(persisted);
    expect(Object.keys(data.run).sort()).toEqual(
      ["attemptNumber", "createdAt", "finishedAt", "id", "jobId", "modelIdentifier", "providerMode", "startedAt", "status"].sort(),
    );
  });

  it("handles a COMPLETED outcome, forwarding the full report", () => {
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: RUN,
      trace: [{ type: "REPORT_GENERATED" }],
      outcome: { type: "COMPLETED", report: REPORT },
    };
    const data = mapAgentRunResponse(persisted);
    expect(data.outcome).toEqual({ type: "COMPLETED", report: REPORT });
  });

  it("handles a FAILED outcome, forwarding the failure code and message", () => {
    const failedRun: AgentRunRecord = { ...RUN, status: "FAILED", finishedAt: "2026-01-01T00:02:00.000Z" };
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: failedRun,
      trace: [],
      outcome: { type: "FAILED", code: "TOOL_EXECUTION_FAILED", message: "The diagnostic tool failed during execution." },
    };
    const data = mapAgentRunResponse(persisted);
    expect(data.outcome).toEqual({
      type: "FAILED",
      code: "TOOL_EXECUTION_FAILED",
      message: "The diagnostic tool failed during execution.",
    });
  });

  it("forwards trace events in the order provided, without re-sorting", () => {
    const trace = [
      { type: "TOOL_REQUESTED" as const, toolCallId: "c-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED" as const, toolCallId: "c-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" as const },
    ];
    const persisted: PersistedAgentRun = {
      job: JOB,
      run: RUN,
      trace,
      outcome: { type: "COMPLETED", report: REPORT },
    };
    const data = mapAgentRunResponse(persisted);
    expect(data.trace).toEqual(trace);
  });
});
