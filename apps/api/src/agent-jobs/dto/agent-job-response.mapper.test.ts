import type { AgentJobRecord, PersistedAgentJob } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { mapAgentJobDetailResponse, mapAgentJobResponse } from "./agent-job-response.mapper";

const JOB: AgentJobRecord = {
  id: "job-1",
  ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors" },
  externalTicketId: "TICKET-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("mapAgentJobResponse", () => {
  it("returns exactly the public key set", () => {
    const data = mapAgentJobResponse(JOB);
    expect(Object.keys(data).sort()).toEqual(["createdAt", "id", "summary", "ticketId"]);
    expect(data).toEqual({
      id: "job-1",
      ticketId: "TICKET-1",
      summary: "Elevated errors",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("never leaks externalTicketId or other internal database fields", () => {
    const data = mapAgentJobResponse(JOB);
    expect(data).not.toHaveProperty("externalTicketId");
    expect(data).not.toHaveProperty("ticketContext");
  });
});

describe("mapAgentJobDetailResponse", () => {
  const persisted: PersistedAgentJob = {
    job: JOB,
    runs: [
      {
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
    ],
  };

  it("returns exactly the public key set, including a runs array with exact per-run keys", () => {
    const data = mapAgentJobDetailResponse(persisted);
    expect(Object.keys(data).sort()).toEqual(["createdAt", "id", "runs", "summary", "ticketId"]);
    expect(data.runs).toHaveLength(1);
    expect(Object.keys(data.runs[0] as object).sort()).toEqual(
      ["attemptNumber", "createdAt", "finishedAt", "id", "modelIdentifier", "providerMode", "startedAt", "status"].sort(),
    );
  });

  it("never includes trace, report, or failure payload fields on run summaries", () => {
    const data = mapAgentJobDetailResponse(persisted);
    const run = data.runs[0] as object;
    expect(run).not.toHaveProperty("trace");
    expect(run).not.toHaveProperty("report");
    expect(run).not.toHaveProperty("failureCode");
  });

  it("preserves modelIdentifier: null and finishedAt: null for a non-terminal run", () => {
    const runningPersisted: PersistedAgentJob = {
      job: JOB,
      runs: [
        {
          id: "run-2",
          jobId: "job-1",
          attemptNumber: 2,
          status: "RUNNING",
          providerMode: "FAKE",
          modelIdentifier: null,
          startedAt: "2026-01-01T00:03:00.000Z",
          finishedAt: null,
          createdAt: "2026-01-01T00:03:00.000Z",
        },
      ],
    };
    const data = mapAgentJobDetailResponse(runningPersisted);
    expect(data.runs[0]?.modelIdentifier).toBeNull();
    expect(data.runs[0]?.finishedAt).toBeNull();
  });

  it("preserves run ordering as provided (attemptNumber ASC is the repository's responsibility, not re-sorted here)", () => {
    const multiRun: PersistedAgentJob = {
      job: JOB,
      runs: [
        { ...persisted.runs[0]!, id: "run-a", attemptNumber: 1 },
        { ...persisted.runs[0]!, id: "run-b", attemptNumber: 2 },
      ],
    };
    const data = mapAgentJobDetailResponse(multiRun);
    expect(data.runs.map((r) => r.id)).toEqual(["run-a", "run-b"]);
  });
});
