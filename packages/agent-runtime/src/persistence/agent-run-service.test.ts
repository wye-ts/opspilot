import { PersistenceError, type AgentJobRecord, type PersistedAgentJob } from "@opspilot/database";
import type { ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeLlmProvider, type FakeAgentScenario } from "../providers/fake-llm-provider";
import { LlmProviderError, type LlmProvider, type LlmProviderErrorCategory } from "../providers/llm-provider";
import type { RunAbortContext } from "../providers/run-abort-context";
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

// Throws an LlmProviderError of the given category on the first turn — the
// path runAgentOrchestrator's catch converts into a `failed` result via
// providerFailureCode(category). Used to reach the PROVIDER_UNAVAILABLE /
// PROVIDER_TIMEOUT / PROVIDER_CANCELLED codes without going through a real
// Anthropic client.
function providerThrowingCategory(category: LlmProviderErrorCategory, message = "sanitized"): LlmProvider {
  return {
    runAgentTurn: vi.fn(async () => {
      throw new LlmProviderError(category, message);
    }),
  };
}

// A RunAbortContext with independently controllable source signals. Real
// construction (createRunAbortHandles) always builds `signal` as
// AbortSignal.any([deadlineSignal, disconnectSignal]); mirrored here so a
// resolveAbortProvenance call sees a context shaped exactly like production.
function buildAbortContext(overrides: { deadlineAborted?: boolean; disconnectAborted?: boolean } = {}): RunAbortContext {
  const deadlineController = new AbortController();
  const disconnectController = new AbortController();
  if (overrides.deadlineAborted) deadlineController.abort();
  if (overrides.disconnectAborted) disconnectController.abort();
  return {
    deadlineSignal: deadlineController.signal,
    disconnectSignal: disconnectController.signal,
    signal: AbortSignal.any([deadlineController.signal, disconnectController.signal]),
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
  const calls = { startRun: 0, finalizeCompleted: 0, finalizeFailed: 0, getAgentRun: 0, getAgentJob: 0 };
  const persistedRuns = new Map<string, unknown>();
  // The exact `code` argument each finalizeFailed call actually received —
  // exposed so tests can assert on what was PERSISTED, not just on the
  // in-memory AgentOrchestratorResult the service happened to return.
  const finalizeFailedCodes: unknown[] = [];
  const jobSnapshot = options.jobSnapshot ?? DEFAULT_JOB_SNAPSHOT;
  // The exact AgentJobRecord object instances startRun returned, in call
  // order — exposed so tests can assert identity (===) against whatever
  // executeAndPersist actually passed to createProvider, not just structural
  // equality (see the "invokes createProvider with the exact AgentJobRecord
  // instance" test below).
  const startedJobs: AgentJobRecord[] = [];

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
      // The "database row" for this jobId — deliberately independent of
      // anything a caller could have supplied, since callers only ever
      // pass jobId, never a job object. Constructed once and reused (never
      // rebuilt) so `startedJobs` and the returned `job` field are the same
      // object reference.
      const startedJob: AgentJobRecord = { ...jobSnapshot, id: jobId };
      startedJobs.push(startedJob);
      return {
        job: startedJob,
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
    finalizeFailed: async (runId, _trace, code) => {
      calls.finalizeFailed += 1;
      finalizeFailedCodes.push(code);
      if (options.finalizeError) throw options.finalizeError;
      persistedRuns.set(runId, { status: "FAILED", code });
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
    getAgentJob: async (jobId): Promise<PersistedAgentJob> => {
      calls.getAgentJob += 1;
      return { job: { ...jobSnapshot, id: jobId }, runs: [] };
    },
  };

  return { repository, calls, startedJobs, finalizeFailedCodes };
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
      createProvider: () => provider,
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

  it("invokes createProvider with the exact AgentJobRecord instance startRun returned, not a clone, reconstruction, or separately-read value", async () => {
    const jobSnapshot: AgentJobRecord = {
      id: JOB_ID,
      ticketContext: { ticketId: "TKT-factory-input", summary: "Factory input summary" },
      externalTicketId: "TKT-factory-input",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { repository, startedJobs } = createFakeRepository({ jobSnapshot });
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    // Typed with an explicit (job: AgentJobRecord) parameter — a zero-arg
    // `vi.fn(() => provider)` would infer an empty-tuple call-args type,
    // making `.mock.calls[0][0]` fail to typecheck rather than assert on it.
    const createProvider = vi.fn((_job: AgentJobRecord) => provider);

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider,
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(createProvider).toHaveBeenCalledTimes(1);
    const startedJob = startedJobs[0];
    if (!startedJob) throw new Error("expected startRun to have recorded the started job");
    // Identity (toBe), not structural equality (toHaveBeenCalledWith/toEqual)
    // — this fails if executeAndPersist ever clones, reconstructs, or
    // separately re-reads the job before invoking createProvider, since any
    // of those would produce a distinct object reference that is
    // structurally identical but not ===.
    expect(createProvider.mock.calls[0]?.[0]).toBe(startedJob);

    // The initial conversation is derived from that exact same snapshot.
    const firstCall = runAgentTurnSpy.mock.calls[0];
    if (!firstCall) throw new Error("expected runAgentTurn to have been called at least once");
    expect(firstCall[0].conversation).toEqual([
      {
        role: "ticket_context",
        ticketId: startedJob.ticketContext.ticketId,
        summary: startedJob.ticketContext.summary,
      },
    ]);
  });

  it("returns persisted on the happy path", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });
    expect(result.persistence).toBe("persisted");
  });

  it("returns stage: run-creation when startRun fails, without ever calling createProvider or the orchestrator", async () => {
    const startRunError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down");
    const { repository, calls } = createFakeRepository({ startRunError });
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const createProvider = vi.fn(() => provider);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider,
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(result).toMatchObject({ persistence: "unavailable", stage: "run-creation", error: startRunError });
    expect(createProvider).not.toHaveBeenCalled();
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
      createProvider: () => reportSubmittingProvider(),
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
        createProvider: () => throwingProvider(sentinelText),
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

  it("throws only a stable AgentRunServiceError when createProvider itself throws, leaving the run RUNNING and never leaking the raw factory error", async () => {
    const sentinelText = "factory-internal-detail: sk-live-DO-NOT-LEAK";
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    let caught: unknown;
    try {
      await service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        createProvider: () => {
          throw new Error(sentinelText);
        },
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
    expect(serviceError.message).not.toContain(sentinelText);
    expect(JSON.stringify(serviceError)).not.toContain("sk-live-");
    expect((serviceError.cause as Error).message).toBe(sentinelText);

    // The run stays RUNNING — no finalize call was ever attempted, matching
    // the currently documented recovery limitation (no reaper/recovery in
    // this milestone; see docs/11-agent-run-persistence.md).
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
      createProvider: () => reportSubmittingProvider(),
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
      createProvider: () => reportSubmittingProvider(),
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

describe("getAgentJob", () => {
  it("passes through to repository.getAgentJob", async () => {
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.getAgentJob(JOB_ID);

    expect(calls.getAgentJob).toBe(1);
    expect(result.job.id).toBe(JOB_ID);
    expect(result.runs).toEqual([]);
  });
});

describe("executeAndPersist — cancellation signal forwarding", () => {
  it("forwards the caller's signal, unchanged, to every provider turn", async () => {
    // ExecuteAndPersistParams inherits `signal` from AgentOrchestratorParams,
    // so the service boundary must actually forward it. An inherited-but-dropped
    // option would silently ignore a caller's cancellation while still
    // type-checking — the failure mode this test exists to prevent.
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const controller = new AbortController();

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => provider,
      toolRegistry: toolRegistryWithServiceStatus(),
      signal: controller.signal,
    });

    expect(result.persistence).toBe("persisted");
    // The scenario is investigation-then-report, so both turns must be covered.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    for (const [input] of runAgentTurnSpy.mock.calls) {
      // Identity, not equality: the boundary must neither replace the signal
      // with a fresh one nor wrap it.
      expect(input.signal).toBe(controller.signal);
    }
  });

  it("omits the signal entirely when the caller supplies none", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => provider,
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    for (const [input] of runAgentTurnSpy.mock.calls) {
      expect(input.signal).toBeUndefined();
    }
  });
});

describe("executeAndPersist — single signal source (abortContext takes precedence)", () => {
  it("forwards abortContext.signal, by identity, to every provider turn", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const abortContext = buildAbortContext();

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => provider,
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("persisted");
    // toolThenReportScenario is investigation-then-report: both turns must
    // receive the same object, not a fresh signal per call.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    for (const [input] of runAgentTurnSpy.mock.calls) {
      expect(input.signal).toBe(abortContext.signal);
    }
  });

  it("still forwards a bare `signal` for a legacy caller that supplies no abortContext", async () => {
    // The worker's demo scripts (and any other caller with no abort-provenance
    // tracking) pass `signal` alone. That path must keep working unchanged.
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const controller = new AbortController();

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => provider,
      toolRegistry: toolRegistryWithServiceStatus(),
      signal: controller.signal,
    });

    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    for (const [input] of runAgentTurnSpy.mock.calls) {
      expect(input.signal).toBe(controller.signal);
    }
  });

  it("prefers abortContext.signal over a plain signal when both are somehow supplied", async () => {
    // Not a shape any caller in this codebase actually produces (the API
    // controller passes abortContext alone; the worker demo passes signal
    // alone) — but the precedence rule itself must hold regardless, so that
    // there is exactly one way to read "which signal is in effect" even if a
    // future caller gets this wrong.
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const provider = reportSubmittingProvider();
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const abortContext = buildAbortContext();
    const unrelatedController = new AbortController();

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => provider,
      toolRegistry: toolRegistryWithServiceStatus(),
      signal: unrelatedController.signal,
      abortContext,
    });

    for (const [input] of runAgentTurnSpy.mock.calls) {
      expect(input.signal).toBe(abortContext.signal);
      expect(input.signal).not.toBe(unrelatedController.signal);
    }
  });
});

