import {
  LiveRunAdmissionError,
  PersistenceError,
  type AgentJobRecord,
  type AgentRunRecord,
  type PersistedAgentJob,
} from "@opspilot/database";
import {
  deriveExecutionStageProgress,
  InvestigationEventContractError,
  type InvestigationEventPayload,
  type InvestigationRunStatus,
  type ResolutionReport,
} from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeLlmProvider, type FakeAgentScenario } from "../providers/fake-llm-provider";
import { LlmProviderError, type LlmProvider, type LlmProviderErrorCategory } from "../providers/llm-provider";
import type { RunAbortContext } from "../providers/run-abort-context";
import { getServiceStatusTool, InMemoryToolRegistry } from "../tools";
import type { AgentRunRepositoryInterface } from "./agent-run-repository-interface";
import type { RunProviderUsageSummary } from "./run-provider-usage";
import { createAgentRunService } from "./agent-run-service";
import {
  AgentRunConfigurationError,
  AgentRunServiceError,
  InvestigationEventEmissionError,
} from "./agent-run-service-error";

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
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint B: the new-write contract requires
  // recommendationDisposition; zero suggested actions => ADVISORY.
  recommendationDisposition: "ADVISORY",
};

const JOB_ID = "job-1";
// The client's key for a LIVE request. A real one is a UUID (the API validates
// that at the edge and the column enforces it); the service layer only ever
// passes it through, so a stable literal is what these tests need.
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
          {
            toolCallId: TOOL_CALL_ID,
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Checkpoint B: first request, run before any evidence exists, so
            // it must carry the run-state-consistent NO_EVIDENCE_YET claim.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "NO_EVIDENCE_YET",
              supportedBy: [],
            },
          },
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
  /**
   * Injects a canonical-append failure. Receives the payload being emitted
   * and how many events have already been recorded, so a test can fail at an
   * exact point in the lifecycle (e.g. "after the tool completed") rather
   * than only at the first event.
   */
  appendEventError?: (payload: InvestigationEventPayload, alreadyEmitted: number) => unknown;
  startLiveRunError?: unknown;
  replayLiveRunError?: unknown;
  reconcileError?: unknown;
  // Stands in for "what the database row actually contains" — returned by
  // startRun regardless of what the caller passed (the caller passes only
  // jobId, never a job object), proving the DB, not the caller, is the
  // source of truth for ticket context.
  jobSnapshot?: AgentJobRecord;
}

/**
 * The four inputs a LIVE call is now REQUIRED to carry.
 *
 * `providerMode` alone decides the execution path, and the path it decides on
 * must be fully equipped: a LIVE run missing any of these is refused outright
 * rather than quietly served by the unprotected `startRun` path. Every LIVE test
 * below spreads this in, which is the point — the equipped combination is the
 * only one that runs.
 */
function liveSafeguardInputs() {
  return {
    usageHooks: {
      createCollector: () => ({
        record: () => undefined,
        snapshot: (): RunProviderUsageSummary => ({
          providerCallsObserved: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
          estimatedCostNanoUsd: 1_000_000n,
          pricingStatus: "CURRENT",
          possibleUnobservedCost: false,
        }),
      }),
    },
    liveAttemptLimit: 2,
    budgetReservationInput: {
      budgetDate: "2026-07-29",
      dailyLimit: 10,
      costCeilingNanoUsd: 1_000_000_000n,
    },
    clientRequestId: CLIENT_REQUEST_ID,
  };
}

function createFakeRepository(options: FakeRepositoryOptions = {}) {
  let nextRunId = 1;
  const calls = {
    startRun: 0,
    startLiveRunWithAttemptLimit: 0,
    replayLiveRun: 0,
    appendInvestigationEvent: 0,
    finalizeCompleted: 0,
    finalizeFailed: 0,
    reconcileLiveRunBudget: 0,
    getAgentRun: 0,
    getAgentJob: 0,
    getInvestigationState: 0,
  };
  // Every canonical lifecycle payload the service emitted, in order — the
  // fake's stand-in for the durable ledger, so tests can reduce the recorded
  // stream with the real #36 reducer.
  const emittedEvents: InvestigationEventPayload[] = [];
  // The exact `failedStage` argument each finalizeFailed call received.
  const finalizeFailedStages: unknown[] = [];
  // The exact `usage` argument each finalize call received, so tests can assert
  // on what was PERSISTED rather than only on the returned summary.
  const finalizeUsage: unknown[] = [];
  const reconciledWith: { reservation: unknown; usage: unknown }[] = [];
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
  // Every clientRequestId the live path received, in call order, so a test can
  // assert that a recovery repeated the ORIGINAL key rather than minting one.
  const clientRequestIds: string[] = [];
  // Stands in for the partial unique index on (job_id, client_request_id): the
  // fake's memory of which key already names a run.
  const liveRunsByKey = new Map<
    string,
    { job: AgentJobRecord; run: AgentRunRecord }
  >();

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
          estimatedCostNanoUsd: null,
          possibleUnobservedCost: false,
        },
      };
    },
    startLiveRunWithAttemptLimit: async ({ jobId, modelIdentifier, budget, clientRequestId, publicTrial }) => {
      calls.startLiveRunWithAttemptLimit += 1;
      if (options.startLiveRunError) throw options.startLiveRunError;
      clientRequestIds.push(clientRequestId);

      /**
       * The REPLAY arm, modelled the way the real transaction behaves.
       *
       * Keyed on (jobId, clientRequestId) exactly as the partial unique index
       * is, so a fake that "already has a run for this key" answers `replayed`
       * with NO reservation. That absence is what the service under test must
       * honour: a replay has nothing to reconcile, and handing one a reservation
       * would double-count a cost the original attempt already recorded.
       */
      const existing = liveRunsByKey.get(`${jobId}:${clientRequestId}`);
      if (existing) {
        return { outcome: "replayed" as const, job: existing.job, run: existing.run };
      }

      const id = `run-${nextRunId++}`;
      const startedJob: AgentJobRecord = { ...jobSnapshot, id: jobId };
      startedJobs.push(startedJob);
      const run = {
        id,
        jobId,
        attemptNumber: 1,
        status: "RUNNING" as const,
        providerMode: "LIVE" as const,
        modelIdentifier,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: false,
      };
      liveRunsByKey.set(`${jobId}:${clientRequestId}`, { job: startedJob, run });
      return {
        outcome: "started" as const,
        job: startedJob,
        run,
        // Echoed back from the "committed" row, exactly as the real transaction
        // does, so reconciliation keys off the reservation rather than a clock.
        reservation: { budgetDate: budget.budgetDate, runsReserved: 1, isPublic: publicTrial !== undefined },
      };
    },
    /**
     * The READ-ONLY sibling, keyed on the SAME map the creating arm writes.
     *
     * Sharing `liveRunsByKey` is what makes the fake honest about the property
     * under test: the lookup and the creating transaction agree because they read
     * the same state, exactly as the real pair agree because they read the same
     * partial unique index. A separate map would let the two drift and quietly
     * turn a replay test green for the wrong reason.
     */
    replayLiveRun: async ({ jobId, clientRequestId }) => {
      calls.replayLiveRun += 1;
      if (options.replayLiveRunError) throw options.replayLiveRunError;
      const existing = liveRunsByKey.get(`${jobId}:${clientRequestId}`);
      return existing ? { outcome: "replayed" as const, job: existing.job, run: existing.run } : null;
    },
    reconcileLiveRunBudget: async (reservation, usage) => {
      calls.reconcileLiveRunBudget += 1;
      reconciledWith.push({ reservation, usage });
      if (options.reconcileError) throw options.reconcileError;
    },
    appendInvestigationEvent: async (runId, payload) => {
      calls.appendInvestigationEvent += 1;
      const failure = options.appendEventError?.(payload, emittedEvents.length);
      if (failure) throw failure;
      emittedEvents.push(payload);
      return {
        runId,
        // 1 is RUN_CREATED, written by the run-creation transaction the real
        // repository owns; emitted events start after it.
        sequence: emittedEvents.length + 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        payload,
      };
    },
    finalizeCompleted: async (runId, report, usage) => {
      calls.finalizeCompleted += 1;
      finalizeUsage.push(usage);
      if (options.finalizeError) throw options.finalizeError;
      persistedRuns.set(runId, { status: "COMPLETED", report });
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
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: false,
      };
    },
    finalizeFailed: async (runId, code, failedStage, usage) => {
      calls.finalizeFailed += 1;
      finalizeFailedCodes.push(code);
      finalizeFailedStages.push(failedStage);
      finalizeUsage.push(usage);
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
        estimatedCostNanoUsd: null,
        possibleUnobservedCost: false,
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
          estimatedCostNanoUsd: null,
          possibleUnobservedCost: false,
        },
        trace: [{ type: "REPORT_GENERATED" }],
        outcome: { type: "COMPLETED", report: VALID_REPORT },
      };
    },
    getAgentJob: async (jobId): Promise<PersistedAgentJob> => {
      calls.getAgentJob += 1;
      return { job: { ...jobSnapshot, id: jobId }, runs: [] };
    },
    getInvestigationState: async (jobId) => {
      calls.getInvestigationState += 1;
      return { job: { ...jobSnapshot, id: jobId }, run: null, trace: [], outcome: null, events: [] };
    },
  };

  return {
    repository,
    calls,
    startedJobs,
    finalizeFailedCodes,
    finalizeFailedStages,
    finalizeUsage,
    reconciledWith,
    clientRequestIds,
    emittedEvents,
  };
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

  it("invokes onReportSchemaInvalid with a sanitized diagnostic — never the raw report — exactly once when the orchestrator fails with REPORT_SCHEMA_INVALID, and still persists the failed run normally", async () => {
    const { repository, finalizeFailedCodes } = createFakeRepository();
    const service = createAgentRunService(repository);
    const onReportSchemaInvalid = vi.fn();
    const usage = { inputTokens: 1, outputTokens: 1 };
    const invalidConfidenceScenario: FakeAgentScenario = {
      id: "invalid-confidence",
      // A structurally complete report (the drift class behind the real LIVE
      // incident): confidence given as a percentage, which the stripped
      // Claude-facing tool schema never told the model was out of bounds.
      turns: [{ kind: "report_submission", usage, rawInput: { ...VALID_REPORT, confidence: 70 } }],
    };

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => new FakeLlmProvider(invalidConfidenceScenario),
      toolRegistry: toolRegistryWithServiceStatus(),
      onReportSchemaInvalid,
    });

    expect(onReportSchemaInvalid).toHaveBeenCalledTimes(1);
    expect(onReportSchemaInvalid).toHaveBeenCalledWith({
      runId: "run-1",
      providerMode: "FAKE",
      modelIdentifier: null,
      issues: [{ path: ["confidence"], code: "too_big", origin: "number", bound: 1 }],
    });
    expect(JSON.stringify(onReportSchemaInvalid.mock.calls[0])).not.toContain("70");

    expect(result.persistence).toBe("persisted");
    expect(finalizeFailedCodes).toEqual(["REPORT_SCHEMA_INVALID"]);
  });

  it("never invokes onReportSchemaInvalid for a different failure code", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const onReportSchemaInvalid = vi.fn();

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => providerThrowingCategory("RATE_LIMIT"),
      toolRegistry: toolRegistryWithServiceStatus(),
      onReportSchemaInvalid,
    });

    expect(onReportSchemaInvalid).not.toHaveBeenCalled();
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
    const retryResult = await service.retryFinalization({
      runId: first.runId,
      agentResult: first.agentResult,
      usageSummary: first.usageSummary,
    });
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
    const retry = await service.retryFinalization({
      runId: runResult.run.run.id,
      agentResult: {
        status: "completed",
        report: VALID_REPORT,
        trace: [{ type: "REPORT_GENERATED" }],
      },
      usageSummary: null,
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
      ...liveSafeguardInputs(),
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
      ...liveSafeguardInputs(),
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
      ...liveSafeguardInputs(),
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
      ...liveSafeguardInputs(),
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

    const retry = await healthyService.retryFinalization({
      runId: first.runId,
      agentResult: first.agentResult,
      usageSummary: first.usageSummary,
    });

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
      ...liveSafeguardInputs(),
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
      ...liveSafeguardInputs(),
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
      ...liveSafeguardInputs(),
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
      abortContext,
    });

    expect(result.persistence).toBe("persisted");
    expect(calls.finalizeCompleted).toBe(1);
    expect(calls.finalizeFailed).toBe(0);
  });
});

