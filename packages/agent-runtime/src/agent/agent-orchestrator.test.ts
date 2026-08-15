import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  FakeLlmProvider,
  type FakeAgentScenario,
  type FakeProviderTurn,
  type FakeProviderTurnResolver,
} from "../providers/fake-llm-provider";
import { LlmProviderError } from "../providers/llm-provider";
import type {
  AgentConversationMessage,
  DiagnosticToolResultEntry,
  LlmProvider,
} from "../providers/llm-provider";
import {
  RetrieverError,
  type RetrievedRunbookChunk,
  type RunbookRetriever,
} from "../rag/runbook-retriever";
import {
  InMemoryToolRegistry,
  getServiceStatusTool,
  type DiagnosticToolDefinition,
} from "../tools";
import {
  InvestigationEventPayloadSchema,
  type InvestigationEventPayload,
} from "@opspilot/contracts";

import { runAgentOrchestrator } from "./agent-orchestrator";

const sampleChunk: RetrievedRunbookChunk = {
  chunkId: "runbook-notification-degradation-001",
  runbookId: "notification-service-runbook",
  title: "Notification Service Degradation",
  content: "The notification-service reports DEGRADED when downstream delivery is slow.",
  score: 4,
  rank: 1,
};

class FakeRunbookRetriever implements RunbookRetriever {
  constructor(private readonly chunks: readonly RetrievedRunbookChunk[]) {}
  async retrieve(): Promise<readonly RetrievedRunbookChunk[]> {
    return this.chunks;
  }
}

const usage = { inputTokens: 100, outputTokens: 20 };

// Issue #58 Checkpoint B: the assessment a first diagnostic request must carry
// before any evidence exists — INSUFFICIENT / NO_EVIDENCE_YET with an empty
// supportedBy, exactly the run-state-consistent claim the orchestrator's V0 +
// A3 guards require (agent-orchestrator.ts §9.1/§9.3). Every fixture below
// migrates to carry a rawAssessment consistent with the evidence available
// BEFORE the request: the first call in a scenario uses this, later calls use
// statusUnresolvedCiting(...) below.
const NO_EVIDENCE_YET_ASSESSMENT = {
  evidenceState: "INSUFFICIENT",
  continuationReason: "NO_EVIDENCE_YET",
  supportedBy: [],
} as const;

const ticketContext: AgentConversationMessage = {
  role: "ticket_context",
  ticketId: "ticket-1",
  summary: "Customers report delayed notifications from notification-service.",
};

const validReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause: "notification-service is degraded.",
  customerImpact: "Some customers are receiving delayed notifications.",
  recommendedResolution: "Monitor notification-service until it recovers.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
    },
  ],
  suggestedActions: [],
  evidenceState: "SUFFICIENT",
};

const validReportWithRagEvidence = {
  ...validReport,
  evidence: [
    {
      evidenceId: "rag-chunk-1",
      sourceType: "RAG_CHUNK",
      finding: "Knowledge base article KB-42 describes this failure mode.",
    },
  ],
};

const invalidReport = {
  category: "SERVICE_DEGRADATION",
  // missing summary, rootCause, customerImpact, recommendedResolution, confidence, evidence
};

function buildToolRequestScenario(
  id: string,
  serviceSlug: string,
  toolName = "get_service_status",
): FakeAgentScenario {
  return {
    id,
    turns: [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          { toolCallId: "call-1", toolName, input: { serviceSlug }, rawAssessment: NO_EVIDENCE_YET_ASSESSMENT },
        ],
      },
      { kind: "report_submission", usage, rawInput: validReport },
    ],
  };
}

// Issue #58 Checkpoint B (§12): the assessment for the i-th diagnostic request
// (0-based) in a scripted sequence. The first request carries NO_EVIDENCE_YET
// with an empty supportedBy; each later request must cite exactly the tool
// calls already completed in the run (call-1 .. call-i), which is the
// run-state-consistent claim the orchestrator's A2/A3 guards require.
function assessmentForTurnIndex(i: number): unknown {
  if (i === 0) return NO_EVIDENCE_YET_ASSESSMENT;
  return {
    evidenceState: "INSUFFICIENT",
    continuationReason: "STATUS_UNRESOLVED",
    supportedBy: Array.from({ length: i }, (_, j) => ({
      evidenceId: `call-${j + 1}`,
      sourceType: "TOOL_EXECUTION",
    })),
  };
}

// Issue #57 Checkpoint B — the bounded loop is multi-step, so scenarios must
// script several sequential diagnostic turns (one tool request per turn, as
// the runtime and contract require) before whatever final turn a test needs.
// The fake provider indexes turns by turnIndex, so array position IS the
// provider turn. toolCallId is derived from position (call-1, call-2, ...) so
// every request carries a fresh id, as the contract requires.
function buildMultiToolTurns(toolCount: number, toolName = "get_service_status"): FakeProviderTurn[] {
  return Array.from({ length: toolCount }, (_, i) => ({
    kind: "diagnostic_tool_requests",
    usage,
    requests: [
      {
        toolCallId: `call-${i + 1}`,
        toolName,
        input: { serviceSlug: "notification-service" },
        rawAssessment: assessmentForTurnIndex(i),
      },
    ],
  }));
}

