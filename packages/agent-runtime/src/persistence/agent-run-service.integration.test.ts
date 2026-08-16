import { createPrismaClient, type AgentJobRecord, type PrismaClientHandle } from "@opspilot/database";
import type {
  InvestigationEventPayload,
  InvestigationEventRecord,
  ResolutionReport,
} from "@opspilot/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeLlmProvider, type FakeAgentScenario, type FakeProviderTurn } from "../providers/fake-llm-provider";
import { getServiceStatusTool, InMemoryToolRegistry } from "../tools";
import { createAgentRunService, createPrismaAgentRunRepository } from "./agent-run-service";

// Issue #57 Checkpoint C — the real-composition proof. Unlike the unit suite
// (which exercises createAgentRunService against an in-memory fake
// repository), this file wires the ACTUAL pieces together against the local
// test PostgreSQL: real createPrismaAgentRunRepository -> real
// createAgentRunService -> real runAgentOrchestrator -> real
// appendInvestigationEvent (reducer-validated) -> real database rows ->
// terminal finalization -> readback through getInvestigationState/getAgentRun.
//
// It shares the same physical test database as packages/database's and
// apps/api's integration suites, so it must only ever run through the root
// `test:integration:sequential` chain (never in parallel with them).

const UNAVAILABLE_MESSAGE =
  "PostgreSQL test database is unreachable. Run:\n" +
  "  pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:test\n" +
  "then re-run the integration tests.";

const TOOL_NAME = "get_service_status";

async function createTestPrismaClient(): Promise<PrismaClientHandle> {
  const handle = createPrismaClient();
  try {
    await handle.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw new Error(UNAVAILABLE_MESSAGE, { cause: error });
  }
  return handle;
}

