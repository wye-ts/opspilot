import type Anthropic from "@anthropic-ai/sdk";
import { InternalServerError } from "@anthropic-ai/sdk";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import { ClaudeLlmProvider, type AnthropicMessagesClient } from "./claude-llm-provider";

const { runAgentOrchestrator, InMemoryToolRegistry, GET_SERVICE_STATUS_CATALOG_ENTRY, LlmProviderError } =
  opspilotAgentRuntime;

/**
 * Drives the real, unmodified orchestrator through the real Claude adapter,
 * with only the HTTP transport replaced. Nothing here reaches the network and
 * no credential is involved: the fixtures below are the exact `Anthropic.Message`
 * shapes the SDK would return.
 */

type FakeMessage = Anthropic.Message & { readonly _request_id?: string | null };

const TOOL_CALL_ID = "toolu_integration_1";

function message(overrides: Partial<FakeMessage>): FakeMessage {
  return {
    id: "msg_integration",
    _request_id: "req_integration",
    container: null,
    content: [],
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1861,
      output_tokens: 81,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  };
}

const REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "The notification service is degraded, delaying outbound email.",
  rootCause: "get_service_status reported the notification service as DEGRADED.",
  customerImpact: "Customers experience delayed notification emails.",
  recommendedResolution: "Escalate to the notifications on-call engineer.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: TOOL_CALL_ID,
      sourceType: "TOOL_EXECUTION",
      finding: "get_service_status returned DEGRADED for notification-service.",
    },
  ],
  suggestedActions: [],
};

function investigationTurn(): FakeMessage {
  return message({
    content: [
      {
        type: "tool_use",
        id: TOOL_CALL_ID,
        name: "get_service_status",
        input: { serviceSlug: "notification-service" },
        caller: { type: "direct" },
      },
    ],
  });
}

function finalizationTurn(rawInput: unknown = REPORT): FakeMessage {
  return message({
    id: "msg_integration_2",
    _request_id: "req_integration_2",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "toolu_report_1",
        name: "submit_resolution_report",
        input: rawInput as Record<string, unknown>,
        caller: { type: "direct" },
      },
    ],
  });
}

function buildProvider(
  create: AnthropicMessagesClient["messages"]["create"],
  logger?: (event: unknown) => void,
) {
  return new ClaudeLlmProvider({
    client: { messages: { create } },
    model: "claude-sonnet-5",
    diagnosticTools: [
      {
        tool: GET_SERVICE_STATUS_CATALOG_ENTRY.tool,
        description: GET_SERVICE_STATUS_CATALOG_ENTRY.description,
      },
    ],
    configuredMaxRetries: 1,
    now: () => new Date("2026-07-28T00:00:00.000Z"),
    ...(logger !== undefined ? { logger: logger as never } : {}),
  });
}

function runOrchestrator(
  provider: ClaudeLlmProvider,
  extra: { readonly signal?: AbortSignal } = {},
) {
  return runAgentOrchestrator({
    provider,
    toolRegistry: new InMemoryToolRegistry([GET_SERVICE_STATUS_CATALOG_ENTRY.tool]),
    initialConversation: [
      { role: "ticket_context", ticketId: "TICKET-INT-1", summary: "Notification emails delayed" },
    ],
    ...extra,
  });
}

describe("orchestrator through the Claude adapter (mocked transport)", () => {
  it("completes the two-turn investigation → finalization flow", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(finalizationTurn());

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    expect(result.trace.map((event) => event.type)).toEqual([
      "TOOL_REQUESTED",
      "TOOL_COMPLETED",
      "REPORT_GENERATED",
    ]);
    // The report validates against the existing contract, unchanged.
    expect(result.report.category).toBe("SERVICE_DEGRADATION");
    expect(result.report.evidence[0]?.evidenceId).toBe(TOOL_CALL_ID);
  });

  it("drives exactly two provider turns, with the phase-appropriate tool policy", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(finalizationTurn());

    await runOrchestrator(buildProvider(create));

    expect(create).toHaveBeenCalledTimes(2);

    const first = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const second = create.mock.calls[1]?.[0] as Anthropic.MessageCreateParamsNonStreaming;

    expect(first.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(second.tool_choice).toEqual({
      type: "tool",
      name: "submit_resolution_report",
      disable_parallel_tool_use: true,
    });
    // The tool result from turn 1 is replayed into turn 2's conversation.
    expect(JSON.stringify(second.messages)).toContain(TOOL_CALL_ID);
  });

  it("rejects a report citing evidence the run never produced", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(
        finalizationTurn({
          ...REPORT,
          evidence: [
            {
              evidenceId: "toolu_invented_by_the_model",
              sourceType: "TOOL_EXECUTION",
              finding: "fabricated",
            },
          ],
        }),
      );

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_EVIDENCE_INVALID");
  });

  it("rejects a report that fails schema validation", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(finalizationTurn({ category: "SERVICE_DEGRADATION" }));

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("REPORT_SCHEMA_INVALID");
  });

  it("turns a malformed provider response into protocol_error, not a thrown error", async () => {
    // Two diagnostic tool calls in one turn is a protocol violation, and must
    // surface as an ordinary failed result rather than an exception.
    const create = vi.fn().mockResolvedValueOnce(
      message({
        content: [
          {
            type: "tool_use",
            id: "toolu_a",
            name: "get_service_status",
            input: { serviceSlug: "billing-service" },
            caller: { type: "direct" },
          },
          {
            type: "tool_use",
            id: "toolu_b",
            name: "get_service_status",
            input: { serviceSlug: "auth-service" },
            caller: { type: "direct" },
          },
        ],
      }),
    );

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
  });

  it("lets a transport failure propagate as LlmProviderError, never as a failed result", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new InternalServerError(500, { message: "x" }, "x", new Headers()));

    await expect(runOrchestrator(buildProvider(create))).rejects.toBeInstanceOf(LlmProviderError);
  });

  it("forwards the caller's cancellation signal to every provider turn (provider calls only)", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(finalizationTurn());
    const controller = new AbortController();

    await runOrchestrator(buildProvider(create), { signal: controller.signal });

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[1]).toEqual({ signal: controller.signal });
    }
  });

  it("emits sanitized metadata for each turn without any raw payload", async () => {
    const events: Record<string, unknown>[] = [];
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn())
      .mockResolvedValueOnce(finalizationTurn());

    await runOrchestrator(
      buildProvider(create, (event) => events.push(event as Record<string, unknown>)),
    );

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.provider).toBe("anthropic");
      expect(event.configuredMaxRetries).toBe(1);
      expect(event.pricingStatus).toBe("CURRENT");
      expect(event).not.toHaveProperty("attempts");
    }
    expect(JSON.stringify(events)).not.toContain("Notification emails delayed");
  });
});