function buildNToolsThenReportScenario(toolCount: number, report: unknown = validReport): FakeAgentScenario {
  return {
    id: `${toolCount}-tools-then-report`,
    turns: [
      ...buildMultiToolTurns(toolCount),
      { kind: "report_submission", usage, rawInput: report },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAgentOrchestrator", () => {
  it("completes with a validated report on a direct voluntary report submission (one provider turn)", async () => {
    const provider = new FakeLlmProvider({
      id: "direct-report",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: validReportWithRagEvidence,
        },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.category).toBe("SERVICE_DEGRADATION");
    expect(result.trace).toEqual([{ type: "REPORT_GENERATED" }]);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("executes get_service_status exactly once", async () => {
    const scenario = buildToolRequestScenario("tool-then-report", "notification-service");
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ serviceSlug: "notification-service" });
  });

  it("includes ticket context, the tool request, and the validated tool result in the second provider call", async () => {
    const scenario = buildToolRequestScenario("tool-then-report", "notification-service");
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);

    const secondCallInput = runAgentTurnSpy.mock.calls[1]?.[0];
    expect(secondCallInput?.conversation).toEqual([
      ticketContext,
      {
        role: "diagnostic_tool_request",
        toolCallId: "call-1",
        toolName: "get_service_status",
        input: { serviceSlug: "notification-service" },
        // Checkpoint B (§3.3/§9.4): the VALIDATED assessment rides the
        // conversation append, never the raw form.
        assessment: NO_EVIDENCE_YET_ASSESSMENT,
      },
      {
        role: "diagnostic_tool_result",
        toolCallId: "call-1",
        toolName: "get_service_status",
        output: { serviceSlug: "notification-service", status: "DEGRADED" },
      },
    ]);
  });

  it("records trace events in order TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_GENERATED", async () => {
    const scenario = buildToolRequestScenario("tool-then-report", "notification-service");
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("returns UNKNOWN status for a serviceSlug outside the seeded table, instead of defaulting to OPERATIONAL", async () => {
    const scenario = buildToolRequestScenario("unknown-service", "mystery-service");
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    const secondCallInput = runAgentTurnSpy.mock.calls[1]?.[0];
    const toolResultEntry = secondCallInput?.conversation[2];
    expect(toolResultEntry).toEqual({
      role: "diagnostic_tool_result",
      toolCallId: "call-1",
      toolName: "get_service_status",
      output: { serviceSlug: "mystery-service", status: "UNKNOWN" },
    });
  });

  it("fails with TOOL_NOT_FOUND without executing anything, when the tool is unregistered", async () => {
    const scenario = buildToolRequestScenario("unknown-tool", "notification-service", "delete_everything");
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_NOT_FOUND");
    expect(result.trace).toEqual([]);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("fails with TOOL_INPUT_INVALID without executing anything, when the tool input fails schema validation", async () => {
    const scenario: FakeAgentScenario = {
      id: "bad-tool-input",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: 12345 },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: validReport },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_INPUT_INVALID");
    expect(result.trace).toEqual([]);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("fails with TOOL_OUTPUT_INVALID before the result enters the conversation, when the tool returns a malformed result", async () => {
    const brokenTool: DiagnosticToolDefinition = {
      name: "broken_tool",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ mustBePresent: z.string() }).strict(),
      async execute() {
        return { unexpected: true };
      },
    };
    const scenario: FakeAgentScenario = {
      id: "bad-tool-output",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-1", toolName: "broken_tool", input: {}, rawAssessment: NO_EVIDENCE_YET_ASSESSMENT }],
        },
        { kind: "report_submission", usage, rawInput: validReport },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool, brokenTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_OUTPUT_INVALID");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "broken_tool" },
    ]);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("fails with REPORT_SCHEMA_INVALID when the submitted report fails schema validation", async () => {
    const provider = new FakeLlmProvider({
      id: "invalid-report",
      turns: [{ kind: "report_submission", usage, rawInput: invalidReport }],
    });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_SCHEMA_INVALID");
    expect(result.trace).toEqual([]);
    expect(result.reportValidationIssues).toEqual([
      { path: ["summary"], code: "invalid_type", expectedType: "string", receivedType: "undefined" },
      { path: ["rootCause"], code: "invalid_type", expectedType: "string", receivedType: "undefined" },
      {
        path: ["customerImpact"],
        code: "invalid_type",
        expectedType: "string",
        receivedType: "undefined",
      },
      {
        path: ["recommendedResolution"],
        code: "invalid_type",
        expectedType: "string",
        receivedType: "undefined",
      },
      { path: ["confidence"], code: "invalid_type", expectedType: "number", receivedType: "undefined" },
      { path: ["evidence"], code: "invalid_type", expectedType: "array", receivedType: "undefined" },
      {
        path: ["suggestedActions"],
        code: "invalid_type",
        expectedType: "array",
        receivedType: "undefined",
      },
      // Issue #58: evidenceState is now a required new-write key, so a
      // malformed report reports its absence too.
      {
        path: ["evidenceState"],
        code: "invalid_value",
        expectedType: "enum",
        receivedType: "undefined",
      },
    ]);
  });

  it("fails with REPORT_SCHEMA_INVALID and a sanitized bound-violation diagnostic — never the raw value — when a structurally complete report exceeds a bound the Claude-facing tool schema does not convey", async () => {
    // The real LIVE incident's failure class: toStrictInputSchema strips
    // minimum/maximum from what Claude sees (claude-tool-schemas.ts), so a
    // well-typed report can still violate confidence's 0-1 bound.
    const provider = new FakeLlmProvider({
      id: "confidence-percentage",
      turns: [
        { kind: "report_submission", usage, rawInput: { ...validReport, confidence: 70 } },
      ],
    });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_SCHEMA_INVALID");
    expect(result.message).toBe("The submitted resolution report failed schema validation.");
    expect(result.reportValidationIssues).toEqual([
      { path: ["confidence"], code: "too_big", origin: "number", bound: 1 },
    ]);
    expect(JSON.stringify(result.reportValidationIssues)).not.toContain("70");
  });

  it("fails with PROVIDER_PROTOCOL_INVALID when a fourth diagnostic tool request replaces the required report on the forced finalization turn", async () => {
    // Three diagnostic turns fill the investigation budget; the 4th request
    // lands on the reserved FINALIZATION turn, which requires a report.
    const scenario: FakeAgentScenario = {
      id: "fourth-tool-request",
      turns: [...buildMultiToolTurns(3), ...buildMultiToolTurns(1)],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.failedStage).toBe("REPORT_GENERATION");
    // Exactly three tool request/completion pairs ran; the rejected request
    // never produced a trace entry.
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-3", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-3", toolName: "get_service_status" },
    ]);
    // The loop never exceeds MAX_PROVIDER_TURNS.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(4);
  });

  it("fails with PROVIDER_PROTOCOL_INVALID at DIAGNOSTIC_EXECUTION when the provider reuses a prior tool-call identity, executing the tool exactly once and never exposing the reused id in the message", async () => {
    // P1 final correction: a repeated provider toolCallId must be rejected
    // before any side effect. Checkpoint A's exact-replay semantics would
    // otherwise re-append an identical (runId, eventType, toolCallId) row and
    // execute the tool a second time while the ledger records only one
    // request/completion pair — so runtime, not persistence, must reject.
    const sentinelToolCallId = "toolu_sk-ant-api03-credential-1a2b3c";
    const scenario: FakeAgentScenario = {
      id: "duplicate-tool-call-id",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: sentinelToolCallId,
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: sentinelToolCallId,
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // The duplicate is rejected by the duplicate-identity guard
              // before V0/A2/A3 ever run, so this assessment is never
              // validated — it exists only to keep the fixture type-valid.
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: sentinelToolCallId, sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    // Turn 1 is a post-tool investigation turn, so the truthful active stage
    // is DIAGNOSTIC_EXECUTION (the run is mid-loop, below its bound).
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    // The provider was called for turn 0 and turn 1, but the tool executed
    // exactly once — the duplicate request was rejected, not re-run.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    // The rejected duplicate produced no additional trace entries.
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: sentinelToolCallId, toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: sentinelToolCallId, toolName: "get_service_status" },
    ]);
    // The failure message is closed: it must never echo the provider-controlled
    // identifier, even when that identifier is credential-shaped. (The trace
    // legitimately carries the id from the successful turn-0 execution; the
    // requirement is that the REJECTION message does not.)
    expect(result.message).toBe("A diagnostic request reused a prior tool-call identity.");
    expect(result.message).not.toContain(sentinelToolCallId);
  });

  it("stops after a provider protocol_error, without executing tools or calling the provider again", async () => {
    const scenario: FakeAgentScenario = {
      id: "provider-protocol-error",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
            {
              toolCallId: "call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "billing-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.trace).toEqual([]);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("fails with TOOL_EXECUTION_FAILED, without exposing the original error or calling the provider again, when a diagnostic tool throws", async () => {
    const throwingTool: DiagnosticToolDefinition = {
      name: "throwing_tool",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      async execute() {
        throw new Error("simulated internal failure: db connection refused at 10.0.0.5");
      },
    };
    const scenario: FakeAgentScenario = {
      id: "throwing-tool",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-1", toolName: "throwing_tool", input: {}, rawAssessment: NO_EVIDENCE_YET_ASSESSMENT }],
        },
        { kind: "report_submission", usage, rawInput: validReport },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([throwingTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_EXECUTION_FAILED");
    expect(JSON.stringify(result)).not.toContain("db connection refused");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "throwing_tool" },
    ]);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("completes when the report cites the successful tool call's exact toolCallId as TOOL_EXECUTION evidence", async () => {
    const scenario = buildToolRequestScenario("tool-then-report", "notification-service");
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("fails with REPORT_EVIDENCE_INVALID and does not record REPORT_GENERATED, when the report cites an unknown tool-execution id", async () => {
    const scenario: FakeAgentScenario = {
      id: "unknown-tool-evidence",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                evidenceId: "call-999",
                sourceType: "TOOL_EXECUTION",
                finding: "notification-service reported status DEGRADED.",
              },
            ],
          },
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_EVIDENCE_INVALID");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it("completes when the report cites both a successful tool execution and an allowed RAG chunk as evidence", async () => {
    const scenario: FakeAgentScenario = {
      id: "mixed-evidence",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // RAG evidence (rag-chunk-2) is already allowed in this run, so
              // the request must cite it (A3: NO_EVIDENCE_YET is only valid
              // when no evidence at all exists).
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "rag-chunk-2", sourceType: "RAG_CHUNK" }],
              },
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                evidenceId: "call-1",
                sourceType: "TOOL_EXECUTION",
                finding: "notification-service reported status DEGRADED.",
              },
              {
                evidenceId: "rag-chunk-2",
                sourceType: "RAG_CHUNK",
                finding: "Knowledge base article KB-42 describes this failure mode.",
              },
            ],
          },
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-2"]),
    });

    expect(result.status).toBe("completed");
  });

  it("fails with REPORT_EVIDENCE_INVALID and does not record REPORT_GENERATED, when the report cites an unknown RAG chunk id", async () => {
    const provider = new FakeLlmProvider({
      id: "unknown-rag-evidence",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                evidenceId: "rag-chunk-unknown",
                sourceType: "RAG_CHUNK",
                finding: "Knowledge base article KB-42 describes this failure mode.",
              },
            ],
          },
        },
      ],
    });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_EVIDENCE_INVALID");
    expect(result.trace).toEqual([]);
  });
});