/**
 * The ownership properties. These are the reason the collector lifecycle lives
 * in the service rather than the controller: only the service can write what it
 * observed in the SAME statement that finalizes the run, so the persisted usage
 * and the reconciled usage cannot disagree.
 */
describe("executeAndPersist — service-owned usage collector", () => {
  const RESERVATION_INPUT = {
    budgetDate: "2026-07-29",
    dailyLimit: 10,
    costCeilingNanoUsd: 1_000_000_000n,
  } as const;

  function usageSummary(overrides: Partial<RunProviderUsageSummary> = {}): RunProviderUsageSummary {
    return {
      providerCallsObserved: 2,
      inputTokens: 1_200,
      outputTokens: 400,
      cacheReadInputTokens: 10,
      cacheCreation5mInputTokens: 20,
      cacheCreation1hInputTokens: 30,
      estimatedCostNanoUsd: 17_956_000n,
      pricingStatus: "CURRENT",
      possibleUnobservedCost: false,
      ...overrides,
    };
  }

  // A collector whose snapshot count is observable, so "exactly one snapshot"
  // can be asserted directly rather than inferred.
  function countingCollector(summary = usageSummary()) {
    let snapshots = 0;
    const recorded: unknown[] = [];
    return {
      collector: {
        record(event: unknown) {
          recorded.push(event);
        },
        snapshot() {
          snapshots += 1;
          return summary;
        },
      },
      get snapshots() {
        return snapshots;
      },
      recorded,
    };
  }

  function liveParams(
    collector: { record(event: unknown): void; snapshot(): RunProviderUsageSummary },
    provider: LlmProvider,
    onCreateProvider?: (received: unknown) => void,
  ) {
    return {
      jobId: JOB_ID,
      providerMode: "LIVE" as const,
      modelIdentifier: "claude-sonnet-5",
      createProvider: (_job: AgentJobRecord, received?: typeof collector) => {
        onCreateProvider?.(received);
        return provider;
      },
      toolRegistry: toolRegistryWithServiceStatus(),
      usageHooks: { createCollector: () => collector },
      liveAttemptLimit: 2,
      budgetReservationInput: RESERVATION_INPUT,
      clientRequestId: CLIENT_REQUEST_ID,
    };
  }

  it("routes a live run through the atomic transaction, not the plain startRun", async () => {
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    await service.executeAndPersist(liveParams(counting.collector, reportSubmittingProvider()));

    expect(calls.startLiveRunWithAttemptLimit).toBe(1);
    expect(calls.startRun).toBe(0);
  });

  it("creates the collector and hands that same instance to createProvider", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();
    let received: unknown;

    await service.executeAndPersist(
      liveParams(counting.collector, reportSubmittingProvider(), (value) => {
        received = value;
      }),
    );

    expect(received).toBe(counting.collector);
  });

  it("takes exactly ONE snapshot per run", async () => {
    // More than one could differ if an event arrived between them, which would
    // let the persisted cost and the reconciled cost diverge.
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    await service.executeAndPersist(liveParams(counting.collector, reportSubmittingProvider()));

    expect(counting.snapshots).toBe(1);
  });

  it("persists the snapshot in the same finalize call that sets the terminal status", async () => {
    const { repository, finalizeUsage, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    await service.executeAndPersist(liveParams(counting.collector, reportSubmittingProvider()));

    expect(calls.finalizeCompleted).toBe(1);
    expect(finalizeUsage).toEqual([
      {
        providerCallsObserved: 2,
        inputTokens: 1_200,
        outputTokens: 400,
        estimatedCostNanoUsd: 17_956_000n,
        pricingStatus: "CURRENT",
        possibleUnobservedCost: false,
      },
    ]);
  });

  it("returns the same usage it persisted, byte for byte", async () => {
    // The single property the whole design exists for: what agent_runs stores
    // and what the caller reconciles the budget from are one value.
    const { repository, finalizeUsage } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    const result = await service.executeAndPersist(
      liveParams(counting.collector, reportSubmittingProvider()),
    );

    if (result.persistence !== "persisted") throw new Error("expected a persisted result");
    expect(result.usageSummary?.estimatedCostNanoUsd).toBe(17_956_000n);
    expect((finalizeUsage[0] as { estimatedCostNanoUsd: bigint }).estimatedCostNanoUsd).toBe(
      result.usageSummary?.estimatedCostNanoUsd,
    );
  });

  it("does not skip finalize() when onReportSchemaInvalid throws — the run still persists as REPORT_SCHEMA_INVALID exactly once, usage/cost are still recorded for the LIVE run, no second provider call happens, and the thrown error never reaches the caller", async () => {
    const { repository, finalizeFailedCodes, finalizeUsage, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();
    const reportUsage = { inputTokens: 1, outputTokens: 1 };
    const invalidConfidenceScenario: FakeAgentScenario = {
      id: "invalid-confidence-throwing-hook",
      turns: [
        { kind: "report_submission", usage: reportUsage, rawInput: { ...VALID_REPORT, confidence: 70 } },
      ],
    };
    const provider = new FakeLlmProvider(invalidConfidenceScenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const onReportSchemaInvalid = vi.fn(() => {
      throw new Error("logger blew up");
    });

    const result = await service.executeAndPersist({
      ...liveParams(counting.collector, provider),
      onReportSchemaInvalid,
    });

    expect(onReportSchemaInvalid).toHaveBeenCalledTimes(1);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
    expect(calls.finalizeFailed).toBe(1);
    expect(finalizeFailedCodes).toEqual(["REPORT_SCHEMA_INVALID"]);
    // The result is the ordinary persisted shape — nothing about the thrown
    // hook error is present in it, and awaiting executeAndPersist resolved
    // rather than rejected, which is itself proof the throw never escaped.
    expect(result.persistence).toBe("persisted");
    expect(finalizeUsage).toEqual([
      {
        providerCallsObserved: 2,
        inputTokens: 1_200,
        outputTokens: 400,
        estimatedCostNanoUsd: 17_956_000n,
        pricingStatus: "CURRENT",
        possibleUnobservedCost: false,
      },
    ]);
  });

  it("returns the reservation the transaction committed", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    const result = await service.executeAndPersist(
      liveParams(counting.collector, reportSubmittingProvider()),
    );

    if (result.persistence !== "persisted") throw new Error("expected a persisted result");
    expect(result.reservation).toEqual({ budgetDate: "2026-07-29", runsReserved: 1, isPublic: false });
  });

  it("persists usage for a FAILED live run too", async () => {
    // The tokens were spent whether or not a report came back.
    const { repository, finalizeUsage, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector(
      usageSummary({ providerCallsObserved: 1, possibleUnobservedCost: true }),
    );
    const failing: LlmProvider = {
      runAgentTurn: async () => {
        throw new LlmProviderError("TIMEOUT", "The request to the Anthropic API timed out.");
      },
    };

    const result = await service.executeAndPersist(liveParams(counting.collector, failing));

    expect(calls.finalizeFailed).toBe(1);
    expect(finalizeUsage[0]).toMatchObject({
      providerCallsObserved: 1,
      possibleUnobservedCost: true,
    });
    if (result.persistence !== "persisted") throw new Error("expected a persisted result");
    expect(result.usageSummary?.possibleUnobservedCost).toBe(true);
  });

  it("carries a null cost through to persistence as null, never as zero", async () => {
    const { repository, finalizeUsage } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector(usageSummary({ estimatedCostNanoUsd: null }));

    await service.executeAndPersist(liveParams(counting.collector, reportSubmittingProvider()));

    expect((finalizeUsage[0] as { estimatedCostNanoUsd: bigint | null }).estimatedCostNanoUsd).toBeNull();
  });

  it("persists a null cost together with its uncertainty flag, consistently", async () => {
    // The pair the collector now guarantees. Persisting a null cost alongside
    // possibleUnobservedCost:false would be a self-contradictory audit record —
    // "complete, and unknown" — so the service must carry BOTH values through
    // unchanged rather than deriving either.
    const { repository, finalizeUsage } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector(
      usageSummary({ estimatedCostNanoUsd: null, possibleUnobservedCost: true }),
    );

    const result = await service.executeAndPersist(
      liveParams(counting.collector, reportSubmittingProvider()),
    );

    expect(finalizeUsage[0]).toMatchObject({
      estimatedCostNanoUsd: null,
      possibleUnobservedCost: true,
    });
    // The returned summary is the SAME snapshot, so the caller reconciles the
    // budget from exactly what was written.
    if (result.persistence !== "persisted") throw new Error("expected a persisted result");
    expect(result.usageSummary).toMatchObject({
      estimatedCostNanoUsd: null,
      possibleUnobservedCost: true,
    });
  });

  it("creates no collector and persists no usage for a FAKE run", async () => {
    const { repository, finalizeUsage, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    // A BARE FAKE call. This test used to pass `usageHooks` here and assert they
    // were ignored — the very inference that let a half-configured LIVE run
    // through. Under the current contract a FAKE run may not carry live inputs
    // at all (see "executeAndPersist — providerMode is authoritative"), so the
    // property worth asserting is that the honest FAKE shape builds nothing.
    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(calls.startRun).toBe(1);
    expect(calls.startLiveRunWithAttemptLimit).toBe(0);
    expect(finalizeUsage).toEqual([undefined]);
    if (result.persistence !== "persisted") throw new Error("expected a persisted result");
    expect(result.usageSummary).toBeNull();
    expect(result.reservation).toBeNull();
  });

  it("passes no collector to createProvider on the FAKE path", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    let received: unknown = "sentinel";

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: (_job, collector) => {
        received = collector;
        return reportSubmittingProvider();
      },
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(received).toBeUndefined();
  });

  it("carries usage and reservation on the finalization-unavailable variant", async () => {
    // A run that spent tokens must still be reconcilable even when its own row
    // could not be finalized.
    const { repository } = createFakeRepository({
      finalizeError: new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"),
    });
    const service = createAgentRunService(repository);
    const counting = countingCollector();

    const result = await service.executeAndPersist(
      liveParams(counting.collector, reportSubmittingProvider()),
    );

    expect(result.persistence).toBe("unavailable");
    if (result.persistence !== "unavailable" || result.stage !== "finalization") {
      throw new Error("expected a finalization-unavailable result");
    }
    expect(result.usageSummary?.estimatedCostNanoUsd).toBe(17_956_000n);
    expect(result.reservation).toEqual({ budgetDate: "2026-07-29", runsReserved: 1, isPublic: false });
  });

  it("attaches usage and reservation to a crash so the budget can still be reconciled", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const counting = countingCollector();
    const crashing: LlmProvider = {
      runAgentTurn: async () => {
        throw new TypeError("undefined is not a function");
      },
    };

    let caught: unknown;
    try {
      await service.executeAndPersist(liveParams(counting.collector, crashing));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentRunServiceError);
    const serviceError = caught as AgentRunServiceError;
    expect(serviceError.executionContext?.usageSummary?.estimatedCostNanoUsd).toBe(17_956_000n);
    expect(serviceError.executionContext?.reservation).toEqual({
      budgetDate: "2026-07-29",
      runsReserved: 1,
      isPublic: false,
    });
  });

  it("keeps the crash context internal — the public error still says nothing about spend", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);
    const crashing: LlmProvider = {
      runAgentTurn: async () => {
        throw new TypeError("boom");
      },
    };

    let caught: unknown;
    try {
      await service.executeAndPersist(liveParams(countingCollector().collector, crashing));
    } catch (error) {
      caught = error;
    }

    const serviceError = caught as AgentRunServiceError;
    expect(serviceError.message).toBe("The agent execution terminated unexpectedly.");
    expect(serviceError.message).not.toMatch(/17956000|budget|cost|token/i);
  });

  it("takes no reservation and creates no run when the transaction rejects", async () => {
    const { repository, calls } = createFakeRepository({
      startLiveRunError: new LiveRunAdmissionError("LIVE_RUN_ATTEMPT_LIMIT"),
    });
    const service = createAgentRunService(repository);

    await expect(
      service.executeAndPersist(liveParams(countingCollector().collector, reportSubmittingProvider())),
    ).rejects.toBeInstanceOf(LiveRunAdmissionError);

    // The rejection propagates unchanged rather than becoming a persistence
    // failure, so the API can map it to 429 instead of 503.
    expect(calls.finalizeCompleted).toBe(0);
    expect(calls.finalizeFailed).toBe(0);
  });

  it("maps a run-creation persistence failure to the unavailable variant", async () => {
    const { repository } = createFakeRepository({
      startLiveRunError: new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down"),
    });
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist(
      liveParams(countingCollector().collector, reportSubmittingProvider()),
    );

    expect(result).toMatchObject({ persistence: "unavailable", stage: "run-creation" });
  });

  it("does not re-snapshot on retryFinalization", async () => {
    // A retry holds no collector — it is handed the original attempt's snapshot
    // and persists exactly that.
    const counting = countingCollector();
    const { repository, finalizeUsage } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.retryFinalization({
      runId: "run-1",
      agentResult: {
        status: "completed",
        report: VALID_REPORT,
        trace: [{ type: "REPORT_GENERATED" }],
      },
      usageSummary: counting.collector.snapshot(),
    });

    // One snapshot: the one the caller took, not one the retry took for itself.
    expect(counting.snapshots).toBe(1);
    expect(finalizeUsage).toHaveLength(1);
  });
});

