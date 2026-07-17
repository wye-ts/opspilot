import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FakeLlmProvider, type FakeAgentScenario } from "../providers/fake-llm-provider";
import type { AgentConversationMessage } from "../providers/llm-provider";
import {
  InMemoryToolRegistry,
  getServiceStatusTool,
  type DiagnosticToolDefinition,
} from "../tools";
import { runAgentOrchestrator } from "./agent-orchestrator";

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
  });

  it("fails with PROVIDER_PROTOCOL_INVALID without a third provider call, when a second diagnostic tool request replaces the required report", async () => {
    const scenario: FakeAgentScenario = {
      id: "second-tool-request",
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
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
            },
          ],
        },
      ],
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
    expect(result.trace).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
    ]);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
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