describe("runAgentOrchestrator — AgentOrchestratorParams invariants", () => {
  it("fails with RETRIEVAL_PARAMS_INVALID when retriever is present without retrievalInput", async () => {
    const retriever = new FakeRunbookRetriever([]);
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.trace).toEqual([]);
  });

  it("fails with RETRIEVAL_PARAMS_INVALID when retrievalInput is present without retriever", async () => {
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retrievalInput: { query: "notification", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.trace).toEqual([]);
  });

  it("fails with RETRIEVAL_PARAMS_INVALID when retriever is combined with a non-empty allowedRagChunkIds", async () => {
    const retriever = new FakeRunbookRetriever([sampleChunk]);
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
      allowedRagChunkIds: new Set(["some-id"]),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.trace).toEqual([]);
  });

  it("succeeds when retriever is combined with an empty allowedRagChunkIds", async () => {
    const retriever = new FakeRunbookRetriever([sampleChunk]);
    const provider = new FakeLlmProvider({
      id: "empty-allowed-set-with-retriever",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              { evidenceId: sampleChunk.chunkId, sourceType: "RAG_CHUNK", finding: "Matches." },
            ],
          },
        },
      ],
    });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
      allowedRagChunkIds: new Set(),
    });

    expect(result.status).toBe("completed");
  });
});

describe("runAgentOrchestrator — retrieval integration", () => {
  it("fails with RETRIEVAL_PARAMS_INVALID and never calls the retriever, when retrievalInput.topK is out of range", async () => {
    const retrieveSpy = vi.fn();
    const retriever: RunbookRetriever = { retrieve: retrieveSpy };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 0 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.trace).toEqual([]);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("fails with RETRIEVAL_PARAMS_INVALID and never calls the retriever, for an empty query", async () => {
    const retrieveSpy = vi.fn();
    const retriever: RunbookRetriever = { retrieve: retrieveSpy };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "   ", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.trace).toEqual([]);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it("fails with RETRIEVAL_FAILED and never calls the provider, when the retriever throws", async () => {
    const retriever: RunbookRetriever = {
      async retrieve() {
        throw new RetrieverError("TIMEOUT", "Embedding request timed out.");
      },
    };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_FAILED");
    expect(result.trace).toEqual([]);
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
  });

  it("fails with RETRIEVAL_FAILED when the retriever throws something other than RetrieverError", async () => {
    const retriever: RunbookRetriever = {
      async retrieve() {
        throw new Error("unexpected");
      },
    };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_FAILED");
  });

  it("fails with RETRIEVAL_RESPONSE_INVALID and never calls the provider, when the retriever returns duplicate chunkIds", async () => {
    const retriever: RunbookRetriever = {
      async retrieve() {
        return [
          { ...sampleChunk, rank: 1 },
          { ...sampleChunk, rank: 2 },
        ];
      },
    };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_RESPONSE_INVALID");
    expect(result.trace).toEqual([]);
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
  });

  it("fails with RETRIEVAL_RESPONSE_INVALID when the retriever's rank values don't match array position", async () => {
    const retriever: RunbookRetriever = {
      async retrieve() {
        return [
          { ...sampleChunk, chunkId: "a", rank: 2 },
          { ...sampleChunk, chunkId: "b", rank: 1 },
        ];
      },
    };
    const provider = new FakeLlmProvider({ id: "unused", turns: [] });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_RESPONSE_INVALID");
  });

  it("completes, pushing RETRIEVAL_COMPLETED with the safe summary and injecting rag_context, when the report cites the retrieved chunk id", async () => {
    const retriever = new FakeRunbookRetriever([sampleChunk]);
    const provider = new FakeLlmProvider({
      id: "retrieval-then-report",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                evidenceId: sampleChunk.chunkId,
                sourceType: "RAG_CHUNK",
                finding: "Runbook describes this exact degradation.",
              },
            ],
          },
        },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification degradation", topK: 3 },
    });

    expect(result.status).toBe("completed");
    expect(result.trace[0]).toEqual({
      type: "RETRIEVAL_COMPLETED",
      chunks: [{ chunkId: sampleChunk.chunkId, rank: 1, score: 4 }],
    });

    const firstCallConversation = runAgentTurnSpy.mock.calls[0]?.[0]?.conversation;
    expect(firstCallConversation).toEqual([
      ticketContext,
      {
        role: "rag_context",
        entries: [
          {
            evidenceId: sampleChunk.chunkId,
            sourceType: "RAG_CHUNK",
            runbookId: sampleChunk.runbookId,
            title: sampleChunk.title,
            content: sampleChunk.content,
          },
        ],
      },
    ]);
  });

  it("pushes RETRIEVAL_COMPLETED with an empty chunk list and does not inject rag_context, when retrieval returns zero chunks — tool-only evidence remains valid", async () => {
    const retriever = new FakeRunbookRetriever([]);
    const scenario = buildToolRequestScenario("zero-chunk-retrieval", "notification-service");
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "no matches for this query", topK: 3 },
    });

    expect(result.status).toBe("completed");
    expect(result.trace[0]).toEqual({ type: "RETRIEVAL_COMPLETED", chunks: [] });
    expect(runAgentTurnSpy.mock.calls[0]?.[0]?.conversation).toEqual([ticketContext]);
  });

  it("fails with REPORT_EVIDENCE_INVALID when the report cites a real chunk id that was not part of this run's retrieval results", async () => {
    const retriever = new FakeRunbookRetriever([sampleChunk]);
    const provider = new FakeLlmProvider({
      id: "non-retrieved-id",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                // A real corpus chunkId, but not among this run's retrieval results.
                evidenceId: "runbook-auth-failures-001",
                sourceType: "RAG_CHUNK",
                finding: "Not actually retrieved this run.",
              },
            ],
          },
        },
      ],
    });
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification degradation", topK: 3 },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_EVIDENCE_INVALID");
  });

  it("completes when the report cites both a successful tool execution and a retrieved RAG chunk together", async () => {
    const retriever = new FakeRunbookRetriever([sampleChunk]);
    const scenario: FakeAgentScenario = {
      id: "retrieval-plus-tool",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // The retriever already returned sampleChunk, so RAG evidence
              // exists in this run — the request must cite it (A3).
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: sampleChunk.chunkId, sourceType: "RAG_CHUNK" }],
              },
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...validReport,
            evidence: [
              {
                evidenceId: "call-1",
                sourceType: "TOOL_EXECUTION",
                finding: "notification-service reported status DEGRADED.",
              },
              {
                evidenceId: sampleChunk.chunkId,
                sourceType: "RAG_CHUNK",
                finding: "Runbook describes this exact degradation.",
              },
            ],
          },
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      retriever,
      retrievalInput: { query: "notification degradation", topK: 3 },
    });

    expect(result.status).toBe("completed");
  });
});

/**
 * A transport-level provider failure is an EXPECTED outcome once a live
 * provider is wired, not a defect. These tests pin the property that makes the
 * live path safe to persist: the orchestrator converts such a failure into an
 * ordinary failed result, so the caller finalizes the run instead of letting a
 * throw escape and strand the row in RUNNING forever.
 */
class ThrowingProvider implements LlmProvider {
  constructor(private readonly toThrow: unknown) {}
  async runAgentTurn(): Promise<never> {
    throw this.toThrow;
  }
}