describe("executeAndPersist / retryFinalization — abort provenance survives finalization failure and retry", () => {
  it("resolves provenance once: a deadline override survives a finalization PersistenceError", async () => {
    const finalizeError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down mid-finalize");
    const { repository } = createFakeRepository({ finalizeError });
    const service = createAgentRunService(repository);
    // The provider reports CANCELLED (a plausible raw SDK classification for
    // any abort); the deadline having fired is what should override it.
    const abortContext = buildAbortContext({ deadlineAborted: true });

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => providerThrowingCategory("CANCELLED"),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("unavailable");
    if (result.persistence !== "unavailable" || result.stage !== "finalization") {
      throw new Error("expected stage: finalization");
    }
    expect(result.agentResult.status).toBe("failed");
    if (result.agentResult.status !== "failed") throw new Error("expected a failed result");
    // Resolved BEFORE the PersistenceError, not left as the provider's raw
    // CANCELLED classification — this is the property the whole fix protects.
    expect(result.agentResult.code).toBe("PROVIDER_TIMEOUT");
  });

  it("retrying that same agentResult persists PROVIDER_TIMEOUT, with no abortContext available to the retry", async () => {
    const finalizeError = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down mid-finalize");
    const { repository } = createFakeRepository({ finalizeError });
    const service = createAgentRunService(repository);
    const abortContext = buildAbortContext({ deadlineAborted: true });

    const first = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => providerThrowingCategory("CANCELLED"),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });
    if (first.persistence !== "unavailable" || first.stage !== "finalization") {
      throw new Error("expected stage: finalization");
    }
    expect(first.agentResult.status).toBe("failed");
    if (first.agentResult.status !== "failed") throw new Error("expected a failed result");
    expect(first.agentResult.code).toBe("PROVIDER_TIMEOUT");

    // A fresh repository, persistence now "working" — retryFinalization is
    // called with the SAME agentResult object executeAndPersist returned, and
    // with no abortContext at all (retryFinalization's signature carries none).
    const { repository: healthyRepository, finalizeFailedCodes } = createFakeRepository();
    const healthyService = createAgentRunService(healthyRepository);

    const retry = await healthyService.retryFinalization(first.runId, first.agentResult);

    expect(retry.persistence).toBe("persisted");
    // The database received PROVIDER_TIMEOUT — the code a transient failure
    // must never be allowed to revert to the provider's raw classification.
    expect(finalizeFailedCodes).toEqual(["PROVIDER_TIMEOUT"]);
  });

  it("a disconnect override replaces a native TIMEOUT classification with PROVIDER_CANCELLED", async () => {
    const { repository, finalizeFailedCodes } = createFakeRepository();
    const service = createAgentRunService(repository);
    // The transport reports its own TIMEOUT; the caller having disconnected
    // (not the deadline) is what should take precedence.
    const abortContext = buildAbortContext({ disconnectAborted: true });

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => providerThrowingCategory("TIMEOUT"),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("persisted");
    expect(finalizeFailedCodes).toEqual(["PROVIDER_CANCELLED"]);
  });

  it("a provider-native timeout is left unchanged when neither outer signal is aborted", async () => {
    const { repository, finalizeFailedCodes } = createFakeRepository();
    const service = createAgentRunService(repository);
    // Both source signals live but un-fired: this is the ordinary case of the
    // SDK's own per-attempt timeout firing well inside the caller's deadline
    // and with the caller still connected.
    const abortContext = buildAbortContext();

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => providerThrowingCategory("TIMEOUT"),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("persisted");
    expect(finalizeFailedCodes).toEqual(["PROVIDER_TIMEOUT"]);
  });

  it("leaves a completed result untouched even when the deadline fired", async () => {
    // A run can legitimately finish (report submitted) at almost the exact
    // moment its deadline expires. resolveAgentResultAbortProvenance must
    // never touch a completed result — there is no `code` field to rewrite,
    // and finalizeCompleted (never finalizeFailed) must be the call made.
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const abortContext = buildAbortContext({ deadlineAborted: true });

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("persisted");
    expect(calls.finalizeCompleted).toBe(1);
    expect(calls.finalizeFailed).toBe(0);
  });
});