/**
 * The retry path's authoritative-usage guarantee.
 *
 * A rolled-back finalization is the ONLY case where a run's usage columns and
 * the day's budget row can disagree: the budget was already reconciled from the
 * measured figures, but the agent_runs row never committed them. Retrying with
 * no usage would make that disagreement permanent and silent — the audit trail
 * saying the run cost nothing, the ledger saying it cost money.
 */
describe("retryFinalization — authoritative usage survives the rollback", () => {
  const RESERVATION_INPUT = {
    budgetDate: "2026-07-29",
    dailyLimit: 10,
    costCeilingNanoUsd: 1_000_000_000n,
  } as const;

  const MEASURED: RunProviderUsageSummary = {
    providerCallsObserved: 2,
    inputTokens: 1_200,
    outputTokens: 400,
    cacheReadInputTokens: 10,
    cacheCreation5mInputTokens: 20,
    cacheCreation1hInputTokens: 30,
    estimatedCostNanoUsd: 17_956_000n,
    pricingStatus: "CURRENT",
    possibleUnobservedCost: false,
  };

  // What toUsageWrite narrows MEASURED to: the cache breakdown is a log-line
  // detail the schema deliberately does not store.
  const PERSISTED_PROJECTION = {
    providerCallsObserved: 2,
    inputTokens: 1_200,
    outputTokens: 400,
    estimatedCostNanoUsd: 17_956_000n,
    pricingStatus: "CURRENT",
    possibleUnobservedCost: false,
  };

  function liveParamsWithUsage(summary: RunProviderUsageSummary) {
    let snapshots = 0;
    return {
      snapshotCount: () => snapshots,
      params: {
        jobId: JOB_ID,
        providerMode: "LIVE" as const,
        modelIdentifier: "claude-sonnet-5",
        createProvider: () => reportSubmittingProvider(),
        toolRegistry: toolRegistryWithServiceStatus(),
        usageHooks: {
          createCollector: () => ({
            record: () => undefined,
            snapshot: () => {
              snapshots += 1;
              return summary;
            },
          }),
        },
        liveAttemptLimit: 2,
        budgetReservationInput: RESERVATION_INPUT,
        clientRequestId: CLIENT_REQUEST_ID,
      },
    };
  }

  /**
   * Runs a LIVE call against a repository whose finalization always fails, and
   * returns the `finalization` variant plus the retry-ready inputs it carries.
   */
  async function rolledBackFinalization() {
    const { repository, finalizeUsage } = createFakeRepository({
      finalizeError: new PersistenceError(
        "PERSISTENCE_UNAVAILABLE",
        "rolled back",
      ),
    });
    const live = liveParamsWithUsage(MEASURED);
    const result = await createAgentRunService(repository).executeAndPersist(
      live.params,
    );

    if (
      result.persistence !== "unavailable" ||
      result.stage !== "finalization"
    ) {
      throw new Error("expected stage: finalization");
    }
    return { result, live, attemptedUsage: finalizeUsage };
  }

  it("persists the ORIGINAL usage when the retry finally commits", async () => {
    const { result } = await rolledBackFinalization();
    // A fresh, healthy repository — the transient failure has cleared.
    const { repository, finalizeUsage } = createFakeRepository();

    const retry = await createAgentRunService(repository).retryFinalization({
      runId: result.runId,
      agentResult: result.agentResult,
      usageSummary: result.usageSummary,
    });

    expect(retry.persistence).toBe("persisted");
    // Not undefined, and not a fresh reading — the exact figures the first
    // attempt measured and the budget was already reconciled from.
    expect(finalizeUsage).toEqual([PERSISTED_PROJECTION]);
  });

  it("writes the same projection the failed attempt tried to write", async () => {
    const { result, attemptedUsage } = await rolledBackFinalization();
    const { repository, finalizeUsage } = createFakeRepository();

    await createAgentRunService(repository).retryFinalization({
      runId: result.runId,
      agentResult: result.agentResult,
      usageSummary: result.usageSummary,
    });

    // Rolled-back write and committed write, byte for byte the same value.
    expect(finalizeUsage).toEqual(attemptedUsage);
  });

  it("never snapshots again", async () => {
    const { result, live } = await rolledBackFinalization();
    const afterFirstAttempt = live.snapshotCount();
    const { repository } = createFakeRepository();

    await createAgentRunService(repository).retryFinalization({
      runId: result.runId,
      agentResult: result.agentResult,
      usageSummary: result.usageSummary,
    });

    // The collector belongs to an execution that already finished; a second
    // reading could differ from the one the budget was reconciled against.
    expect(afterFirstAttempt).toBe(1);
    expect(live.snapshotCount()).toBe(1);
  });

  it("never reconciles again, so the day's cost is not double-counted", async () => {
    const { result } = await rolledBackFinalization();
    const { repository, calls } = createFakeRepository();

    const retry = await createAgentRunService(repository).retryFinalization({
      runId: result.runId,
      agentResult: result.agentResult,
      usageSummary: result.usageSummary,
    });

    expect(calls.reconcileLiveRunBudget).toBe(0);
    // `reservation: null` is what tells the caller's cleanup block there is
    // nothing left to reconcile — the first attempt already did it.
    if (retry.persistence !== "persisted")
      throw new Error("expected persisted");
    expect(retry.reservation).toBeNull();
    expect(retry.usageSummary).toEqual(MEASURED);
  });

  it("stays idempotent across repeated retries", async () => {
    // The uncertain case: a first commit whose acknowledgement was lost, so the
    // caller retries something that may already be durable.
    const { result } = await rolledBackFinalization();
    const { repository, finalizeUsage, calls } = createFakeRepository();
    const service = createAgentRunService(repository);
    const retryParams = {
      runId: result.runId,
      agentResult: result.agentResult,
      usageSummary: result.usageSummary,
    };

    const first = await service.retryFinalization(retryParams);
    const second = await service.retryFinalization(retryParams);

    expect(first).toEqual(second);
    // Same usage each time, and still no new attempt allocated.
    expect(finalizeUsage).toEqual([PERSISTED_PROJECTION, PERSISTED_PROJECTION]);
    expect(calls.startRun).toBe(0);
    expect(calls.startLiveRunWithAttemptLimit).toBe(0);
  });

  it("preserves the resolved failure code alongside the usage", async () => {
    // Provenance and usage travel together — neither is re-derived on retry.
    const { repository } = createFakeRepository({
      finalizeError: new PersistenceError(
        "PERSISTENCE_UNAVAILABLE",
        "rolled back",
      ),
    });
    const failed = await createAgentRunService(repository).executeAndPersist({
      ...liveParamsWithUsage(MEASURED).params,
      createProvider: () => providerThrowingCategory("CANCELLED"),
      abortContext: buildAbortContext({ deadlineAborted: true }),
    });
    if (
      failed.persistence !== "unavailable" ||
      failed.stage !== "finalization"
    ) {
      throw new Error("expected stage: finalization");
    }

    const {
      repository: healthy,
      finalizeFailedCodes,
      finalizeUsage,
    } = createFakeRepository();
    await createAgentRunService(healthy).retryFinalization({
      runId: failed.runId,
      agentResult: failed.agentResult,
      usageSummary: failed.usageSummary,
    });

    expect(finalizeFailedCodes).toEqual(["PROVIDER_TIMEOUT"]);
    expect(finalizeUsage).toEqual([PERSISTED_PROJECTION]);
  });

  it("leaves usage absent for a FAKE retry, which measured none", async () => {
    const { repository, finalizeUsage } = createFakeRepository({
      finalizeError: new PersistenceError(
        "PERSISTENCE_UNAVAILABLE",
        "rolled back",
      ),
    });
    const failed = await createAgentRunService(repository).executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });
    if (
      failed.persistence !== "unavailable" ||
      failed.stage !== "finalization"
    ) {
      throw new Error("expected stage: finalization");
    }
    expect(failed.usageSummary).toBeNull();

    const { repository: healthy, finalizeUsage: retryUsage } =
      createFakeRepository();
    await createAgentRunService(healthy).retryFinalization({
      runId: failed.runId,
      agentResult: failed.agentResult,
      usageSummary: failed.usageSummary,
    });

    // `undefined`, not a zeroed row: a FAKE run made no provider call, so it has
    // no cost to record — and "0" would assert a measurement nobody took.
    expect(finalizeUsage).toEqual([undefined]);
    expect(retryUsage).toEqual([undefined]);
  });
});

