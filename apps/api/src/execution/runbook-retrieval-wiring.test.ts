import {
  createAgentRunService,
  FakeLlmProvider,
  getServiceStatusTool,
  InMemoryKeywordRunbookRetriever,
  InMemoryToolRegistry,
  loadDefaultRunbookCorpus,
  type AgentRunRepositoryInterface,
} from "@opspilot/agent-runtime";
import type { InvestigationEventPayload } from "@opspilot/contracts";
import type { AgentJobRecord, AgentRunRecord, PersistedAgentRun } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { createDeterministicScenario } from "./deterministic-scenario";
import { buildRetrievalInput } from "./retrieval-input";

// Issue #72 acceptance criterion #4: a new test proving at least one
// deployed-path (FAKE-provider) scenario, using a ticket summary matching a
// seeded runbook, produces a COMPLETED run with RAG_CHUNK evidence in
// report.evidence and a RETRIEVAL_COMPLETED trace event.
//
// This wires the REAL pieces AgentRunsController and AgentRuntimeModule
// compose in production — createDeterministicScenario, buildRetrievalInput,
// InMemoryKeywordRunbookRetriever, and the real on-disk runbook corpus via
// loadDefaultRunbookCorpus() — against an in-memory fake
// AgentRunRepositoryInterface (the same pattern agent-run-service.test.ts
// uses), so it proves the wiring end-to-end without a live Postgres
// dependency or NestJS DI container. It is a plain `*.test.ts` file
// (deliberately not `*.integration.test.ts`) because nothing here needs the
// real database — see vitest.config.ts's exclusion of
// `**/*.integration.test.ts` from the default run.

