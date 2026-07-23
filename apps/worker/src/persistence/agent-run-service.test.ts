import { PersistenceError, type AgentJobRecord } from "@opspilot/database";
import type { ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeLlmProvider, type FakeAgentScenario } from "../providers/fake-llm-provider";
import type { LlmProvider } from "../providers/llm-provider";
import { getServiceStatusTool, InMemoryToolRegistry } from "../tools";
import type { AgentRunRepositoryInterface } from "./agent-run-repository-interface";
import { createAgentRunService } from "./agent-run-service";
import { AgentRunServiceError } from "./agent-run-service-error";

const TOOL_CALL_ID = "call-1";

// Evidence cites the tool call this scenario actually makes — the
// orchestrator's evidence-grounding check (agent-orchestrator.ts's
// findInvalidEvidence) rejects any citation that isn't backed by a real
// retrieval/tool result, so a report-only single-turn provider can never
// produce a "completed" AgentOrchestratorResult on its own.
const VALID_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: TOOL_CALL_ID, sourceType: "TOOL_EXECUTION", finding: "Finding" }],
  suggestedActions: [],
};

const JOB_ID = "job-1";

const DEFAULT_JOB_SNAPSHOT: AgentJobRecord = {
  id: JOB_ID,
  ticketContext: { ticketId: "TKT-1", summary: "Summary" },
  externalTicketId: "TKT-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function toolThenReportScenario(): FakeAgentScenario {
  const usage = { inputTokens: 1, outputTokens: 1 };
  return {
    id: "agent-run-service-test",
    turns: [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          { toolCallId: TOOL_CALL_ID, toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
        ],
      },
      { kind: "report_submission", usage, rawInput: VALID_REPORT },
    ],
  };
}

function reportSubmittingProvider(): LlmProvider {
  return new FakeLlmProvider(toolThenReportScenario());
}

function toolRegistryWithServiceStatus(): InMemoryToolRegistry {
  return new InMemoryToolRegistry([getServiceStatusTool]);
}

function throwingProvider(message: string): LlmProvider {
  return {
    runAgentTurn: vi.fn(async () => {
      throw new Error(message);
    }),
  };
}

interface FakeRepositoryOptions {
  startRunError?: unknown;
  finalizeError?: unknown;
  // Stands in for "what the database row actually contains" — returned by
  // startRun regardless of what the caller passed (the caller passes only
  // jobId, never a job object), proving the DB, not the caller, is the
  // source of truth for ticket context.
  jobSnapshot?: AgentJobRecord;
}