/**
 * `providerMode` decides the path; the inputs must agree with it or nothing runs.
 *
 * The old rule inferred the mode from the accidental presence of all three live
 * inputs, so a LIVE request that lost one in a refactor was served QUIETLY by
 * `startRun` — real provider, no attempt limit, no budget reservation, no
 * collector, no usage persistence. Every assertion below is about the same
 * thing: an incompletely-equipped LIVE run must not execute at all.
 */
describe("executeAndPersist — providerMode is authoritative", () => {
  const NO_USAGE: RunProviderUsageSummary = {
    providerCallsObserved: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    estimatedCostNanoUsd: null,
    pricingStatus: "UNKNOWN_MODEL",
    possibleUnobservedCost: true,
  };
  const HOOKS = {
    createCollector: () => ({
      record: () => undefined,
      snapshot: () => NO_USAGE,
    }),
  };
  const RESERVATION = {
    budgetDate: "2026-07-29",
    dailyLimit: 10,
    costCeilingNanoUsd: 1_000_000_000n,
  } as const;

  const LIVE_ONLY_INPUTS = {
    usageHooks: HOOKS,
    liveAttemptLimit: 2,
    budgetReservationInput: RESERVATION,
    clientRequestId: CLIENT_REQUEST_ID,
  };

  function baseParams(
    providerMode: "FAKE" | "LIVE",
    createProvider = () => reportSubmittingProvider(),
  ) {
    return {
      jobId: JOB_ID,
      providerMode,
      createProvider,
      toolRegistry: toolRegistryWithServiceStatus(),
    };
  }

  type LiveInputKey = keyof typeof LIVE_ONLY_INPUTS;
  const ALL_LIVE_KEYS: readonly LiveInputKey[] = [
    "usageHooks",
    "liveAttemptLimit",
    "budgetReservationInput",
    "clientRequestId",
  ];

  /**
   * EVERY proper subset of the live inputs — the empty set and all fourteen
   * partial ones — ENUMERATED rather than listed.
   *
   * Each is a LIVE request that would previously have executed with the missing
   * safeguards simply absent. The list used to be written out by hand, which was
   * exhaustive only for as long as nobody added a fifth input: the fourth
   * (`clientRequestId`) arrived and the hand-written seven silently stopped
   * covering half the space. Deriving the subsets from ALL_LIVE_KEYS makes
   * "exhaustive by construction" true rather than aspirational.
   */
  const INCOMPLETE_LIVE_INPUT_SETS: readonly (readonly LiveInputKey[])[] = Array.from(
    { length: 2 ** ALL_LIVE_KEYS.length - 1 },
    (_unused, mask) => ALL_LIVE_KEYS.filter((_key, index) => (mask & (1 << index)) !== 0),
  );

  function subsetOf(keys: readonly LiveInputKey[]) {
    return Object.fromEntries(keys.map((key) => [key, LIVE_ONLY_INPUTS[key]]));
  }

  describe.each(
    INCOMPLETE_LIVE_INPUT_SETS.map((keys) => ({
      keys,
      label: keys.join(", ") || "nothing",
    })),
  )("LIVE carrying $label", ({ keys }) => {
    it("throws AgentRunConfigurationError before any repository call", async () => {
      const { repository, calls } = createFakeRepository();
      let providerBuilt = 0;
      const service = createAgentRunService(repository);

      await expect(
        service.executeAndPersist({
          ...baseParams("LIVE", () => {
            providerBuilt += 1;
            return reportSubmittingProvider();
          }),
          ...subsetOf(keys),
        }),
      ).rejects.toBeInstanceOf(AgentRunConfigurationError);

      // NEITHER repository path — not the protected one, and crucially not the
      // unprotected one it used to silently fall back to.
      expect(calls.startLiveRunWithAttemptLimit).toBe(0);
      expect(calls.startRun).toBe(0);
      expect(calls.finalizeCompleted).toBe(0);
      expect(calls.finalizeFailed).toBe(0);
      expect(calls.reconcileLiveRunBudget).toBe(0);
      // And nothing that could reach a provider was even constructed.
      expect(providerBuilt).toBe(0);
    });

    it("names the missing inputs without leaking their values", async () => {
      const { repository } = createFakeRepository();
      const service = createAgentRunService(repository);

      const error = await service
        .executeAndPersist({ ...baseParams("LIVE"), ...subsetOf(keys) })
        .then(
          () => {
            throw new Error("expected a rejection");
          },
          (thrown: unknown) => thrown as Error,
        );

      const missing = ALL_LIVE_KEYS.filter((key) => !keys.includes(key));
      for (const key of missing) expect(error.message).toContain(key);
      expect(error.message).not.toContain(RESERVATION.budgetDate);
    });
  });

  describe.each([
    ["usageHooks", { usageHooks: HOOKS }],
    ["liveAttemptLimit", { liveAttemptLimit: 2 }],
    ["budgetReservationInput", { budgetReservationInput: RESERVATION }],
    ["clientRequestId", { clientRequestId: CLIENT_REQUEST_ID }],
    ["all four", LIVE_ONLY_INPUTS],
  ])("FAKE carrying %s", (_label, extra) => {
    it("is refused rather than silently ignored", async () => {
      // A FAKE call carrying live inputs is a caller that believes it asked for
      // something it did not get. Dropping the extras on the floor would let
      // that belief stand.
      const { repository, calls } = createFakeRepository();
      const service = createAgentRunService(repository);

      await expect(
        service.executeAndPersist({ ...baseParams("FAKE"), ...extra }),
      ).rejects.toBeInstanceOf(AgentRunConfigurationError);

      expect(calls.startRun).toBe(0);
      expect(calls.startLiveRunWithAttemptLimit).toBe(0);
    });
  });

  it("runs a fully-equipped LIVE call through the atomic transaction, with one collector", async () => {
    let collectorsCreated = 0;
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      ...baseParams("LIVE"),
      usageHooks: {
        createCollector: () => {
          collectorsCreated += 1;
          return { record: () => undefined, snapshot: () => NO_USAGE };
        },
      },
      liveAttemptLimit: 2,
      budgetReservationInput: RESERVATION,
      clientRequestId: CLIENT_REQUEST_ID,
    });

    expect(result.persistence).toBe("persisted");
    expect(calls.startLiveRunWithAttemptLimit).toBe(1);
    expect(calls.startRun).toBe(0);
    expect(collectorsCreated).toBe(1);
  });

  it("runs a bare FAKE call through startRun, with no collector", async () => {
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist(baseParams("FAKE"));

    expect(result.persistence).toBe("persisted");
    expect(calls.startRun).toBe(1);
    expect(calls.startLiveRunWithAttemptLimit).toBe(0);
    if (result.persistence !== "persisted")
      throw new Error("expected persisted");
    expect(result.usageSummary).toBeNull();
    expect(result.reservation).toBeNull();
  });
});