describe("runAgentOrchestrator — expected provider failures", () => {
  const registry = new InMemoryToolRegistry([getServiceStatusTool]);

  const run = (toThrow: unknown) =>
    runAgentOrchestrator({
      provider: new ThrowingProvider(toThrow),
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

  it.each([
    ["AUTHENTICATION", "PROVIDER_UNAVAILABLE"],
    ["BILLING", "PROVIDER_UNAVAILABLE"],
    ["RATE_LIMIT", "PROVIDER_UNAVAILABLE"],
    ["CONNECTION", "PROVIDER_UNAVAILABLE"],
    ["SERVER_ERROR", "PROVIDER_UNAVAILABLE"],
    ["REQUEST_INVALID", "PROVIDER_UNAVAILABLE"],
    ["UNKNOWN", "PROVIDER_UNAVAILABLE"],
    ["TIMEOUT", "PROVIDER_TIMEOUT"],
    ["CANCELLED", "PROVIDER_CANCELLED"],
  ] as const)("maps a %s provider error to %s", async (category, expectedCode) => {
    const result = await run(new LlmProviderError(category, "sanitized message"));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.code).toBe(expectedCode);
  });

  it("carries the adapter's already-sanitized message through unchanged", async () => {
    // The adapter's message is a fixed, category-keyed string. Passing it
    // through is what keeps vendor bodies, headers, request IDs, and prompts
    // out of the trace and the database.
    const result = await run(new LlmProviderError("RATE_LIMIT", "Anthropic API rate limit was exceeded."));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.message).toBe("Anthropic API rate limit was exceeded.");
  });

  it("returns a result rather than throwing, so the run can be finalized", async () => {
    // The whole point: a caller must never have to choose between an
    // unfinalized RUNNING row and swallowing the failure.
    await expect(run(new LlmProviderError("TIMEOUT", "timed out"))).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("still emits a trace for the failed run", async () => {
    const result = await run(new LlmProviderError("CONNECTION", "connection failed"));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(Array.isArray(result.trace)).toBe(true);
  });

  it("rethrows a genuine defect instead of laundering it into a failed run", async () => {
    // A TypeError is a bug, not a provider outcome. Converting it would hide
    // the defect behind a plausible-looking FAILED run.
    const defect = new TypeError("cannot read properties of undefined");

    await expect(run(defect)).rejects.toThrow(defect);
  });
});

/**
 * Issue #37 Phase B — the canonical persistence channel, and the proof that
 * it is genuinely independent of the legacy in-memory trace channel.
 *
 * Every test here supplies a RECORDING emitter (never a real repository), so
 * what is asserted is exactly the ordered payload list the orchestrator would
 * have handed to `appendInvestigationEvent`.
 */
describe("runAgentOrchestrator — canonical lifecycle emission", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  const types = (emitted: readonly InvestigationEventPayload[]) => emitted.map((e) => e.type);

  it("emits the exact canonical order for a DIRECT (no-tool) success", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider({
      id: "direct-report",
      turns: [{ kind: "report_submission", usage, rawInput: validReportWithRagEvidence }],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    // No REPORT_GENERATION_STARTED: the direct path never reaches a
    // finalization turn, so announcing one would be untrue.
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
    ]);
    // The legacy channel is unaffected and still uses its own type name.
    expect(result.trace).toEqual([{ type: "REPORT_GENERATED" }]);
  });

  it("emits the exact canonical order for a ONE-TOOL voluntary early report (no REPORT_GENERATION_STARTED)", async () => {
    // After one diagnostic the loop still has an investigation turn available,
    // so the provider may submit the report directly on turn 1 — a voluntary
    // early report, which must NOT be announced with a synthetic
    // REPORT_GENERATION_STARTED (issue #57 Decision 4).
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider(
      buildToolRequestScenario("tool-then-report", "notification-service"),
    );

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
    ]);
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("emits RETRIEVAL_COMPLETED before the legacy push, and only after both validations", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider({
      id: "retrieval-then-report",
      turns: [{ kind: "report_submission", usage, rawInput: validReportWithRagEvidence }],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      retriever: new FakeRunbookRetriever([{ ...sampleChunk, chunkId: "rag-chunk-1" }]),
      retrievalInput: { query: "notification delays", topK: 1 },
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "RETRIEVAL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
    ]);
    expect(result.trace[0]).toMatchObject({ type: "RETRIEVAL_COMPLETED" });
  });

  // THE MANDATORY #37 OBLIGATION: canonical TOOL_REQUESTED must precede
  // registry lookup and input validation, so the two early tool failures can
  // truthfully record that the provider did request the tool.
  it.each([
    ["TOOL_NOT_FOUND", buildToolRequestScenario("unknown-tool", "notification-service", "not_a_real_tool")],
    [
      "TOOL_INPUT_INVALID",
      {
        id: "bad-input",
        turns: [
          {
            kind: "diagnostic_tool_requests" as const,
            usage,
            requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { wrong: 1 }, rawAssessment: NO_EVIDENCE_YET_ASSESSMENT }],
          },
        ],
      } satisfies FakeAgentScenario,
    ],
  ])("emits TOOL_REQUESTED then TOOL_FAILED for %s, while the legacy trace stays empty", async (code, scenario) => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe(code);
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");

    expect(types(emitted)).toEqual(["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_FAILED"]);
    expect(emitted[2]).toMatchObject({ failureCode: code, toolCallId: "call-1" });

    // The divergence that makes the two channels worth keeping separate: the
    // legacy push sits after validation, so it never fired.
    expect(result.trace).toEqual([]);
  });

  it("emits TOOL_REQUESTED then TOOL_FAILED for TOOL_EXECUTION_FAILED", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const throwingTool: DiagnosticToolDefinition = {
      ...getServiceStatusTool,
      execute: async () => {
        throw new Error("tool blew up");
      },
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(buildToolRequestScenario("exec-fail", "notification-service")),
      toolRegistry: new InMemoryToolRegistry([throwingTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    expect(types(emitted)).toEqual(["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_FAILED"]);
    // The legacy TOOL_REQUESTED DID fire here — validation succeeded, and only
    // execution failed — which is exactly the pre-#37 behavior.
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it("emits TOOL_REQUESTED then TOOL_FAILED for TOOL_OUTPUT_INVALID", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const badOutputTool: DiagnosticToolDefinition = {
      ...getServiceStatusTool,
      outputSchema: z.object({ neverMatches: z.string() }),
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(buildToolRequestScenario("bad-output", "notification-service")),
      toolRegistry: new InMemoryToolRegistry([badOutputTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_OUTPUT_INVALID");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    expect(types(emitted)).toEqual(["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_FAILED"]);
  });

  it.each([
    ["REPORT_SCHEMA_INVALID", invalidReport],
    ["REPORT_EVIDENCE_INVALID", validReport],
  ])("emits REPORT_SUBMITTED then REPORT_VALIDATION_FAILED for %s", async (code, rawInput) => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({
        id: `report-${code}`,
        turns: [{ kind: "report_submission", usage, rawInput }],
      }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe(code);
    expect(result.failedStage).toBe("REPORT_GENERATION");
    expect(types(emitted)).toEqual(["AGENT_STARTED", "REPORT_SUBMITTED", "REPORT_VALIDATION_FAILED"]);
    expect(emitted[2]).toMatchObject({ failureCode: code });
    // No legacy REPORT_GENERATED for a rejected report — unchanged from before.
    expect(result.trace).toEqual([]);
  });

  it("attributes a provider failure on the INVESTIGATION turn to AGENT_ANALYSIS", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider: LlmProvider = {
      runAgentTurn: async () => {
        throw new LlmProviderError("RATE_LIMIT", "rate limited");
      },
    };

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.failedStage).toBe("AGENT_ANALYSIS");
    // No REPORT_GENERATION_STARTED — the finalization turn was never reached.
    expect(types(emitted)).toEqual(["AGENT_STARTED"]);
  });

  it("attributes a provider failure on the forced FINALIZATION turn to REPORT_GENERATION", async () => {
    // The diagnostic bound is exhausted after three tools, so the next
    // provider call is forced finalization; a provider failure there belongs
    // to REPORT_GENERATION — never DIAGNOSTIC_EXECUTION, which has finished.
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    let turn = 0;
    const provider: LlmProvider = {
      runAgentTurn: async () => {
        if (turn++ < 3) {
          return {
            type: "diagnostic_tool_request",
            providerRequestId: `p:${turn - 1}`,
            usage,
            request: {
              toolCallId: `call-${turn}`,
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: assessmentForTurnIndex(turn - 1),
            },
          };
        }
        throw new LlmProviderError("SERVER_ERROR", "provider exploded");
      },
    };

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.failedStage).toBe("REPORT_GENERATION");
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATION_STARTED",
    ]);
  });

  // The final-turn guard runs BEFORE the canonical emission, so a second tool
  // request never produces a second TOOL_REQUESTED (which the reducer would
  // reject as TOOL_LIMIT_EXCEEDED).
  it("emits no fourth TOOL_REQUESTED when a tool is requested on the forced final provider turn", async () => {
    // The final-turn guard runs BEFORE the canonical emission, so a tool
    // request on the finalization turn never produces a 4th TOOL_REQUESTED
    // (which the reducer would reject).
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const fourToolRequests: FakeAgentScenario = {
      id: "four-tools",
      turns: [...buildMultiToolTurns(3), ...buildMultiToolTurns(1)],
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(fourToolRequests),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.failedStage).toBe("REPORT_GENERATION");
    expect(types(emitted).filter((t) => t === "TOOL_REQUESTED")).toHaveLength(3);
  });

  it("does not emit AGENT_STARTED for the pre-agent RETRIEVAL_PARAMS_INVALID exception", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "unused", turns: [] }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      // retriever without retrievalInput — a caller-contract violation caught
      // by validateOrchestratorParams before anything is traced or emitted.
      retriever: new FakeRunbookRetriever([sampleChunk]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(result.failedStage).toBe("AGENT_ANALYSIS");
    // Nothing emitted at all, so the canonical stream is exactly
    // RUN_CREATED -> RUN_FAILED — the contract's single pre-agent exception.
    expect(emitted).toEqual([]);
  });

  describe("emitter rejection aborts immediately", () => {
    class BoomError extends Error {}

    it("stops before the legacy push for the event whose canonical write failed", async () => {
      const provider = new FakeLlmProvider({
        id: "retrieval-then-report",
        turns: [{ kind: "report_submission", usage, rawInput: validReportWithRagEvidence }],
      });
      const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

      await expect(
        runAgentOrchestrator({
          provider,
          toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
          initialConversation: [ticketContext],
          retriever: new FakeRunbookRetriever([{ ...sampleChunk, chunkId: "rag-chunk-1" }]),
          retrievalInput: { query: "notification delays", topK: 1 },
          emitLifecycleEvent: async (payload) => {
            if (payload.type === "RETRIEVAL_COMPLETED") throw new BoomError("ledger down");
          },
        }),
      ).rejects.toBeInstanceOf(BoomError);

      // The provider was never called: retrieval precedes the first turn, and
      // the failed append aborted before it.
      expect(runAgentTurnSpy).not.toHaveBeenCalled();
    });

    it("performs no further tool call after a failed TOOL_REQUESTED append", async () => {
      const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

      await expect(
        runAgentOrchestrator({
          provider: new FakeLlmProvider(buildToolRequestScenario("abort-tool", "notification-service")),
          toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
          initialConversation: [ticketContext],
          emitLifecycleEvent: async (payload) => {
            if (payload.type === "TOOL_REQUESTED") throw new BoomError("ledger down");
          },
        }),
      ).rejects.toBeInstanceOf(BoomError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("performs no further provider turn after a failed TOOL_COMPLETED append", async () => {
      const provider = new FakeLlmProvider(
        buildToolRequestScenario("abort-after-tool", "notification-service"),
      );
      const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

      await expect(
        runAgentOrchestrator({
          provider,
          toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
          initialConversation: [ticketContext],
          emitLifecycleEvent: async (payload) => {
            if (payload.type === "TOOL_COMPLETED") throw new BoomError("ledger down");
          },
        }),
      ).rejects.toBeInstanceOf(BoomError);

      // Only the investigation turn ran; the finalization turn never started.
      expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Issue #57 Checkpoint B — the bounded multi-step runtime loop. These tests
 * pin the loop mechanics with deterministic fake providers: one diagnostic
 * tool request per investigation turn, forced finalization on the reserved
 * final turn, defense-in-depth bounds, truthful active-stage attribution, and
 * exact event ordering on both output channels. No LIVE/paid provider is
 * involved.
 */
describe("runAgentOrchestrator — bounded multi-step diagnostic loop (issue #57 Checkpoint B)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  const types = (emitted: readonly InvestigationEventPayload[]) => emitted.map((e) => e.type);

  const registry = new InMemoryToolRegistry([getServiceStatusTool]);

  it("completes after two diagnostic tool calls followed by a voluntary report, without REPORT_GENERATION_STARTED", async () => {
    const provider = new FakeLlmProvider(buildNToolsThenReportScenario(2));
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(3);
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("completes after three diagnostic tool calls followed by the forced finalization report, with REPORT_GENERATION_STARTED", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider(buildNToolsThenReportScenario(3));
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // The loop used exactly MAX_PROVIDER_TURNS provider calls and exactly
    // MAX_DIAGNOSTIC_TOOL_CALLS tool executions — never more.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(4);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    // Canonical stream carries every diagnostic request/outcome in exact order,
    // then the forced-finalization report-start before the finalization result.
    expect(types(emitted)).toEqual([
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
    ]);
    // The legacy channel preserves the repeated tool events in exact order.
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-2", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-3", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-3", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("emits REPORT_GENERATION_STARTED before the forced-finalization provider call, and never before an investigation turn", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    let turn = 0;
    const provider: LlmProvider = {
      runAgentTurn: async (input) => {
        // Asserted AT the provider-call boundary: the finalization call must
        // already see the report-start fact in the emission stream, while no
        // investigation call may see it.
        const startedSeen = emitted.some((e) => e.type === "REPORT_GENERATION_STARTED");
        if (input.phase === "FINALIZATION") {
          expect(startedSeen).toBe(true);
        } else {
          expect(startedSeen).toBe(false);
        }
        if (turn++ < 3) {
          return {
            type: "diagnostic_tool_request",
            providerRequestId: `p:${turn - 1}`,
            usage,
            request: {
              toolCallId: `call-${turn}`,
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: assessmentForTurnIndex(turn - 1),
            },
          };
        }
        return { type: "report_submission", providerRequestId: "p:3", usage, rawInput: validReport };
      },
    };

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
  });

  it("fails closed with TOOL_NOT_FOUND when a forbidden tool is requested on a later diagnostic step", async () => {
    const scenario: FakeAgentScenario = {
      id: "forbidden-on-step-2",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" }, rawAssessment: assessmentForTurnIndex(0) }],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-2", toolName: "delete_everything", input: { serviceSlug: "notification-service" }, rawAssessment: assessmentForTurnIndex(1) }],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_NOT_FOUND");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    // Step 1 executed; step 2's forbidden request executed nothing.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it("fails closed with TOOL_EXECUTION_FAILED when a tool throws on a later diagnostic step, without retrying or calling the provider again", async () => {
    const throwingTool: DiagnosticToolDefinition = {
      name: "throwing_tool",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      async execute() {
        throw new Error("simulated internal failure: db connection refused at 10.0.0.5");
      },
    };
    const scenario: FakeAgentScenario = {
      id: "tool-failure-on-step-2",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" }, rawAssessment: assessmentForTurnIndex(0) }],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-2", toolName: "throwing_tool", input: {}, rawAssessment: assessmentForTurnIndex(1) }],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool, throwingTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    expect(JSON.stringify(result)).not.toContain("db connection refused");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_REQUESTED", toolCallId: "call-2", toolName: "throwing_tool" },
    ]);
  });

  it("attributes a protocol error on a post-tool investigation turn to DIAGNOSTIC_EXECUTION", async () => {
    const scenario: FakeAgentScenario = {
      id: "post-tool-protocol-error",
      turns: [
        ...buildMultiToolTurns(1),
        // Two requests in one turn normalize to PROVIDER_PROTOCOL_INVALID.
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            { toolCallId: "call-2", toolName: "get_service_status", input: { serviceSlug: "notification-service" }, rawAssessment: assessmentForTurnIndex(1) },
            { toolCallId: "call-3", toolName: "get_service_status", input: { serviceSlug: "billing-service" }, rawAssessment: assessmentForTurnIndex(2) },
          ],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
  });

  it.each([
    ["TIMEOUT", "PROVIDER_TIMEOUT"],
    ["CANCELLED", "PROVIDER_CANCELLED"],
    ["RATE_LIMIT", "PROVIDER_UNAVAILABLE"],
  ] as const)(
    "attributes a provider %s on a post-tool investigation turn to DIAGNOSTIC_EXECUTION",
    async (category, expectedCode) => {
      let turn = 0;
      const provider: LlmProvider = {
        runAgentTurn: async () => {
          if (turn++ === 0) {
            return {
              type: "diagnostic_tool_request",
              providerRequestId: "p:0",
              usage,
              request: {
                toolCallId: "call-1",
                toolName: "get_service_status",
                input: { serviceSlug: "notification-service" },
                rawAssessment: assessmentForTurnIndex(0),
              },
            };
          }
          throw new LlmProviderError(category, `${category} on the second investigation turn`);
        },
      };

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: registry,
        initialConversation: [ticketContext],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.code).toBe(expectedCode);
      expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    },
  );

  it("completes when the report cites a toolCallId from an earlier diagnostic step", async () => {
    const provider = new FakeLlmProvider(
      buildNToolsThenReportScenario(2, {
        ...validReport,
        evidence: [
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "notification-service reported status DEGRADED." },
        ],
      }),
    );

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
  });

  it("accumulates every successful diagnostic execution id, so a report may cite several across steps", async () => {
    const provider = new FakeLlmProvider(
      buildNToolsThenReportScenario(2, {
        ...validReport,
        evidence: [
          { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "first finding" },
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "second finding" },
        ],
      }),
    );

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
  });

  it("rejects a report citing a toolCallId that never completed, after several diagnostics", async () => {
    const provider = new FakeLlmProvider(
      buildNToolsThenReportScenario(2, {
        ...validReport,
        evidence: [
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "real finding" },
          { evidenceId: "call-999", sourceType: "TOOL_EXECUTION", finding: "invented finding" },
        ],
      }),
    );

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_EVIDENCE_INVALID");
    expect(result.failedStage).toBe("REPORT_GENERATION");
  });

  it("never lets a tool that failed on a later diagnostic step become successful evidence", async () => {
    const throwingTool: DiagnosticToolDefinition = {
      name: "throwing_tool",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      async execute() {
        throw new Error("boom");
      },
    };
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const scenario: FakeAgentScenario = {
      id: "failed-step-2",
      turns: [
        ...buildMultiToolTurns(1),
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-2", toolName: "throwing_tool", input: {}, rawAssessment: assessmentForTurnIndex(1) }],
        },
      ],
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool, throwingTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_EXECUTION_FAILED");
    // The run fails closed before any report could cite the failed id: the
    // canonical stream ends at the failure and never emits REPORT_SUBMITTED.
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_FAILED",
    ]);
  });
});