function createFakeRepository(options: FakeRepositoryOptions = {}) {
  let nextRunId = 1;
  const calls = { startRun: 0, finalizeCompleted: 0, finalizeFailed: 0, getAgentRun: 0 };
  const persistedRuns = new Map<string, unknown>();
  const jobSnapshot = options.jobSnapshot ?? DEFAULT_JOB_SNAPSHOT;

  const repository: AgentRunRepositoryInterface = {
    createJob: async (ticketContext) => ({
      id: JOB_ID,
      ticketContext: ticketContext as { ticketId: string; summary: string },
      externalTicketId: (ticketContext as { ticketId: string }).ticketId,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    startRun: async (jobId, providerMode) => {
      calls.startRun += 1;
      if (options.startRunError) throw options.startRunError;
      const id = `run-${nextRunId++}`;
      return {
        // The "database row" for this jobId — deliberately independent of
        // anything a caller could have supplied, since callers only ever
        // pass jobId, never a job object.
        job: { ...jobSnapshot, id: jobId },
        run: {
          id,
          jobId,
          attemptNumber: 1,
          status: "RUNNING",
          providerMode,
          modelIdentifier: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },
    finalizeCompleted: async (runId, trace, report) => {
      calls.finalizeCompleted += 1;
      if (options.finalizeError) throw options.finalizeError;
      persistedRuns.set(runId, { status: "COMPLETED", trace, report });
      return {
        id: runId,
        jobId: JOB_ID,
        attemptNumber: 1,
        status: "COMPLETED",
        providerMode: "FAKE",
        modelIdentifier: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    finalizeFailed: async (runId) => {
      calls.finalizeFailed += 1;
      if (options.finalizeError) throw options.finalizeError;
      persistedRuns.set(runId, { status: "FAILED" });
      return {
        id: runId,
        jobId: JOB_ID,
        attemptNumber: 1,
        status: "FAILED",
        providerMode: "FAKE",
        modelIdentifier: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    getAgentRun: async (runId) => {
      calls.getAgentRun += 1;
      return {
        job: jobSnapshot,
        run: {
          id: runId,
          jobId: JOB_ID,
          attemptNumber: 1,
          status: "COMPLETED",
          providerMode: "FAKE",
          modelIdentifier: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        trace: [{ type: "REPORT_GENERATED" }],
        outcome: { type: "COMPLETED", report: VALID_REPORT },
      };
    },
  };

  return { repository, calls };
}

describe("executeAndPersist", () => {
  it("derives the initial conversation from the database job snapshot returned by startRun, not any caller-supplied value", async () => {
    // The caller supplies ONLY jobId below — there is no ticketContext or
    // job object anywhere in the call. This fake repository's startRun
    // stands in for "the locked PostgreSQL row" and returns a snapshot
    // with a distinct ticketId/summary that the test can then assert was
    // exactly what reached the orchestrator.
    const jobSnapshot: AgentJobRecord = {
      id: JOB_ID,
      ticketContext: { ticketId: "TKT-distinct-999", summary: "A distinct summary only the database row carries" },
      externalTicketId: "TKT-distinct-999",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { repository } = createFakeRepository({ jobSnapshot });
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider,
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(runAgentTurnSpy).toHaveBeenCalled();
    const firstCall = runAgentTurnSpy.mock.calls[0];
    if (!firstCall) throw new Error("expected runAgentTurn to have been called at least once");
    expect(firstCall[0].conversation).toEqual([
      {
        role: "ticket_context",
        ticketId: "TKT-distinct-999",
        summary: "A distinct summary only the database row carries",
      },
    ]);
  });

  it("returns persisted on the happy path", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider: reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });
    expect(result.persistence).toBe("persisted");
  });

  it("returns stage: run-creation when startRun fails, without ever calling the orchestrator", async () => {
    const startRunError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down");
    const { repository, calls } = createFakeRepository({ startRunError });
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider,
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(result).toMatchObject({ persistence: "unavailable", stage: "run-creation", error: startRunError });
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
    expect(calls.startRun).toBe(1);
  });

  it("returns stage: finalization with runId and agentResult when finalize fails", async () => {
    const finalizeError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down mid-finalize");
    const { repository } = createFakeRepository({ finalizeError });
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider: reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(result.persistence).toBe("unavailable");
    if (result.persistence === "unavailable" && result.stage === "finalization") {
      expect(result.runId).toBe("run-1");
      expect(result.agentResult.status).toBe("completed");
      expect(result.error).toBe(finalizeError);
    } else {
      throw new Error("expected stage: finalization");
    }
  });

  it("throws AgentRunServiceError when the orchestrator crashes, never leaking the raw cause text", async () => {
    const sentinelText =
      "at /Users/real-person/secret-project/src/index.ts:42:7\n" +
      "Provider response: {\"choices\":[{\"text\":\"leaked\"}]}\n" +
      "tool output: DROP TABLE users;\n" +
      "sk-live-ABCDEF1234567890";
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    let caught: unknown;
    try {
      await service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        provider: throwingProvider(sentinelText),
        toolRegistry: toolRegistryWithServiceStatus(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentRunServiceError);
    const serviceError = caught as AgentRunServiceError;
    expect(serviceError.code).toBe("AGENT_EXECUTION_CRASHED");
    expect(serviceError.message).toBe("The agent execution terminated unexpectedly.");
    expect(serviceError.runId).toBe("run-1");

    // The raw text must never appear anywhere a caller would naturally
    // observe: the message, JSON.stringify, or String() coercion.
    expect(serviceError.message).not.toContain(sentinelText);
    expect(JSON.stringify(serviceError)).not.toContain("sk-live-");
    expect(JSON.stringify(serviceError)).not.toContain("secret-project");
    expect(String(serviceError)).not.toContain("DROP TABLE");

    // It IS reachable via .cause, internal-debugging-only.
    expect((serviceError.cause as Error).message).toBe(sentinelText);

    // finalize was never attempted — nothing to finalize, no fabricated
    // AgentOrchestratorErrorCode was ever computed.
    expect(calls.finalizeCompleted).toBe(0);
    expect(calls.finalizeFailed).toBe(0);
  });
});

describe("retryFinalization", () => {
  it("reuses the same runId and never allocates a new attempt", async () => {
    const finalizeError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "transient");
    const { repository, calls } = createFakeRepository({ finalizeError });
    const service = createAgentRunService(repository);

    const first = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider: reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });
    expect(first.persistence).toBe("unavailable");
    if (first.persistence !== "unavailable" || first.stage !== "finalization") {
      throw new Error("expected stage: finalization");
    }

    expect(calls.startRun).toBe(1);

    // Retry with persistence now "working" (simulate by rebuilding the
    // repository without the induced error, but same underlying map/calls
    // object would be ideal — here we just confirm retryFinalization takes
    // the runId path, not a fresh startRun).
    const retryResult = await service.retryFinalization(first.runId, first.agentResult);
    expect(retryResult.persistence).toBe("unavailable"); // still erroring, same fake
    expect(calls.startRun).toBe(1); // unchanged — no new attempt allocated
  });

  it("returns persisted once the underlying failure clears, without a new startRun call", async () => {
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const runResult = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      provider: reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });
    expect(runResult.persistence).toBe("persisted");
    expect(calls.startRun).toBe(1);

    if (runResult.persistence !== "persisted") throw new Error("expected persisted");
    const retry = await service.retryFinalization(runResult.run.run.id, {
      status: "completed",
      report: VALID_REPORT,
      trace: [{ type: "REPORT_GENERATED" }],
    });
    expect(retry.persistence).toBe("persisted");
    expect(calls.startRun).toBe(1);
  });
});