/**
 * IDEMPOTENT LIVE CREATION, at the layer that decides whether to spend.
 *
 * The repository is where the (job_id, client_request_id) lookup actually
 * happens; these tests cover the SERVICE's half of the contract, which is the
 * half that can spend money: when the transaction answers `replayed`, nothing
 * downstream of it may run. No collector, no provider, no orchestrator, no
 * finalize, and — the one that costs real dollars twice — no reservation handed
 * back for the caller to reconcile.
 *
 * The failure this prevents is not hypothetical. A finalization persistence
 * failure happens AFTER the provider executed and after the budget was
 * reconciled, and it is reported with the same PERSISTENCE_UNAVAILABLE code as a
 * pre-run outage. Without the replay exit, the recovery the UI offers for that
 * failure is a second paid execution.
 */
describe("executeAndPersist — idempotent LIVE creation", () => {
  const RESERVATION_INPUT = {
    budgetDate: "2026-07-29",
    dailyLimit: 10,
    costCeilingNanoUsd: 1_000_000_000n,
  } as const;

  function liveCall(
    clientRequestId: string,
    onCreateProvider: () => void = () => undefined,
  ) {
    return {
      jobId: JOB_ID,
      providerMode: "LIVE" as const,
      modelIdentifier: "claude-sonnet-5",
      createProvider: () => {
        onCreateProvider();
        return reportSubmittingProvider();
      },
      toolRegistry: toolRegistryWithServiceStatus(),
      usageHooks: {
        createCollector: () => ({
          record: () => undefined,
          snapshot: (): RunProviderUsageSummary => ({
            providerCallsObserved: 1,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreation5mInputTokens: 0,
            cacheCreation1hInputTokens: 0,
            estimatedCostNanoUsd: 1_000_000n,
            pricingStatus: "CURRENT" as const,
            possibleUnobservedCost: false,
          }),
        }),
      },
      liveAttemptLimit: 5,
      budgetReservationInput: RESERVATION_INPUT,
      clientRequestId,
    };
  }

  it("marks a first, genuinely new LIVE run as started", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));

    if (result.persistence !== "persisted") throw new Error("expected persisted");
    expect(result.execution).toBe("started");
    expect(result.reservation).not.toBeNull();
  });

  it("repeating the key executes no provider and creates no second run", async () => {
    let providersBuilt = 0;
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID, () => (providersBuilt += 1)));
    const finalizesAfterFirst = calls.finalizeCompleted + calls.finalizeFailed;

    const replay = await service.executeAndPersist(
      liveCall(CLIENT_REQUEST_ID, () => (providersBuilt += 1)),
    );

    if (replay.persistence !== "persisted") throw new Error("expected persisted");
    expect(replay.execution).toBe("replayed");
    // The provider is the thing that costs money, so it is the assertion that
    // matters most: built exactly once across two requests.
    expect(providersBuilt).toBe(1);
    expect(calls.finalizeCompleted + calls.finalizeFailed).toBe(finalizesAfterFirst);
  });

  it("hands a replay no reservation, so the caller cannot reconcile it twice", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));
    const replay = await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));

    if (replay.persistence !== "persisted") throw new Error("expected persisted");
    // Both null TOGETHER. The API controller reconciles only when it has a
    // reservation AND a usage summary, so either one being null is enough — but
    // a replay measured nothing and reserved nothing, and saying so on both
    // fields keeps the reason legible rather than incidental.
    expect(replay.reservation).toBeNull();
    expect(replay.usageSummary).toBeNull();
  });

  it("a DIFFERENT key on the same job is a new request and runs again", async () => {
    let providersBuilt = 0;
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID, () => (providersBuilt += 1)));
    const second = await service.executeAndPersist(
      liveCall("22222222-2222-4222-8222-222222222222", () => (providersBuilt += 1)),
    );

    if (second.persistence !== "persisted") throw new Error("expected persisted");
    // Idempotency is scoped to the key, never to the job. A user who
    // deliberately starts another attempt still gets one — and it still counts
    // against the per-job attempt limit and the day's budget, which is the
    // repository's business rather than this layer's.
    expect(second.execution).toBe("started");
    expect(providersBuilt).toBe(2);
    expect(calls.startLiveRunWithAttemptLimit).toBe(2);
  });

  it("forwards the caller's key unchanged, both times", async () => {
    const { repository, clientRequestIds } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));
    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));

    // Not regenerated, not normalized, not defaulted. A service that minted its
    // own key on the second call would have made the replay impossible.
    expect(clientRequestIds).toEqual([CLIENT_REQUEST_ID, CLIENT_REQUEST_ID]);
  });
});