function buildFakeRepository(job: AgentJobRecord): {
  readonly repository: AgentRunRepositoryInterface;
  readonly emittedEvents: InvestigationEventPayload[];
} {
  let nextRunId = 1;
  const runs = new Map<string, { report: unknown; status: "COMPLETED" | "FAILED" }>();
  const emittedEvents: InvestigationEventPayload[] = [];

  const repository: AgentRunRepositoryInterface = {
    createJob: async () => job,
    startRun: async (jobId, providerMode) => {
      const id = `run-${nextRunId++}`;
      return {
        job: { ...job, id: jobId },
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
    startLiveRunWithAttemptLimit: async () => {
      throw new Error("not exercised by this FAKE-only test");
    },
    replayLiveRun: async () => null,
    appendInvestigationEvent: async (runId, payload) => {
      emittedEvents.push(payload);
      return {
        runId,
        sequence: emittedEvents.length,
        recordedAt: "2026-01-01T00:00:00.000Z",
        payload,
      };
    },
    finalizeCompleted: async (runId, report): Promise<AgentRunRecord> => {
      runs.set(runId, { report, status: "COMPLETED" });
      return {
        id: runId,
        jobId: job.id,
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
    finalizeFailed: async (runId): Promise<AgentRunRecord> => {
      runs.set(runId, { report: null, status: "FAILED" });
      return {
        id: runId,
        jobId: job.id,
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
    reconcileLiveRunBudget: async () => undefined,
    getAgentRun: async (runId): Promise<PersistedAgentRun> => {
      const stored = runs.get(runId);
      if (!stored) throw new Error(`no run recorded for ${runId}`);
      return {
        job,
        run: {
          id: runId,
          jobId: job.id,
          attemptNumber: 1,
          status: stored.status,
          providerMode: "FAKE",
          modelIdentifier: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          estimatedCostNanoUsd: null,
          possibleUnobservedCost: false,
        },
        // The legacy in-memory `trace` channel this service also returns
        // directly from `executeAndPersist` (see below) is the assertion
        // surface this test actually uses — `getAgentRun`'s own trace
        // reconstruction from canonical events is a separate, real-repository
        // concern this in-memory fake does not need to reproduce.
        trace: [],
        outcome:
          stored.status === "COMPLETED"
            ? { type: "COMPLETED", report: stored.report as never }
            : { type: "FAILED", code: "PROVIDER_PROTOCOL_INVALID", message: "unused" },
      };
    },
    getAgentJob: async (jobId) => ({ job: { ...job, id: jobId }, runs: [] }),
    getInvestigationState: async (jobId) => ({
      job: { ...job, id: jobId },
      run: null,
      trace: [],
      outcome: null,
      events: [],
    }),
  };

  return { repository, emittedEvents };
}

describe("issue #72: runbook retrieval reaches the deployed FAKE-provider path end-to-end", () => {
  it("a ticket summary matching a seeded runbook produces a COMPLETED run with RAG_CHUNK evidence and a RETRIEVAL_COMPLETED trace event", async () => {
    // Matches runbooks/billing-invoice-formatting.md's title tokens
    // ("Billing Invoice PDF Formatting") in the real on-disk corpus.
    const job: AgentJobRecord = {
      id: "11111111-1111-1111-1111-111111111111",
      ticketContext: {
        ticketId: "TICKET-RAG-WIRING-1",
        summary: "Invoice PDF formatting issue for billing customers",
      },
      externalTicketId: "TICKET-RAG-WIRING-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const corpusLoad = await loadDefaultRunbookCorpus();
    const retriever = new InMemoryKeywordRunbookRetriever(corpusLoad.chunks);
    const { repository, emittedEvents } = buildFakeRepository(job);
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: job.id,
      providerMode: "FAKE",
      modelIdentifier: null,
      createProvider: (resolvedJob) => new FakeLlmProvider(createDeterministicScenario(resolvedJob)),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      retriever,
      retrievalInputFactory: buildRetrievalInput,
    });

    if (result.persistence !== "persisted") {
      throw new Error(`expected a persisted result, got ${JSON.stringify(result)}`);
    }
    expect(result.run.outcome.type).toBe("COMPLETED");
    if (result.run.outcome.type !== "COMPLETED") throw new Error("unreachable");

    const ragEntry = result.run.outcome.report.evidence.find(
      (entry) => entry.sourceType === "RAG_CHUNK",
    );
    expect(ragEntry?.evidenceId).toBe("runbook-billing-invoice-formatting-001");

    const retrievalEvent = emittedEvents.find((event) => event.type === "RETRIEVAL_COMPLETED");
    if (retrievalEvent?.type !== "RETRIEVAL_COMPLETED") {
      throw new Error(`expected a RETRIEVAL_COMPLETED event, got ${JSON.stringify(emittedEvents)}`);
    }
    expect(retrievalEvent.chunks.length).toBeGreaterThan(0);
    expect(retrievalEvent.chunks[0]?.chunkId).toBe("runbook-billing-invoice-formatting-001");
  });

  it("a ticket summary matching no seeded runbook completes with tool-only evidence — the honest no-match branch", async () => {
    const job: AgentJobRecord = {
      id: "22222222-2222-2222-2222-222222222222",
      ticketContext: {
        ticketId: "TICKET-RAG-WIRING-2",
        summary: "spacecraft thermal calibration firmware anomaly",
      },
      externalTicketId: "TICKET-RAG-WIRING-2",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const corpusLoad = await loadDefaultRunbookCorpus();
    const retriever = new InMemoryKeywordRunbookRetriever(corpusLoad.chunks);
    const { repository, emittedEvents } = buildFakeRepository(job);
    const service = createAgentRunService(repository);

    const result = await service.executeAndPersist({
      jobId: job.id,
      providerMode: "FAKE",
      modelIdentifier: null,
      createProvider: (resolvedJob) => new FakeLlmProvider(createDeterministicScenario(resolvedJob)),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      retriever,
      retrievalInputFactory: buildRetrievalInput,
    });

    if (result.persistence !== "persisted") {
      throw new Error(`expected a persisted result, got ${JSON.stringify(result)}`);
    }
    expect(result.run.outcome.type).toBe("COMPLETED");
    if (result.run.outcome.type !== "COMPLETED") throw new Error("unreachable");

    expect(result.run.outcome.report.evidence).toHaveLength(1);
    expect(result.run.outcome.report.evidence[0]?.sourceType).toBe("TOOL_EXECUTION");
    expect(emittedEvents).toContainEqual({ type: "RETRIEVAL_COMPLETED", chunks: [] });
  });
});