async function truncateAllTables(handle: PrismaClientHandle): Promise<void> {
  await handle.prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events, agent_run_approvals RESTART IDENTITY CASCADE`;
}

// Every report the orchestrator accepts must ground each TOOL_EXECUTION
// evidence entry in a tool call that actually completed (findInvalidEvidence),
// so the multi-step reports cite exactly the calls the scenario completed.
function completedReport(callIds: readonly string[]): ResolutionReport {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "Multi-step diagnostic completed.",
    rootCause: "The bounded diagnostic loop ran to completion.",
    customerImpact: "Impact assessed via repeated diagnostics.",
    recommendedResolution: "Monitor the affected services.",
    confidence: 0.8,
    evidence: callIds.map((callId) => ({
      evidenceId: callId,
      sourceType: "TOOL_EXECUTION",
      finding: `Tool call ${callId} completed successfully.`,
    })),
    evidenceState: "SUFFICIENT",
    suggestedActions: [],
    recommendationDisposition: "ADVISORY",
  };
}

// Issue #58 Checkpoint B (§12): every diagnostic request must carry a
// rawAssessment consistent with the evidence available BEFORE that request —
// the first tool call in a scenario claims NO_EVIDENCE_YET with an empty
// supportedBy; each later call cites the tool calls already completed in the
// run. The orchestrator's V0 + A3 guards reject any fixture that claims
// otherwise.
const NO_EVIDENCE_YET_ASSESSMENT = {
  evidenceState: "INSUFFICIENT",
  continuationReason: "NO_EVIDENCE_YET",
  supportedBy: [],
} as const;

// assessment is the rawAssessment carried on the request. Callers that build a
// second/third turn pass a STATUS_UNRESOLVED assessment citing the earlier
// completed call(s).
function toolTurn(
  callId: string,
  serviceSlug: string,
  toolName: string = TOOL_NAME,
  assessment: unknown = NO_EVIDENCE_YET_ASSESSMENT,
): FakeProviderTurn {
  return {
    kind: "diagnostic_tool_requests",
    usage: { inputTokens: 1, outputTokens: 1 },
    requests: [{ toolCallId: callId, toolName, input: { serviceSlug }, rawAssessment: assessment }],
  };
}

// §12: the run-state-consistent assessment for a call made AFTER earlier
// calls have completed — STATUS_UNRESOLVED citing exactly those call ids.
function statusUnresolvedCiting(callIds: readonly string[]): unknown {
  return {
    evidenceState: "INSUFFICIENT",
    continuationReason: "STATUS_UNRESOLVED",
    supportedBy: callIds.map((evidenceId) => ({ evidenceId, sourceType: "TOOL_EXECUTION" })),
  };
}

function reportTurn(rawInput: ResolutionReport): FakeProviderTurn {
  return {
    kind: "report_submission",
    usage: { inputTokens: 1, outputTokens: 1 },
    rawInput,
  };
}

// Two diagnostic turns then a VOLUNTARY early report on the still-available
// investigation turn 2 — REPORT_GENERATION_STARTED must be absent.
function twoToolVoluntaryEarlyReportScenario(): FakeAgentScenario {
  return {
    id: "checkpoint-c-two-tool-voluntary",
    turns: [
      toolTurn("call-1", "auth-service"),
      toolTurn("call-2", "billing-service", TOOL_NAME, statusUnresolvedCiting(["call-1"])),
      reportTurn(completedReport(["call-1", "call-2"])),
    ],
  };
}

// Three diagnostic turns (the reviewed max bound) so turn 3 is the reserved
// FORCED finalization turn — REPORT_GENERATION_STARTED must be present.
function threeToolForcedFinalizationScenario(): FakeAgentScenario {
  return {
    id: "checkpoint-c-three-tool-forced",
    turns: [
      toolTurn("call-1", "auth-service"),
      toolTurn("call-2", "billing-service", TOOL_NAME, statusUnresolvedCiting(["call-1"])),
      toolTurn("call-3", "notification-service", TOOL_NAME, statusUnresolvedCiting(["call-1", "call-2"])),
      reportTurn(completedReport(["call-1", "call-2", "call-3"])),
    ],
  };
}

// First diagnostic succeeds, the second requests a tool the registry does not
// know — the canonical partial events must persist and the run must finalize
// FAILED with the truthful DIAGNOSTIC_EXECUTION stage.
function firstSucceedsThenUnknownToolScenario(): FakeAgentScenario {
  return {
    id: "checkpoint-c-first-succeeds-then-unknown",
    turns: [
      toolTurn("call-1", "auth-service"),
      toolTurn("call-2", "auth-service", "missing_tool", statusUnresolvedCiting(["call-1"])),
    ],
  };
}

// P1 final correction: the provider reuses the exact toolCallId of a prior
// request with an identical payload. Checkpoint A's exact-replay semantics
// would otherwise re-append the same (runId, eventType, toolCallId) row and
// execute the tool a second time while the ledger records only one pair, so
// the runtime must reject the repeat before any side effect.
function duplicateToolCallIdScenario(): FakeAgentScenario {
  return {
    id: "checkpoint-c-duplicate-tool-call-id",
    turns: [toolTurn("call-1", "auth-service"), toolTurn("call-1", "auth-service")],
  };
}

// `state.events` carries `InvestigationEventRecord["payload"]`, a wider union
// than the canonical-only `InvestigationEventPayload` (it also contains the
// legacy REPORT_GENERATED / RUN_FAILED variants), so these helpers are typed
// against the full record, not the canonical subset.
function payloadTypes(events: readonly InvestigationEventRecord[]): string[] {
  return events.map((event) => event.payload.type);
}

function toolCallIdOf(event: InvestigationEventRecord): string | undefined {
  const payload = event.payload;
  if (payload.type === "TOOL_REQUESTED" || payload.type === "TOOL_COMPLETED") {
    return payload.toolCallId;
  }
  return undefined;
}

describe("issue #57 Checkpoint C — real multi-step persistence/readback", () => {
  let handle: PrismaClientHandle;

  beforeAll(async () => {
    handle = await createTestPrismaClient();
  });

  afterEach(async () => {
    await truncateAllTables(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function runScenario(scenario: FakeAgentScenario): Promise<{ job: AgentJobRecord; runId: string }> {
    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);
    const job = await service.createAgentJob({
      ticketId: "TKT-57",
      summary: "Multi-step diagnostic integration run",
    });
    const result = await service.executeAndPersist({
      jobId: job.id,
      providerMode: "FAKE",
      modelIdentifier: null,
      createProvider: () => new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
    });
    expect(result.persistence).toBe("persisted");
    if (result.persistence !== "persisted") throw new Error("unreachable");
    return { job, runId: result.run.run.id };
  }

  it("persists a two-tool voluntary-early-report run through the real service and reads it back exactly", async () => {
    const { job, runId } = await runScenario(twoToolVoluntaryEarlyReportScenario());

    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);

    // Terminal run state.
    const run = await service.getAgentRun(runId);
    expect(run.run.status).toBe("COMPLETED");
    expect(run.outcome.type).toBe("COMPLETED");
    if (run.outcome.type !== "COMPLETED") throw new Error("unreachable");
    expect(run.outcome.report.category).toBe("SERVICE_DEGRADATION");

    // The full canonical stream, in sequence, with repeated TOOL_* rows intact.
    const state = await service.getInvestigationState(job.id);
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(payloadTypes(state.events)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);

    // Repeated TOOL_REQUESTED / TOOL_COMPLETED rows are NOT collapsed.
    const requested = state.events
      .filter((event) => event.payload.type === "TOOL_REQUESTED")
      .map(toolCallIdOf);
    const completed = state.events
      .filter((event) => event.payload.type === "TOOL_COMPLETED")
      .map(toolCallIdOf);
    expect(requested).toEqual(["call-1", "call-2"]);
    expect(completed).toEqual(["call-1", "call-2"]);

    // Voluntary early report: REPORT_GENERATION_STARTED is absent.
    expect(state.events.some((event) => event.payload.type === "REPORT_GENERATION_STARTED")).toBe(false);

    // The legacy trace projection carries the same repeated events, in order.
    const traceRequested = run.trace.filter((event) => event.type === "TOOL_REQUESTED");
    const traceCompleted = run.trace.filter((event) => event.type === "TOOL_COMPLETED");
    expect(traceRequested.map((event) => event.toolCallId)).toEqual(["call-1", "call-2"]);
    expect(traceCompleted.map((event) => event.toolCallId)).toEqual(["call-1", "call-2"]);

    // Issue #58 Checkpoint B (§9.4/§15): the PERSISTED TOOL_REQUESTED rows
    // carry the VALIDATED run-state-consistent assessments — no evidence yet
    // for the first request, grounded on the completed call-1 for the second.
    const requestedPayloads = state.events
      .filter((event) => event.payload.type === "TOOL_REQUESTED")
      .map((event) => event.payload);
    expect(requestedPayloads[0]).toMatchObject({
      toolCallId: "call-1",
      assessment: NO_EVIDENCE_YET_ASSESSMENT,
    });
    expect(requestedPayloads[1]).toMatchObject({
      toolCallId: "call-2",
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "STATUS_UNRESOLVED",
        supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
      },
    });
  });

  it("persists the three-tool forced-finalization run (max bound) with REPORT_GENERATION_STARTED present", async () => {
    const { job, runId } = await runScenario(threeToolForcedFinalizationScenario());

    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);

    const state = await service.getInvestigationState(job.id);
    expect(state.run?.status).toBe("COMPLETED");
    expect(state.outcome?.type).toBe("COMPLETED");
    // 1 RUN_CREATED + 1 AGENT_STARTED + 6 tool events + RGS + SUBMITTED + VALIDATED + RUN_COMPLETED.
    expect(state.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(payloadTypes(state.events)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
      "RUN_COMPLETED",
    ]);
    expect(state.events.filter((event) => event.payload.type === "TOOL_REQUESTED")).toHaveLength(3);
    expect(state.events.filter((event) => event.payload.type === "TOOL_COMPLETED")).toHaveLength(3);
    expect(state.events.some((event) => event.payload.type === "REPORT_GENERATION_STARTED")).toBe(true);

    // The reserved finalization turn is what emitted REPORT_GENERATION_STARTED
    // (sequence 9, immediately before the report the provider submitted on the
    // forced finalization turn).
    expect(state.events[8]?.payload.type).toBe("REPORT_GENERATION_STARTED");

    // Readback is stable after completion: a second read is byte-identical.
    const reread = await service.getInvestigationState(job.id);
    expect(reread).toEqual(state);
  });

  it("first diagnostic succeeds, later unknown tool fails: partial canonical events persist and readback remains valid", async () => {
    const { job, runId } = await runScenario(firstSucceedsThenUnknownToolScenario());

    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);

    const run = await service.getAgentRun(runId);
    expect(run.run.status).toBe("FAILED");
    expect(run.outcome.type).toBe("FAILED");
    if (run.outcome.type !== "FAILED") throw new Error("unreachable");
    expect(run.outcome.code).toBe("TOOL_NOT_FOUND");

    const state = await service.getInvestigationState(job.id);
    expect(state.run?.status).toBe("FAILED");
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(payloadTypes(state.events)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_FAILED",
      "RUN_FAILED",
    ]);
    // The failed call is a TOOL_FAILED row (not a collapsed/duplicate).
    expect(state.events[5]).toMatchObject({
      payload: { type: "TOOL_FAILED", toolCallId: "call-2", toolName: "missing_tool", failureCode: "TOOL_NOT_FOUND" },
    });
    // No report was ever submitted, so no REPORT_SUBMITTED/REPORT_VALIDATED.
    expect(state.events.some((event) => event.payload.type === "REPORT_SUBMITTED")).toBe(false);

    // Readback remains valid after the terminal outcome.
    const reread = await service.getInvestigationState(job.id);
    expect(reread).toEqual(state);
  });

  it("rejects a repeated provider toolCallId through the real persisted composition: FAILED/PROVIDER_PROTOCOL_INVALID/DIAGNOSTIC_EXECUTION, one tool execution, no second TOOL_REQUESTED row", async () => {
    // P1 final-correction regression. turn 0 requests call-1 and completes it;
    // turn 1 re-requests the SAME identity with an identical payload. The
    // runtime must reject before emitting TOOL_REQUESTED or executing, so the
    // canonical stream holds exactly one request/completion pair and the run
    // finalizes FAILED at the truthful DIAGNOSTIC_EXECUTION stage.
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const { job, runId } = await runScenario(duplicateToolCallIdScenario());
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);

    const run = await service.getAgentRun(runId);
    expect(run.run.status).toBe("FAILED");
    expect(run.outcome.type).toBe("FAILED");
    if (run.outcome.type !== "FAILED") throw new Error("unreachable");
    expect(run.outcome.code).toBe("PROVIDER_PROTOCOL_INVALID");

    // The canonical stream is RUN_CREATED, AGENT_STARTED, exactly one
    // TOOL_REQUESTED(A)/TOOL_COMPLETED(A), then RUN_FAILED — with NO second
    // TOOL_REQUESTED/TOOL_COMPLETED row for the rejected duplicate.
    const state = await service.getInvestigationState(job.id);
    expect(state.run?.status).toBe("FAILED");
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(payloadTypes(state.events)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "RUN_FAILED",
    ]);
    expect(state.events.filter((event) => event.payload.type === "TOOL_REQUESTED")).toHaveLength(1);
    expect(state.events.filter((event) => event.payload.type === "TOOL_COMPLETED")).toHaveLength(1);
    const requested = state.events.find((event) => event.payload.type === "TOOL_REQUESTED");
    expect(requested ? toolCallIdOf(requested) : undefined).toBe("call-1");
    const completed = state.events.find((event) => event.payload.type === "TOOL_COMPLETED");
    expect(completed ? toolCallIdOf(completed) : undefined).toBe("call-1");

    // RUN_FAILED carries the failure code and the truthful active stage.
    const runFailed = state.events.find((event) => event.payload.type === "RUN_FAILED");
    expect(runFailed?.payload).toMatchObject({
      type: "RUN_FAILED",
      failureCode: "PROVIDER_PROTOCOL_INVALID",
      failedStage: "DIAGNOSTIC_EXECUTION",
    });

    // Re-read proves the canonical sequence remains valid after the terminal
    // outcome (a second read is byte-identical).
    const reread = await service.getInvestigationState(job.id);
    expect(reread).toEqual(state);
  });

  it("exact-replays an assessment-carrying TOOL_REQUESTED through the real repository: same sequence, no new row, next event contiguous", async () => {
    // Issue #58 Checkpoint B (§15): the JSONB-payload-idempotent exact-replay
    // guarantee (Checkpoint A) must hold for the NEW write payload too — an
    // assessment-carrying TOOL_REQUESTED re-appended identically returns the
    // ORIGINAL record (same sequence, no insert), and the next distinct event
    // still lands on the contiguous sequence number.
    const repository = createPrismaAgentRunRepository(handle.prisma);
    const service = createAgentRunService(repository);
    const job = await service.createAgentJob({
      ticketId: "TKT-58",
      summary: "Checkpoint B exact-replay persistence proof",
    });
    const started = await repository.startRun(job.id, "FAKE", null);
    const runId = started.run.id;

    await repository.appendInvestigationEvent(runId, { type: "AGENT_STARTED" });

    const requestPayload: Extract<InvestigationEventPayload, { type: "TOOL_REQUESTED" }> = {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
      // Built inline (mutable) so the array is assignable to the write event's
      // EvidenceLocator[] slot — the `as const` fixture is too deeply readonly.
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "NO_EVIDENCE_YET",
        supportedBy: [],
      },
    };
    const first = await repository.appendInvestigationEvent(runId, requestPayload);
    const replayed = await repository.appendInvestigationEvent(runId, requestPayload);

    // The replay returned the ORIGINAL record — same sequence, no new row.
    expect(replayed.sequence).toBe(first.sequence);
    expect(replayed.recordedAt).toBe(first.recordedAt);
    expect(replayed.payload).toEqual(first.payload);

    // The next distinct event is contiguous — the replay consumed no sequence.
    await repository.appendInvestigationEvent(runId, {
      type: "TOOL_COMPLETED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });

    const state = await service.getInvestigationState(job.id);
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(payloadTypes(state.events)).toEqual([
      "RUN_CREATED",
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
    ]);
    // The single persisted TOOL_REQUESTED row carries the validated assessment.
    const requested = state.events.find((event) => event.payload.type === "TOOL_REQUESTED");
    expect(requested?.payload).toMatchObject(requestPayload);
  });
});
