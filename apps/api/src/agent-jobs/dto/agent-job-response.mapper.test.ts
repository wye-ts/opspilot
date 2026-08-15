import type {
  AgentJobRecord,
  AgentRunRecord,
  PersistedAgentJob,
  PersistedInvestigationState,
} from "@opspilot/database";
import type { InvestigationEventRecord, StoredResolutionReport } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import {
  mapAgentJobDetailResponse,
  mapAgentJobResponse,
  mapInvestigationStateResponse,
} from "./agent-job-response.mapper";

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
        // FAKE runs never carry a measured cost — see AgentRunRecord.
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: false,
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
          // FAKE runs never carry a measured cost — see AgentRunRecord.
          estimatedCostNanoUsd: null,
          possibleUnobservedCost: false,
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

// Issue #58 Checkpoint C (§9.2 production read integration): stopReason is
// derived, never stored — reconstructed purely from the COMPLETED report's
// evidenceState and the REPORT_GENERATION_STARTED ledger fact already
// carried on PersistedInvestigationState. These are unit-level proofs of the
// mapper's derivation wiring; apps/api/test/agent-jobs-investigation.postgres.
// integration.test.ts proves the same matrix through the real HTTP endpoint
// against a Postgres-persisted run.
describe("mapInvestigationStateResponse — stopReason (issue #58 Checkpoint C §9.2)", () => {
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
    estimatedCostNanoUsd: null,
    possibleUnobservedCost: false,
  };

  function eventRecord(sequence: number, type: string): InvestigationEventRecord {
    return {
      runId: RUN.id,
      sequence,
      recordedAt: "2026-01-01T00:01:30.000Z",
      // Only `.payload.type` is read by the mapper; the rest of the
      // discriminated-union shape is irrelevant to stopReason derivation.
      payload: { type } as unknown as InvestigationEventRecord["payload"],
    };
  }

  function report(overrides: Partial<StoredResolutionReport>): StoredResolutionReport {
    return {
      category: "SERVICE_DEGRADATION",
      summary: "Evidence gathered for the ticket.",
      rootCause: null,
      customerImpact: "Impact assessed from the gathered evidence.",
      recommendedResolution: "Follow up per the ticket.",
      confidence: 0.5,
      evidence: [],
      suggestedActions: [],
      ...overrides,
    } as StoredResolutionReport;
  }

  function state(args: {
    outcome: PersistedInvestigationState["outcome"];
    events: readonly InvestigationEventRecord[];
  }): PersistedInvestigationState {
    return {
      job: JOB,
      run: RUN,
      trace: [],
      outcome: args.outcome,
      events: args.events,
    };
  }

  it("A — voluntary SUFFICIENT report with no REPORT_GENERATION_STARTED -> SUFFICIENT_EVIDENCE", () => {
    const data = mapInvestigationStateResponse(
      state({
        outcome: {
          type: "COMPLETED",
          report: report({ evidenceState: "SUFFICIENT", rootCause: "notification-service is degraded." }),
        },
        events: [eventRecord(1, "AGENT_STARTED")],
      }),
    );
    expect(data.stopReason).toBe("SUFFICIENT_EVIDENCE");
  });

  it("C/D — voluntary INSUFFICIENT or CONFLICTING report with no REPORT_GENERATION_STARTED -> NO_JUSTIFIED_DIAGNOSTIC", () => {
    for (const evidenceState of ["INSUFFICIENT", "CONFLICTING"] as const) {
      const data = mapInvestigationStateResponse(
        state({
          outcome: { type: "COMPLETED", report: report({ evidenceState, rootCause: null }) },
          events: [eventRecord(1, "AGENT_STARTED")],
        }),
      );
      expect(data.stopReason).toBe("NO_JUSTIFIED_DIAGNOSTIC");
    }
  });

  it("F — REPORT_GENERATION_STARTED present -> BOUND_EXHAUSTED, regardless of the final report's evidenceState", () => {
    for (const evidenceState of ["SUFFICIENT", "INSUFFICIENT", "CONFLICTING"] as const) {
      const data = mapInvestigationStateResponse(
        state({
          outcome: {
            type: "COMPLETED",
            report: report({
              evidenceState,
              rootCause: evidenceState === "SUFFICIENT" ? "some cause" : null,
            }),
          },
          events: [eventRecord(1, "AGENT_STARTED"), eventRecord(2, "REPORT_GENERATION_STARTED")],
        }),
      );
      expect(data.stopReason).toBe("BOUND_EXHAUSTED");
    }
  });

  it("G — SUFFICIENT report with rootCause null (grounded non-causal verdict) -> SUFFICIENT_EVIDENCE", () => {
    const data = mapInvestigationStateResponse(
      state({
        outcome: {
          type: "COMPLETED",
          report: report({
            evidenceState: "SUFFICIENT",
            rootCause: null,
            evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "auth-service reported OPERATIONAL." }],
          }),
        },
        events: [eventRecord(1, "AGENT_STARTED")],
      }),
    );
    expect(data.stopReason).toBe("SUFFICIENT_EVIDENCE");
  });

  it("legacy — a pre-#58 COMPLETED report with no evidenceState and no REPORT_GENERATION_STARTED -> null", () => {
    // `report()`'s base shape never sets `evidenceState` unless an override
    // supplies it — the key is genuinely absent here, matching how
    // fromReportRead reads an actual pre-#58 stored row
    // (StoredResolutionReportSchema, evidenceState optional).
    const legacyReport = report({
      rootCause: "notification-service is degraded.",
      evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "degraded." }],
    });
    expect(legacyReport).not.toHaveProperty("evidenceState");

    const data = mapInvestigationStateResponse(
      state({
        outcome: { type: "COMPLETED", report: legacyReport },
        events: [eventRecord(1, "AGENT_STARTED")],
      }),
    );
    expect(data.stopReason).toBeNull();
  });

  it("no outcome yet (run just started, no report, no forced finalization) -> null", () => {
    const data = mapInvestigationStateResponse(
      state({ outcome: null, events: [eventRecord(1, "AGENT_STARTED")] }),
    );
    expect(data.stopReason).toBeNull();
  });

  it("a FAILED run with no REPORT_GENERATION_STARTED -> null (no report evidenceState to derive from)", () => {
    const data = mapInvestigationStateResponse(
      state({
        outcome: { type: "FAILED", code: "TOOL_EXECUTION_FAILED", message: "boom" },
        events: [eventRecord(1, "AGENT_STARTED")],
      }),
    );
    expect(data.stopReason).toBeNull();
  });
});