// ============================================================================
// Issue #58 Checkpoint B §13–§15 — evidence-aware continuation scenarios, the
// §14 protocol-negative matrix, and the persistence-channel proofs. Fixtures
// use the REAL seeded status table (get-service-status.ts): notification-
// service=DEGRADED, billing-service=OUTAGE, auth-service=OPERATIONAL, and
// UNKNOWN for anything unseeded.
// ============================================================================

describe("runAgentOrchestrator — evidence-aware continuation (issue #58 Checkpoint B §13)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  const types = (emitted: readonly InvestigationEventPayload[]) => emitted.map((e) => e.type);

  const UNKNOWN_STATUS_OUTPUT = { serviceSlug: "unknown-service", status: "UNKNOWN" };

  // A schema-valid report variant for the evidence-state under test. The
  // report contract (P1-1) forbids a non-null rootCause whenever the evidence
  // is non-sufficient, so every INSUFFICIENT fixture passes rootCause: null.
  function reportVariant(args: {
    category?: string;
    evidenceState: "SUFFICIENT" | "INSUFFICIENT";
    rootCause: string | null;
    evidence: Array<{
      evidenceId: string;
      sourceType: "TOOL_EXECUTION";
      finding: string;
    }>;
  }): unknown {
    return {
      category: args.category ?? "SERVICE_DEGRADATION",
      summary: "Evidence gathered for the ticket.",
      customerImpact: "Impact assessed from the gathered evidence.",
      recommendedResolution: "Follow up per the ticket.",
      confidence: 0.5,
      evidence: args.evidence,
      evidenceState: args.evidenceState,
      rootCause: args.rootCause,
      suggestedActions: [],
    };
  }

  it("A — sufficient causal evidence after ONE diagnostic stops the loop with a voluntary early report (no second tool)", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider(
      buildToolRequestScenario("scenario-a", "notification-service"),
    );
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("SUFFICIENT");
    expect(result.report.rootCause).toBe("notification-service is degraded.");
    expect(result.report.evidence).toEqual([
      {
        evidenceId: "call-1",
        sourceType: "TOOL_EXECUTION",
        finding: "notification-service reported status DEGRADED.",
      },
    ]);
    // The loop stopped after one diagnostic — no second request merely to
    // spend budget, and no REPORT_GENERATION_STARTED (voluntary early report).
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
    ]);
    // The canonical TOOL_REQUESTED carries the VALIDATED first-request
    // assessment (no evidence existed before the request).
    const toolRequested = emitted.find((e) => e.type === "TOOL_REQUESTED");
    expect(toolRequested).toMatchObject({ assessment: NO_EVIDENCE_YET_ASSESSMENT });
  });

  it("B — an UNKNOWN observation justifies a SECOND diagnostic, decided by the reactive provider from the model-visible prior result", async () => {
    const observedPriorResults: unknown[] = [];
    const seenRemainingBudget: number[] = [];

    const scenario: FakeAgentScenario = {
      id: "scenario-b",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "unknown-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        // A PURE FUNCTION of the turn input (FakeProviderTurnResolver, §12):
        // it must READ the prior UNKNOWN result from the conversation, record
        // it, and only then request a second diagnostic grounded on it. If the
        // orchestrator ever failed to surface the prior result, the assertion
        // below throws and the test fails — proof the reactive fake actually
        // sees the run context rather than replaying a fixed script.
        (input) => {
          const priorResults = input.conversation.filter(
            (m): m is DiagnosticToolResultEntry => m.role === "diagnostic_tool_result",
          );
          expect(priorResults).toHaveLength(1);
          expect(priorResults[0]?.toolCallId).toBe("call-1");
          expect(priorResults[0]?.output).toEqual(UNKNOWN_STATUS_OUTPUT);
          observedPriorResults.push(priorResults[0]?.output);
          // After one accepted diagnostic, two calls remain.
          seenRemainingBudget.push(input.diagnosticCallsRemaining);
          return {
            kind: "diagnostic_tool_requests",
            usage,
            requests: [
              {
                toolCallId: "call-2",
                toolName: "get_service_status",
                input: { serviceSlug: "notification-service" },
                rawAssessment: {
                  evidenceState: "INSUFFICIENT",
                  continuationReason: "STATUS_UNRESOLVED",
                  supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
                },
              },
            ],
          };
        },
        (input) => {
          const priorResults = input.conversation.filter(
            (m): m is DiagnosticToolResultEntry => m.role === "diagnostic_tool_result",
          );
          expect(priorResults).toHaveLength(2);
          expect(priorResults[1]?.toolCallId).toBe("call-2");
          expect(priorResults[1]?.output).toEqual({
            serviceSlug: "notification-service",
            status: "DEGRADED",
          });
          observedPriorResults.push(priorResults[1]?.output);
          return {
            kind: "report_submission",
            usage,
            rawInput: reportVariant({
              evidenceState: "SUFFICIENT",
              rootCause: "notification-service is degraded.",
              evidence: [
                {
                  evidenceId: "call-1",
                  sourceType: "TOOL_EXECUTION",
                  finding: "unknown-service reported UNKNOWN — inconclusive.",
                },
                {
                  evidenceId: "call-2",
                  sourceType: "TOOL_EXECUTION",
                  finding: "notification-service reported status DEGRADED.",
                },
              ],
            }),
          };
        },
      ],
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("SUFFICIENT");
    // The reactive turns saw BOTH prior results before deciding.
    expect(observedPriorResults).toEqual([
      UNKNOWN_STATUS_OUTPUT,
      { serviceSlug: "notification-service", status: "DEGRADED" },
    ]);
    expect(seenRemainingBudget).toEqual([2]);
  });

  it("C — a real inconclusive UNKNOWN observation leads to a voluntary INSUFFICIENT report (rootCause null), not another diagnostic", async () => {
    const provider = new FakeLlmProvider({
      id: "scenario-c",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "unknown-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: reportVariant({
            evidenceState: "INSUFFICIENT",
            rootCause: null,
            evidence: [
              {
                evidenceId: "call-1",
                sourceType: "TOOL_EXECUTION",
                finding: "unknown-service status could not be confirmed (UNKNOWN).",
              },
            ],
          }),
        },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("INSUFFICIENT");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence).toHaveLength(1);
    expect(result.report.evidence[0]?.evidenceId).toBe("call-1");
    // One diagnostic ran, then the loop stopped voluntarily instead of
    // spending the remaining budget after an inconclusive observation.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
  });

  it("C0 — zero-evidence insufficient stop: an immediate INSUFFICIENT report with evidence [] and no TOOL_REQUESTED", async () => {
    const provider = new FakeLlmProvider({
      id: "scenario-c0",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: reportVariant({
            category: "UNKNOWN",
            evidenceState: "INSUFFICIENT",
            rootCause: null,
            evidence: [],
          }),
        },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("INSUFFICIENT");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence).toEqual([]);
    // No diagnostic was ever requested or executed.
    expect(result.trace).toEqual([{ type: "REPORT_GENERATED" }]);
  });

  it("E — a tool failure on a later diagnostic persists the validated assessment on the canonical TOOL_REQUESTED and fails closed", async () => {
    const throwingTool: DiagnosticToolDefinition = {
      name: "throwing_tool",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      async execute() {
        throw new Error("boom");
      },
    };
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const scenario: FakeAgentScenario = {
      id: "scenario-e",
      turns: [
        ...buildMultiToolTurns(1),
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-2",
              toolName: "throwing_tool",
              input: {},
              rawAssessment: assessmentForTurnIndex(1),
            },
          ],
        },
      ],
    };

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool, throwingTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("TOOL_EXECUTION_FAILED");
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");

    // Both accepted requests persisted their validated assessment before the
    // failure — no evidence yet for the first, grounded on call-1 for the
    // second. The failed call never became successful evidence.
    const toolRequestedEvents = emitted.filter((e) => e.type === "TOOL_REQUESTED");
    expect(toolRequestedEvents).toHaveLength(2);
    expect(toolRequestedEvents[0]).toMatchObject({ assessment: NO_EVIDENCE_YET_ASSESSMENT });
    expect(toolRequestedEvents[1]).toMatchObject({
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "STATUS_UNRESOLVED",
        supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
      },
    });
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_FAILED",
    ]);
    // No report was ever submitted.
    expect(types(emitted)).not.toContain("REPORT_SUBMITTED");
  });

  it("F — bound exhaustion: the forced FINALIZATION turn sees diagnosticCallsRemaining 0 and reports honestly (INSUFFICIENT, rootCause null)", async () => {
    const seenRemainingOnFinalization: number[] = [];
    const scenario: FakeAgentScenario = {
      id: "scenario-f",
      turns: [
        ...buildMultiToolTurns(3),
        // The FINALIZATION turn is a pure function of the input (§12): it must
        // observe that the diagnostic budget is exhausted and submit an honest
        // INSUFFICIENT report — the model may not request a fourth diagnostic.
        (input) => {
          expect(input.phase).toBe("FINALIZATION");
          seenRemainingOnFinalization.push(input.diagnosticCallsRemaining);
          return {
            kind: "report_submission",
            usage,
            rawInput: reportVariant({
              evidenceState: "INSUFFICIENT",
              rootCause: null,
              evidence: [
                { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "first check." },
                { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "second check." },
                { evidenceId: "call-3", sourceType: "TOOL_EXECUTION", finding: "third check." },
              ],
            }),
          };
        },
      ],
    };
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(scenario),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    // The bound was exhausted: zero diagnostic headroom on the finalization turn.
    expect(seenRemainingOnFinalization).toEqual([0]);
    // The report stayed honest despite the bound: evidence was still
    // insufficient, so the accepted report carries rootCause null.
    expect(result.report.evidenceState).toBe("INSUFFICIENT");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence).toHaveLength(3);
    // Forced finalization announces REPORT_GENERATION_STARTED — the truthful
    // ledger record that the bound, not the model, ended the investigation.
    expect(types(emitted)).toContain("REPORT_GENERATION_STARTED");
  });

  it("G — sufficient non-causal healthy evidence: an OPERATIONAL observation stops the loop with a SUFFICIENT report and null root cause", async () => {
    const provider = new FakeLlmProvider({
      id: "scenario-g",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "auth-service" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: reportVariant({
            evidenceState: "SUFFICIENT",
            rootCause: null,
            evidence: [
              {
                evidenceId: "call-1",
                sourceType: "TOOL_EXECUTION",
                finding: "auth-service reported status OPERATIONAL — no degradation found.",
              },
            ],
          }),
        },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("SUFFICIENT");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence[0]?.evidenceId).toBe("call-1");
    // No extra diagnostic merely to spend budget: one check, then the report.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("runAgentOrchestrator — genuine current-run conflict (issue #58 Checkpoint C §3)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  const types = (emitted: readonly InvestigationEventPayload[]) => emitted.map((e) => e.type);

  // Test-only, deterministic diagnostic tool (§3.1): produces a genuine
  // CURRENT-RUN tool-vs-tool contradiction about the SAME subject/service
  // slug — the first completed call reports DEGRADED, every subsequent call
  // reports OPERATIONAL. Never added to DIAGNOSTIC_TOOL_CATALOG (no
  // production catalog change) and never registered outside this test file.
  // Instance isolation (Revision 3 P2-2): the ordering counter lives in a
  // closure private to ONE factory call, never a module-global — each test
  // below constructs its own fresh tool instance and fresh InMemoryToolRegistry,
  // so the scenario stays deterministic under repeated/parallel/reordered runs.
  function createConflictingStatusProbeTool(): DiagnosticToolDefinition {
    const InputSchema = z.object({ serviceSlug: z.string().min(1).max(100) }).strict();
    const OutputSchema = z
      .object({
        serviceSlug: z.string().min(1).max(100),
        status: z.enum(["DEGRADED", "OPERATIONAL"]),
      })
      .strict();
    let callCount = 0;
    return {
      name: "conflicting_status_probe",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      async execute(rawInput) {
        const { serviceSlug } = InputSchema.parse(rawInput);
        callCount += 1;
        return { serviceSlug, status: callCount === 1 ? "DEGRADED" : "OPERATIONAL" };
      },
    };
  }

  // A schema-valid CONFLICTING report: rootCause is always null (P1-1, the
  // one-way anti-fabrication invariant) — a conflict can never be silently
  // resolved into a confident, categorical rootCause.
  function conflictingReportVariant(evidence: Array<{
    evidenceId: string;
    sourceType: "TOOL_EXECUTION";
    finding: string;
  }>): unknown {
    return {
      category: "SERVICE_DEGRADATION",
      summary: "Two diagnostics disagree about the same service's status.",
      customerImpact: "Cannot be determined while the signals conflict.",
      recommendedResolution: "Manually verify payments-gateway status before acting.",
      confidence: 0.4,
      evidence,
      evidenceState: "CONFLICTING",
      rootCause: null,
      suggestedActions: [],
    };
  }

  it("D — genuine current-run conflict: two tool-vs-tool observations about the same slug produce a CONFLICTING report with both sides preserved", async () => {
    const tool = createConflictingStatusProbeTool();
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const provider = new FakeLlmProvider({
      id: "scenario-d",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "conflicting_status_probe",
              input: { serviceSlug: "payments-gateway" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-2",
              toolName: "conflicting_status_probe",
              input: { serviceSlug: "payments-gateway" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: conflictingReportVariant([
            { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported DEGRADED." },
            { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported OPERATIONAL." },
          ]),
        },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([tool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.report.evidenceState).toBe("CONFLICTING");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence.map((e) => e.evidenceId).sort()).toEqual(["call-1", "call-2"]);
    // Both disagreeing sides survive in the report — neither is silently
    // chosen as truth over the other.
    const findings = result.report.evidence.map((e) => e.finding);
    expect(findings.some((f) => f.includes("DEGRADED"))).toBe(true);
    expect(findings.some((f) => f.includes("OPERATIONAL"))).toBe(true);
    expect(types(emitted)).toEqual([
      "AGENT_STARTED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_SUBMITTED",
      "REPORT_VALIDATED",
    ]);
    // Voluntary stop while genuinely conflicting — the model chose to report
    // rather than request a third diagnostic; the bound was never reached.
    expect(types(emitted)).not.toContain("REPORT_GENERATION_STARTED");
  });

  it("positive CONFLICT_UNRESOLVED — a third diagnostic grounded on both conflicting observations is accepted and actually executes; the run stays honest at forced finalization", async () => {
    const tool = createConflictingStatusProbeTool();
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const executeSpy = vi.spyOn(tool, "execute");

    const provider = new FakeLlmProvider({
      id: "scenario-d-conflict-unresolved",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "conflicting_status_probe",
              input: { serviceSlug: "payments-gateway" },
              rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
            },
          ],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-2",
              toolName: "conflicting_status_probe",
              input: { serviceSlug: "payments-gateway" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-3",
              toolName: "conflicting_status_probe",
              input: { serviceSlug: "payments-gateway" },
              // The positive path (Revision 3 P2-3): CONFLICTING +
              // CONFLICT_UNRESOLVED, grounded on BOTH already-completed
              // disagreeing observations, requesting a further check to
              // adjudicate. Must be ACCEPTED, not rejected — this is the
              // positive counterpart to Checkpoint B's negative-only coverage.
              rawAssessment: {
                evidenceState: "CONFLICTING",
                continuationReason: "CONFLICT_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
                ],
              },
            },
          ],
        },
        // The diagnostic-tool-call bound (3) is now spent by call-3, so the
        // 4th provider turn is forced FINALIZATION — no 4th diagnostic is
        // permitted regardless of what the model wants next.
        (input) => {
          expect(input.phase).toBe("FINALIZATION");
          expect(input.diagnosticCallsRemaining).toBe(0);
          return {
            kind: "report_submission",
            usage,
            rawInput: conflictingReportVariant([
              { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported DEGRADED." },
              { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported OPERATIONAL." },
              { evidenceId: "call-3", sourceType: "TOOL_EXECUTION", finding: "A third check did not adjudicate the disagreement." },
            ]),
          };
        },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([tool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // The positive CONFLICT_UNRESOLVED request reached the canonical ledger
    // with its assessment persisted, and the diagnostic it requested
    // actually executed — proving "another diagnostic request is accepted"
    // under the conflicting-evidence path end-to-end, not merely schema-legal.
    const toolRequestedEvents = emitted.filter((e) => e.type === "TOOL_REQUESTED");
    expect(toolRequestedEvents).toHaveLength(3);
    expect(toolRequestedEvents[2]).toMatchObject({
      toolCallId: "call-3",
      assessment: {
        evidenceState: "CONFLICTING",
        continuationReason: "CONFLICT_UNRESOLVED",
        supportedBy: [
          { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
        ],
      },
    });
    expect(executeSpy).toHaveBeenCalledTimes(3);

    // The bound, not the model, ended the run — forced finalization is
    // truthfully announced.
    expect(types(emitted)).toContain("REPORT_GENERATION_STARTED");

    // No fabricated resolution: requesting another diagnostic never implies
    // the conflict was resolved. The honest final report still reports
    // CONFLICTING with rootCause null, citing all three observations.
    expect(result.report.evidenceState).toBe("CONFLICTING");
    expect(result.report.rootCause).toBeNull();
    expect(result.report.evidence.map((e) => e.evidenceId).sort()).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
  });
});

describe("runAgentOrchestrator — diagnostic assessment protocol negatives (issue #58 Checkpoint B §14)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  const types = (emitted: readonly InvestigationEventPayload[]) => emitted.map((e) => e.type);

  // Every guard failure must fail closed: PROVIDER_PROTOCOL_INVALID, the
  // offending request leaves no canonical TOOL_REQUESTED (and therefore no
  // side effect), and a prior completed tool turn, when present, executed
  // exactly once. expectedExecuteCount therefore equals the number of
  // completed tool turns in the scenario — never the rejected request.
  async function runAndExpectAssessmentRejected(args: {
    name: string;
    turns: readonly (FakeProviderTurn | FakeProviderTurnResolver)[];
    expectedEmittedTypes: readonly string[];
    expectedFailedStage: string;
    expectedExecuteCount?: number;
    allowedRagChunkIds?: ReadonlySet<string>;
  }) {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const provider = new FakeLlmProvider({ id: args.name, turns: args.turns });
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");
    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      ...(args.allowedRagChunkIds ? { allowedRagChunkIds: args.allowedRagChunkIds } : {}),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.failedStage).toBe(args.expectedFailedStage);
    expect(types(emitted)).toEqual(args.expectedEmittedTypes);
    expect(executeSpy).toHaveBeenCalledTimes(args.expectedExecuteCount ?? 0);
  }

  it("V0 rejects a malformed raw assessment (missing a required field)", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-1-malformed",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: { evidenceState: "INSUFFICIENT" },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("V0 rejects a SUFFICIENT evidence state on a request for another diagnostic", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-2-sufficient",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "SUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("A2 rejects a supportedBy locator naming a toolCallId that never existed in the run", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-3-unknown-tool-id",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-999", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("A2 rejects a supportedBy locator citing the current request's own id, which has not completed yet", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // call-2 is the CURRENT request's own id — requested but not yet
            // completed, so it is not grounded evidence for A2.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "call-2", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
    ];
    await runAndExpectAssessmentRejected({
      name: "neg-4-requested-not-completed",
      turns,
      expectedEmittedTypes: ["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_COMPLETED"],
      expectedFailedStage: "DIAGNOSTIC_EXECUTION",
      expectedExecuteCount: 1,
    });
  });

  it("A2 rejects a locator claiming TOOL_EXECUTION for an id that is a RAG chunk in this run", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-5-rag-as-tool",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });
  });

  it("A2 rejects a locator claiming RAG_CHUNK for an id that is a completed tool call in this run", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "call-1", sourceType: "RAG_CHUNK" }],
            },
          },
        ],
      },
    ];
    await runAndExpectAssessmentRejected({
      name: "neg-6-tool-as-rag",
      turns,
      expectedEmittedTypes: ["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_COMPLETED"],
      expectedFailedStage: "DIAGNOSTIC_EXECUTION",
      expectedExecuteCount: 1,
    });
  });

  it("V0 rejects a supportedBy repeating the same (sourceType, evidenceId) locator", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-7-duplicate-locator",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
                ],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("V0 rejects CONFLICT_UNRESOLVED without evidenceState CONFLICTING", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-8-conflict-reason-mismatch",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "CONFLICT_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
                ],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("V0 rejects CONFLICTING with fewer than two distinct grounded locators", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-9-conflicting-single",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "CONFLICTING",
                continuationReason: "CONFLICT_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("V0 rejects NO_EVIDENCE_YET with a non-empty supportedBy", async () => {
    await runAndExpectAssessmentRejected({
      name: "neg-10-no-evidence-with-support",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "NO_EVIDENCE_YET",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("A3 rejects NO_EVIDENCE_YET once tool evidence exists in the run", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Schema-valid (empty supportedBy), but call-1 already completed:
            // the A3 iff rule forbids claiming NO_EVIDENCE_YET now.
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
    ];
    await runAndExpectAssessmentRejected({
      name: "neg-11-no-evidence-after-evidence",
      turns,
      expectedEmittedTypes: ["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_COMPLETED"],
      expectedFailedStage: "DIAGNOSTIC_EXECUTION",
      expectedExecuteCount: 1,
    });
  });

  it("A3 composition — no non-NO_EVIDENCE_YET reason can pass while both evidence sets are empty", async () => {
    // The A3 guard's "claimsNoEvidenceYet === hasRunEvidence" both-false side
    // is provably unreachable for any V0/A2-valid assessment: a non-
    // NO_EVIDENCE_YET reason must cite >= 1 locator (V0 superRefine), and with
    // both evidence sets empty no locator is grounded (A2). So the model's only
    // consistent claim with zero evidence is NO_EVIDENCE_YET, and anything else
    // fails closed here — this pins the observable protocol-negative behavior.
    await runAndExpectAssessmentRejected({
      name: "neg-12-status-unresolved-no-evidence",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
      ],
      expectedEmittedTypes: ["AGENT_STARTED"],
      expectedFailedStage: "AGENT_ANALYSIS",
    });
  });

  it("16 — a reused provider tool-call identity is rejected before a second TOOL_REQUESTED or any side effect", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "dup-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "dup-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // The duplicate-identity guard fires BEFORE V0/A2/A3, so this
            // assessment is never read — it exists only to keep the fixture
            // type-valid. The key assertion is the emitted types below: the
            // rejected duplicate produces NO second TOOL_REQUESTED.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "dup-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
    ];
    await runAndExpectAssessmentRejected({
      name: "neg-16-duplicate-identity",
      turns,
      expectedEmittedTypes: ["AGENT_STARTED", "TOOL_REQUESTED", "TOOL_COMPLETED"],
      expectedFailedStage: "DIAGNOSTIC_EXECUTION",
      expectedExecuteCount: 1,
    });
  });
});

describe("runAgentOrchestrator — assessment rides the persistence channel (§9.4/§15)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  it("emits every canonical TOOL_REQUESTED carrying a schema-valid validated assessment", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider(buildNToolsThenReportScenario(2)),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");

    const toolRequestedEvents = emitted.filter((e) => e.type === "TOOL_REQUESTED");
    expect(toolRequestedEvents).toHaveLength(2);
    // Both writes satisfy the new TOOL_REQUESTED write contract (§4): the
    // assessment is REQUIRED and schema-valid on every new canonical append.
    for (const event of toolRequestedEvents) {
      const parsed = InvestigationEventPayloadSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
    // The persisted assessments are exactly the validated run-state-consistent
    // claims: no evidence yet for the first request, grounded on call-1 for
    // the second.
    expect(toolRequestedEvents[0]).toMatchObject({ assessment: NO_EVIDENCE_YET_ASSESSMENT });
    expect(toolRequestedEvents[1]).toMatchObject({
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "STATUS_UNRESOLVED",
        supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
      },
    });
  });
});
