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
  // FAKE runs never carry a measured cost — see AgentRunRecord.
  estimatedCostNanoUsd: null,
  // A FAKE run records no usage, so the fail-closed reading applies.
  possibleUnobservedCost: true,
};

// A LIVE run whose cost is COMPLETE: every provider call was observed and
// priced. This is the only shape that may publish a figure.
const KNOWN_COST_RUN: AgentRunRecord = {
  ...RUN,
  providerMode: "LIVE",
  modelIdentifier: "claude-sonnet-5",
  estimatedCostNanoUsd: 17_956_000n,
  possibleUnobservedCost: false,
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
  evidenceState: "SUFFICIENT",
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
      [
        "attemptNumber",
        "createdAt",
        "estimatedCostUsd",
        "finishedAt",
        "id",
        "jobId",
        "modelIdentifier",
        "providerMode",
        "startedAt",
        "status",
      ].sort(),
    );
    // The raw nanoUSD bigint is deliberately NOT among them: the DTO formats it
    // to a decimal string at this boundary, and the internal column name never
    // reaches a consumer.
    expect(Object.keys(data.run)).not.toContain("estimatedCostNanoUsd");
  });

  describe("estimatedCostUsd", () => {
    it("formats a persisted nanoUSD cost as a decimal string", () => {
      const data = mapAgentRunResponse({
        job: JOB,
        run: KNOWN_COST_RUN,
        trace: [],
        outcome: { type: "COMPLETED", report: REPORT },
      });

      expect(data.run.estimatedCostUsd).toBe("0.017956");
      expect(typeof data.run.estimatedCostUsd).toBe("string");
    });

    it("is null for a FAKE run, which was never measured", () => {
      const data = mapAgentRunResponse({
        job: JOB,
        run: RUN,
        trace: [],
        outcome: { type: "COMPLETED", report: REPORT },
      });

      // Null, never "0.000000" — a deterministic run made no provider call, and
      // claiming a measured zero would be a different assertion entirely.
      expect(data.run.estimatedCostUsd).toBeNull();
    });

    it("is null for a LIVE run whose pricing could not be established", () => {
      const data = mapAgentRunResponse({
        job: JOB,
        run: { ...KNOWN_COST_RUN, estimatedCostNanoUsd: null },
        trace: [],
        outcome: { type: "COMPLETED", report: REPORT },
      });

      expect(data.run.estimatedCostUsd).toBeNull();
    });

    it("survives JSON serialization, which a raw bigint would not", () => {
      const data = mapAgentRunResponse({
        job: JOB,
        run: KNOWN_COST_RUN,
        trace: [],
        outcome: { type: "COMPLETED", report: REPORT },
      });

      const roundTripped = JSON.parse(JSON.stringify(data));
      expect(roundTripped.run.estimatedCostUsd).toBe("0.017956");
      // Money is never a JSON number.
      expect(typeof roundTripped.run.estimatedCostUsd).not.toBe("number");
    });

    it("keeps an exact value that a float could not represent", () => {
      const data = mapAgentRunResponse({
        job: JOB,
        run: { ...KNOWN_COST_RUN, estimatedCostNanoUsd: 100_000_000n },
        trace: [],
        outcome: { type: "COMPLETED", report: REPORT },
      });

      // 0.1 USD exactly — the value a float round-trip would turn into
      // 0.10000000000000001.
      expect(data.run.estimatedCostUsd).toBe("0.100000");
    });

    /**
     * The ambiguity contract.
     *
     * `possibleUnobservedCost` means the stored figure is a LOWER BOUND, not a
     * total. Publishing it would state a precise number that is known to be too
     * low; publishing zero would go further and assert the run was free. The
     * honest public answer to "what did this cost?" is "not known" — while the
     * bound itself stays in PostgreSQL, where an operator auditing spend can see
     * it in full.
     */
    describe("when the cost may be incomplete", () => {
      it("publishes nothing for a first-turn timeout, whose stored figure is zero", () => {
        // Nothing was priced, but tokens may genuinely have been billed for the
        // request that timed out. "$0.00" would be the most misleading value
        // available.
        const data = mapAgentRunResponse({
          job: JOB,
          run: { ...KNOWN_COST_RUN, estimatedCostNanoUsd: 0n, possibleUnobservedCost: true },
          trace: [],
          outcome: { type: "FAILED", code: "PROVIDER_TIMEOUT", message: "m" },
        });

        expect(data.run.estimatedCostUsd).toBeNull();
      });

      it("publishes nothing for a second-turn failure, and keeps the bound in the record", () => {
        // Turn one succeeded and was priced; turn two failed ambiguously. The
        // stored 17_956_000n is real spend — just not all of it.
        const run: AgentRunRecord = { ...KNOWN_COST_RUN, possibleUnobservedCost: true };

        const data = mapAgentRunResponse({
          job: JOB,
          run,
          trace: [],
          outcome: { type: "FAILED", code: "PROVIDER_UNAVAILABLE", message: "m" },
        });

        expect(data.run.estimatedCostUsd).toBeNull();
        // Retained for audit: the DTO hides it, the database still has it.
        expect(run.estimatedCostNanoUsd).toBe(17_956_000n);
      });

      it("hides the figure regardless of how large the observed bound is", () => {
        const data = mapAgentRunResponse({
          job: JOB,
          run: {
            ...KNOWN_COST_RUN,
            estimatedCostNanoUsd: 999_999_999n,
            possibleUnobservedCost: true,
          },
          trace: [],
          outcome: { type: "COMPLETED", report: REPORT },
        });

        expect(data.run.estimatedCostUsd).toBeNull();
      });

      it("publishes nothing for a null cost that is also marked uncertain", () => {
        // The pair the collector now always produces for an unmeasurable turn.
        // Both reasons independently hide the row; asserting the combination
        // pins the contract for the record the database actually stores.
        const data = mapAgentRunResponse({
          job: JOB,
          run: { ...KNOWN_COST_RUN, estimatedCostNanoUsd: null, possibleUnobservedCost: true },
          trace: [],
          outcome: { type: "COMPLETED", report: REPORT },
        });

        expect(data.run.estimatedCostUsd).toBeNull();
      });

      it("never leaks the bound through the serialized response", () => {
        const data = mapAgentRunResponse({
          job: JOB,
          run: { ...KNOWN_COST_RUN, possibleUnobservedCost: true },
          trace: [],
          outcome: { type: "COMPLETED", report: REPORT },
        });

        const serialized = JSON.stringify(data);
        expect(serialized).not.toContain("17956000");
        expect(serialized).not.toContain("possibleUnobservedCost");
        // And no bigint survived to reach JSON.stringify, which would have thrown.
        expect(JSON.parse(serialized).run.estimatedCostUsd).toBeNull();
      });
    });
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