/**
 * `replayLiveRun` — the RECOVERY half of idempotency, on its own.
 *
 * Separated from `executeAndPersist` so the API can ask "does this request
 * already exist?" before it asks "may a new paid execution start?". Running those
 * in the other order is what made the documented 200 replay unreachable whenever
 * the day's spend admission was closed — including when the request's own
 * original attempt was what closed it.
 *
 * What these protect is therefore mostly about what the method REFUSES to need:
 * no reservation, no attempt limit, no usage hooks, no collector, no provider.
 */
describe("replayLiveRun", () => {
  const RESERVATION_INPUT = {
    budgetDate: "2026-07-29",
    dailyLimit: 10,
    costCeilingNanoUsd: 1_000_000_000n,
  } as const;

  function liveCall(clientRequestId: string, onCreateProvider: () => void = () => undefined) {
    return {
      jobId: JOB_ID,
      providerMode: "LIVE" as const,
      modelIdentifier: "claude-sonnet-5",
      createProvider: () => {
        onCreateProvider();
        return reportSubmittingProvider();
      },
      toolRegistry: toolRegistryWithServiceStatus(),
      ...liveSafeguardInputs(),
      budgetReservationInput: RESERVATION_INPUT,
      clientRequestId,
    };
  }

  it("reports `absent` for a key that names nothing", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.replayLiveRun({
      jobId: JOB_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });

    // `absent` is not permission to start anything — it only means the caller
    // may go on and ask the new-run gates.
    expect(result).toEqual({ replay: "absent" });
  });

  it("returns the run a previous LIVE execution created for the same key", async () => {
    const { repository } = createFakeRepository();
    const service = createAgentRunService(repository);

    const created = await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));
    if (created.persistence !== "persisted") throw new Error("expected persisted");

    const result = await service.replayLiveRun({
      jobId: JOB_ID,
      clientRequestId: CLIENT_REQUEST_ID,
    });

    if (result.replay !== "found") throw new Error("expected found");
    expect(result.run.run.id).toBe(created.run.run.id);
  });

  it("builds no provider, finalizes nothing, and reserves nothing", async () => {
    let providersBuilt = 0;
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID, () => (providersBuilt += 1)));
    const finalizesAfterFirst = calls.finalizeCompleted + calls.finalizeFailed;

    await service.replayLiveRun({ jobId: JOB_ID, clientRequestId: CLIENT_REQUEST_ID });

    // The provider is the thing that costs money. One execution, one provider,
    // however many times the key is replayed.
    expect(providersBuilt).toBe(1);
    expect(calls.finalizeCompleted + calls.finalizeFailed).toBe(finalizesAfterFirst);
    // And emphatically NOT the creating transaction: a lookup must never be able
    // to take a reservation or consume an attempt.
    expect(calls.startLiveRunWithAttemptLimit).toBe(1);
    expect(calls.reconcileLiveRunBudget).toBe(0);
  });

  it("replays the same run repeatedly without ever creating a second", async () => {
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const created = await service.executeAndPersist(liveCall(CLIENT_REQUEST_ID));
    if (created.persistence !== "persisted") throw new Error("expected persisted");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await service.replayLiveRun({
        jobId: JOB_ID,
        clientRequestId: CLIENT_REQUEST_ID,
      });
      if (result.replay !== "found") throw new Error("expected found");
      expect(result.run.run.id).toBe(created.run.run.id);
    }

    expect(calls.startLiveRunWithAttemptLimit).toBe(1);
  });

  it("requires no reservation, attempt limit, or usage hooks to answer", async () => {
    // The signature IS the assertion: the four inputs `executeAndPersist`
    // refuses a LIVE call without are exactly the ones a recovery must not have
    // to supply, because needing them is what made the answer unreachable when
    // spend admission was closed.
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    await service.replayLiveRun({ jobId: JOB_ID, clientRequestId: CLIENT_REQUEST_ID });

    expect(calls.replayLiveRun).toBe(1);
    expect(calls.startRun).toBe(0);
    expect(calls.startLiveRunWithAttemptLimit).toBe(0);
  });

  describe("when the lookup fails", () => {
    it("reports `unavailable` rather than `absent` for a persistence failure", async () => {
      const error = new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused");
      const { repository } = createFakeRepository({ replayLiveRunError: error });
      const service = createAgentRunService(repository);

      const result = await service.replayLiveRun({
        jobId: JOB_ID,
        clientRequestId: CLIENT_REQUEST_ID,
      });

      // The distinction that matters most in this file. Collapsing this into
      // `absent` would send a request that may already have executed straight
      // into new-run admission — the exact duplicate charge the key prevents.
      expect(result).toEqual({ replay: "unavailable", error });
    });

    it("reports `unavailable` for a missing job too, carrying the not-found code", async () => {
      const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no job");
      const { repository } = createFakeRepository({ replayLiveRunError: error });
      const service = createAgentRunService(repository);

      const result = await service.replayLiveRun({
        jobId: JOB_ID,
        clientRequestId: CLIENT_REQUEST_ID,
      });

      // The caller maps this to the same 404 the creating transaction produces
      // for the same cause.
      if (result.replay !== "unavailable") throw new Error("expected unavailable");
      expect(result.error.code).toBe("PERSISTENCE_NOT_FOUND");
    });

    it("re-throws a non-persistence failure rather than dressing it as unavailable", async () => {
      const { repository } = createFakeRepository({
        replayLiveRunError: new TypeError("replayLiveRun is not a function"),
      });
      const service = createAgentRunService(repository);

      // Only a persistence failure has a defined safe answer. Blanket-mapping
      // everything would hide a real bug behind "try again later".
      await expect(
        service.replayLiveRun({ jobId: JOB_ID, clientRequestId: CLIENT_REQUEST_ID }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});

/**
 * Issue #37 Phase B — the service's canonical wiring.
 *
 * These tests reduce the RECORDED canonical stream with the real #36 reducer
 * rather than re-asserting an expected event list by hand: the contract is
 * the acceptance criterion, so if the orchestrator ever emits a stream the
 * reducer rejects, that is a Phase B defect and it must fail here.
 */
describe("executeAndPersist — canonical lifecycle stream validity", () => {
  const RUN_ID_PREFIX = "run-";

  /**
   * Rebuilds what the LEDGER would contain — RUN_CREATED (written by the
   * run-creation transaction) followed by every emitted event, then the
   * terminal event the finalizer wrote — and reduces it exactly as
   * `finalizeTerminal` does in production.
   */
  function assertReducerValid(
    emitted: readonly InvestigationEventPayload[],
    terminal: InvestigationEventPayload,
    runStatus: InvestigationRunStatus,
  ) {
    const payloads: InvestigationEventPayload[] = [{ type: "RUN_CREATED" }, ...emitted, terminal];
    const events = payloads.map((payload, index) => ({
      runId: "8f14e45f-1234-4abc-8def-000000000001",
      sequence: index + 1,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload,
    }));
    const progress = deriveExecutionStageProgress({
      events,
      runStatus,
      now: events[events.length - 1]!.recordedAt,
    });
    // A terminal result must leave nothing in progress and nothing waiting.
    for (const stage of progress) {
      expect(["completed", "failed", "omitted"]).toContain(stage.status);
    }
    return progress;
  }

  it("produces a reducer-valid COMPLETED stream for a direct no-tool success", async () => {
    const { repository, emittedEvents } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(result.persistence).toBe("persisted");
    assertReducerValid(emittedEvents, { type: "RUN_COMPLETED" }, "COMPLETED");
  });

  it("produces a reducer-valid COMPLETED stream for a one-tool success", async () => {
    const { repository, emittedEvents } = createFakeRepository();
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => new FakeLlmProvider(toolThenReportScenario()),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(result.persistence).toBe("persisted");
    assertReducerValid(emittedEvents, { type: "RUN_COMPLETED" }, "COMPLETED");
  });

  it("produces a reducer-valid FAILED stream whose failedStage the reducer accepts", async () => {
    const { repository, emittedEvents, finalizeFailedCodes, finalizeFailedStages } =
      createFakeRepository();
    const service = createAgentRunService(repository);

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => providerThrowingCategory("RATE_LIMIT"),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(finalizeFailedCodes).toEqual(["PROVIDER_UNAVAILABLE"]);
    expect(finalizeFailedStages).toEqual(["AGENT_ANALYSIS"]);

    // The exact terminal payload finalizeFailed would have persisted.
    assertReducerValid(
      emittedEvents,
      { type: "RUN_FAILED", failureCode: "PROVIDER_UNAVAILABLE", failedStage: "AGENT_ANALYSIS" },
      "FAILED",
    );
  });

  it("passes the orchestrator's failedStage straight through to finalizeFailed", async () => {
    const { repository, finalizeFailedCodes, finalizeFailedStages } = createFakeRepository();
    const service = createAgentRunService(repository);
    const schemaInvalidScenario: FakeAgentScenario = {
      id: "schema-invalid",
      turns: [
        {
          kind: "report_submission",
          usage: { inputTokens: 10, outputTokens: 5 },
          rawInput: { category: "SERVICE_DEGRADATION" }, // missing required fields
        },
      ],
    };

    await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => new FakeLlmProvider(schemaInvalidScenario),
      toolRegistry: toolRegistryWithServiceStatus(),
    });

    expect(finalizeFailedCodes).toEqual(["REPORT_SCHEMA_INVALID"]);
    // REPORT_GENERATION, not AGENT_ANALYSIS: the provider had already returned
    // a report payload, so the failure belongs to report generation.
    expect(finalizeFailedStages).toEqual(["REPORT_GENERATION"]);
  });
});

describe("executeAndPersist — event-emission persistence failure", () => {
  const LEDGER_DOWN = new PersistenceError("PERSISTENCE_UNAVAILABLE", "ledger is down");

  /** Fails the append of the Nth emitted event (0-based). */
  function failAtIndex(index: number) {
    return (_payload: InvestigationEventPayload, alreadyEmitted: number) =>
      alreadyEmitted === index ? LEDGER_DOWN : undefined;
  }

  it.each([
    ["before any provider call (AGENT_STARTED)", 0, "AGENT_STARTED", 0],
    ["after the investigation provider call (TOOL_REQUESTED)", 1, "TOOL_REQUESTED", 1],
    ["after the tool completed (TOOL_COMPLETED)", 2, "TOOL_COMPLETED", 1],
    // Checkpoint B (#57): with MAX_PROVIDER_TURNS = 4, toolThenReportScenario's
    // report lands on an INVESTIGATION turn as a voluntary early report — no
    // REPORT_GENERATION_STARTED — so REPORT_SUBMITTED is index 3 and
    // REPORT_VALIDATED index 4 on this two-turn path.
    ["after a voluntary report was submitted (REPORT_SUBMITTED)", 3, "REPORT_SUBMITTED", 2],
    ["after the report was validated (REPORT_VALIDATED)", 4, "REPORT_VALIDATED", 2],
  ])(
    "aborts %s, leaving the run RUNNING with no terminal call",
    async (_label, failIndex, attemptedEventType, expectedProviderCalls) => {
      const { repository, calls, emittedEvents } = createFakeRepository({
        appendEventError: failAtIndex(failIndex),
      });
      const service = createAgentRunService(repository);
      const provider = new FakeLlmProvider(toolThenReportScenario());
      const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
      const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

      const result = await service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        createProvider: () => provider,
        toolRegistry: toolRegistryWithServiceStatus(),
      });

      if (result.persistence !== "unavailable") throw new Error("expected an unavailable result");
      expect(result.stage).toBe("event-emission");
      if (result.stage !== "event-emission") throw new Error("unreachable");

      // The exact event that could not be persisted, and NO fabricated sequence.
      expect(result.attemptedEventType).toBe(attemptedEventType);
      expect(result).not.toHaveProperty("sequence");
      expect(result.error).toBe(LEDGER_DOWN);
      expect(result.runId).toBeTruthy();

      // The run is left RUNNING: terminal finalization was never called.
      expect(calls.finalizeCompleted).toBe(0);
      expect(calls.finalizeFailed).toBe(0);

      // Execution stopped at the failure point — no further provider turn.
      expect(runAgentTurnSpy).toHaveBeenCalledTimes(expectedProviderCalls);
      // The failing append is never recorded, so the ledger holds only what
      // genuinely committed before it.
      expect(emittedEvents).toHaveLength(failIndex);

      // No tool re-execution: the tool ran at most once, and not at all if the
      // abort happened before it.
      expect(executeSpy.mock.calls.length).toBeLessThanOrEqual(1);
      executeSpy.mockRestore();
    },
  );

  /**
   * A LIVE input set whose collector actually COUNTS, so "usage observed so
   * far" is a measurement rather than a constant. The provider wrapper below
   * records on each completed turn, mirroring how the real Claude adapter
   * feeds the service-owned accumulator.
   */
  function countingLiveInputs() {
    let observed = 0;
    const collector = {
      record: () => {
        observed += 1;
      },
      snapshot: (): RunProviderUsageSummary => ({
        providerCallsObserved: observed,
        inputTokens: observed * 100,
        outputTokens: observed * 50,
        cacheReadInputTokens: 0,
        cacheCreation5mInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        estimatedCostNanoUsd: BigInt(observed) * 1_000_000n,
        pricingStatus: "CURRENT" as const,
        possibleUnobservedCost: false,
      }),
    };
    return {
      ...liveSafeguardInputs(),
      usageHooks: { createCollector: () => collector },
    };
  }

  function recordingProvider(inner: LlmProvider, collector?: { record: () => void }): LlmProvider {
    return {
      runAgentTurn: async (input) => {
        const result = await inner.runAgentTurn(input);
        collector?.record();
        return result;
      },
    };
  }

  it("carries the usage observed so far and preserves the reservation for reconciliation", async () => {
    const { repository } = createFakeRepository({
      // Fail the LAST emitted event, so both provider turns have completed and
      // the collector has observed everything they spent.
      appendEventError: (payload) => (payload.type === "REPORT_VALIDATED" ? LEDGER_DOWN : undefined),
    });
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: (_job, collector) =>
        recordingProvider(new FakeLlmProvider(toolThenReportScenario()), collector),
      toolRegistry: toolRegistryWithServiceStatus(),
      ...countingLiveInputs(),
    });

    if (result.persistence !== "unavailable" || result.stage !== "event-emission") {
      throw new Error("expected an event-emission result");
    }
    // The service-owned collector is the source — the orchestrator never holds
    // usage and never returns it. Both turns completed before the failed
    // append, so both are counted.
    expect(result.usageSummary?.providerCallsObserved).toBe(2);
    // The reservation survives so the controller's cleanup still reconciles a
    // run that spent real tokens; an unreconciled reservation latches the day.
    expect(result.reservation).not.toBeNull();
  });

  it("reports zero observed provider calls when the ledger fails before the first turn", async () => {
    const { repository } = createFakeRepository({
      appendEventError: (payload) => (payload.type === "AGENT_STARTED" ? LEDGER_DOWN : undefined),
    });
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: (_job, collector) =>
        recordingProvider(new FakeLlmProvider(toolThenReportScenario()), collector),
      toolRegistry: toolRegistryWithServiceStatus(),
      ...countingLiveInputs(),
    });

    if (result.persistence !== "unavailable" || result.stage !== "event-emission") {
      throw new Error("expected an event-emission result");
    }
    expect(result.usageSummary?.providerCallsObserved).toBe(0);
    // Still reconcilable: a reserved-but-unspent slot must be released, or the
    // whole UTC day stays latched closed.
    expect(result.reservation).not.toBeNull();
  });

  // Codex Phase B review, finding M2: contractErrorCode must be populated
  // ONLY when the cause chain contains a GENUINE InvestigationEventContractError
  // — never an arbitrary object or string that merely occupies a `.code`
  // property. Each case below runs the same emission-failure path and
  // inspects the resulting diagnostic.
  describe("onEventEmissionFailure diagnostic narrowing (finding M2)", () => {
    async function diagnosticFor(cause: unknown) {
      const streamInvalid = new PersistenceError(
        "PERSISTENCE_EVENT_STREAM_INVALID",
        "would produce an invalid stream",
        { cause },
      );
      const { repository } = createFakeRepository({
        appendEventError: (payload) => (payload.type === "REPORT_SUBMITTED" ? streamInvalid : undefined),
      });
      const service = createAgentRunService(repository);
      const onEventEmissionFailure = vi.fn();

      await service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        createProvider: () => reportSubmittingProvider(),
        toolRegistry: toolRegistryWithServiceStatus(),
        onEventEmissionFailure,
      });

      expect(onEventEmissionFailure).toHaveBeenCalledTimes(1);
      return onEventEmissionFailure.mock.calls[0]?.[0];
    }

    it("includes the closed code when the cause chain contains a genuine InvestigationEventContractError", async () => {
      const realContractError = new InvestigationEventContractError(
        "PHASE_ORDER_VIOLATION",
        "TOOL_REQUESTED at sequence 3 requires AGENT_STARTED to be active.",
      );
      const diagnostic = await diagnosticFor(realContractError);

      expect(diagnostic).toEqual({
        runId: expect.any(String),
        attemptedEventType: "REPORT_SUBMITTED",
        persistenceErrorCode: "PERSISTENCE_EVENT_STREAM_INVALID",
        contractErrorCode: "PHASE_ORDER_VIOLATION",
      });
      // No free-form message, no cause, no payload — nothing that could carry
      // prompt text, report content, tool IO, or a secret.
      expect(Object.keys(diagnostic).sort()).toEqual([
        "attemptedEventType",
        "contractErrorCode",
        "persistenceErrorCode",
        "runId",
      ]);
    });

    it("includes the closed code through a deeper nesting, via the standard Error.cause chain", async () => {
      const realContractError = new InvestigationEventContractError(
        "TOOL_LIMIT_EXCEEDED",
        "a second TOOL_REQUESTED is not permitted",
      );
      // A wrapping PersistenceError is exactly what packages/database actually
      // produces (assertCanonicalStreamValid wraps the reducer's throw), so
      // this is the realistic shape, not a contrived one.
      const wrapped = new PersistenceError("PERSISTENCE_EVENT_STREAM_INVALID", "invalid stream", {
        cause: realContractError,
      });
      const diagnostic = await diagnosticFor(wrapped);

      expect(diagnostic.contractErrorCode).toBe("TOOL_LIMIT_EXCEEDED");
    });

    it("omits contractErrorCode for a plain object whose .code merely LOOKS like a contract code", async () => {
      const diagnostic = await diagnosticFor({ code: "PHASE_ORDER_VIOLATION" });

      expect(diagnostic).not.toHaveProperty("contractErrorCode");
      expect(Object.keys(diagnostic).sort()).toEqual([
        "attemptedEventType",
        "persistenceErrorCode",
        "runId",
      ]);
    });

    it("omits contractErrorCode for an unrelated Error carrying an arbitrary .code", async () => {
      const driverError = new Error("duplicate key value violates unique constraint") as Error & {
        code: string;
      };
      driverError.code = "23505"; // a real raw PostgreSQL code, not a contract code
      const diagnostic = await diagnosticFor(driverError);

      expect(diagnostic).not.toHaveProperty("contractErrorCode");
    });

    it("omits contractErrorCode when the cause is a driver code that happens to match a real contract code string", async () => {
      // The adversarial case: an unrelated failure whose .code string is
      // BYTE-IDENTICAL to a real InvestigationEventContractErrorCode member,
      // without being an actual InvestigationEventContractError instance.
      const diagnostic = await diagnosticFor({ code: "TOOL_LIMIT_EXCEEDED", message: "unrelated" });

      expect(diagnostic).not.toHaveProperty("contractErrorCode");
    });

    it("omits contractErrorCode entirely when persistenceErrorCode is not PERSISTENCE_EVENT_STREAM_INVALID", async () => {
      const unavailable = new PersistenceError("PERSISTENCE_UNAVAILABLE", "db down", {
        cause: new InvestigationEventContractError("PHASE_ORDER_VIOLATION", "would-be reducer failure"),
      });
      const { repository } = createFakeRepository({
        appendEventError: (payload) => (payload.type === "REPORT_SUBMITTED" ? unavailable : undefined),
      });
      const service = createAgentRunService(repository);
      const onEventEmissionFailure = vi.fn();

      await service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        createProvider: () => reportSubmittingProvider(),
        toolRegistry: toolRegistryWithServiceStatus(),
        onEventEmissionFailure,
      });

      const diagnostic = onEventEmissionFailure.mock.calls[0]?.[0];
      expect(diagnostic.persistenceErrorCode).toBe("PERSISTENCE_UNAVAILABLE");
      expect(diagnostic).not.toHaveProperty("contractErrorCode");
    });
  });

  it("a throwing onEventEmissionFailure hook cannot change the returned result", async () => {
    const { repository } = createFakeRepository({ appendEventError: failAtIndex(0) });
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "FAKE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
      onEventEmissionFailure: () => {
        throw new Error("logger exploded");
      },
    });

    expect(result).toMatchObject({ persistence: "unavailable", stage: "event-emission" });
  });

  it("is NOT reported as AGENT_EXECUTION_CRASHED", async () => {
    const { repository } = createFakeRepository({ appendEventError: failAtIndex(0) });
    const service = createAgentRunService(repository);

    // A ledger failure is a persistence result, not a crash — it must never be
    // thrown as AgentRunServiceError.
    await expect(
      service.executeAndPersist({
        jobId: JOB_ID,
        providerMode: "FAKE",
        createProvider: () => reportSubmittingProvider(),
        toolRegistry: toolRegistryWithServiceStatus(),
      }),
    ).resolves.toMatchObject({ persistence: "unavailable", stage: "event-emission" });
  });

  it("emits nothing and executes nothing on an idempotent LIVE replay", async () => {
    const live = liveSafeguardInputs();
    const { repository, calls } = createFakeRepository();
    const service = createAgentRunService(repository);

    const first = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => reportSubmittingProvider(),
      toolRegistry: toolRegistryWithServiceStatus(),
      ...live,
    });
    expect(first.persistence).toBe("persisted");
    const appendsAfterFirst = calls.appendInvestigationEvent;

    const replay = await service.executeAndPersist({
      jobId: JOB_ID,
      providerMode: "LIVE",
      createProvider: () => {
        throw new Error("a replay must never construct a provider");
      },
      toolRegistry: toolRegistryWithServiceStatus(),
      ...live,
    });

    if (replay.persistence !== "persisted") throw new Error("expected a persisted replay");
    expect(replay.execution).toBe("replayed");
    // No new run means no new canonical events.
    expect(calls.appendInvestigationEvent).toBe(appendsAfterFirst);
  });

  it("retryFinalization preserves the original failedStage and usage, and appends nothing", async () => {
    const { repository, calls, finalizeFailedStages, finalizeUsage } = createFakeRepository();
    const service = createAgentRunService(repository);
    const appendsBefore = calls.appendInvestigationEvent;

    const usageSummary: RunProviderUsageSummary = {
      providerCallsObserved: 2,
      inputTokens: 1_200,
      outputTokens: 400,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      estimatedCostNanoUsd: 17_956_000n,
      pricingStatus: "CURRENT",
      possibleUnobservedCost: false,
    };

    await service.retryFinalization({
      runId: "run-1",
      agentResult: {
        status: "failed",
        code: "TOOL_NOT_FOUND",
        message: "unknown tool",
        trace: [],
        failedStage: "DIAGNOSTIC_EXECUTION",
      },
      usageSummary,
    });

    expect(calls.startRun).toBe(0); // no new attempt
    expect(calls.appendInvestigationEvent).toBe(appendsBefore); // no new events
    expect(finalizeFailedStages).toEqual(["DIAGNOSTIC_EXECUTION"]);
    expect(finalizeUsage[0]).toMatchObject({ providerCallsObserved: 2, estimatedCostNanoUsd: 17_956_000n });
  });
});
