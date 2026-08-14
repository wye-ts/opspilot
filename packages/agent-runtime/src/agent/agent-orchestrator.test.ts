import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FakeLlmProvider, type FakeAgentScenario, type FakeProviderTurn } from "../providers/fake-llm-provider";
import { LlmProviderError } from "../providers/llm-provider";
import type { AgentConversationMessage, LlmProvider } from "../providers/llm-provider";
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
import type { InvestigationEventPayload } from "@opspilot/contracts";

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
        requests: [{ toolCallId: "call-1", toolName, input: { serviceSlug } }],
      },
      { kind: "report_submission", usage, rawInput: validReport },
    ],
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
          requests: [{ toolCallId: "call-1", toolName: "broken_tool", input: {} }],
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
            },
            {
              toolCallId: "call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "billing-service" },
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
          requests: [{ toolCallId: "call-1", toolName: "throwing_tool", input: {} }],
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
            requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { wrong: 1 } }],
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
          requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" } }],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-2", toolName: "delete_everything", input: { serviceSlug: "notification-service" } }],
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
          requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" } }],
        },
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-2", toolName: "throwing_tool", input: {} }],
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
            { toolCallId: "call-2", toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
            { toolCallId: "call-3", toolName: "get_service_status", input: { serviceSlug: "billing-service" } },
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
          requests: [{ toolCallId: "call-2", toolName: "throwing_tool", input: {} }],
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
