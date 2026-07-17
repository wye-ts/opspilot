import { describe, expect, it } from "vitest";

import { FakeLlmProvider, type FakeAgentScenario } from "./fake-llm-provider";

const usage = { inputTokens: 100, outputTokens: 20 };

const toolThenReportScenario: FakeAgentScenario = {
  id: "tool-then-report",
  turns: [
    {
      kind: "diagnostic_tool_requests",
      usage,
      requests: [
        {
          toolCallId: "call-1",
          toolName: "check_service_status",
          input: { serviceSlug: "notification-service" },
        },
      ],
    },
    {
      kind: "report_submission",
      usage,
      rawInput: {
        category: "SERVICE_DEGRADATION",
        summary: "Notification delivery is delayed for some customers.",
      },
    },
  ],
};

describe("FakeLlmProvider", () => {
  it("normalizes a single diagnostic tool request, then a report submission", async () => {
    const provider = new FakeLlmProvider(toolThenReportScenario);

    const first = await provider.runAgentTurn({ turnIndex: 0, conversation: [] });
    expect(first.type).toBe("diagnostic_tool_request");
    if (first.type !== "diagnostic_tool_request") {
      throw new Error("unreachable");
    }
    expect(first.request.toolName).toBe("check_service_status");

    const second = await provider.runAgentTurn({ turnIndex: 1, conversation: [] });
    expect(second.type).toBe("report_submission");
    if (second.type !== "report_submission") {
      throw new Error("unreachable");
    }
    expect(second.rawInput).toEqual({
      category: "SERVICE_DEGRADATION",
      summary: "Notification delivery is delayed for some customers.",
    });
  });

  it("deterministically replays the same scenario turn", async () => {
    const provider = new FakeLlmProvider(toolThenReportScenario);

    const first = await provider.runAgentTurn({ turnIndex: 0, conversation: [] });
    const second = await provider.runAgentTurn({ turnIndex: 0, conversation: [] });

    expect(second).toEqual(first);
  });

  it("normalizes multiple diagnostic tool requests in one turn to a protocol_error, without throwing", async () => {
    const scenario: FakeAgentScenario = {
      id: "multiple-tool-requests",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "check_service_status",
              input: { serviceSlug: "notification-service" },
            },
            {
              toolCallId: "call-2",
              toolName: "search_logs",
              input: { serviceSlug: "notification-service" },
            },
          ],
        },
      ],
    };
    const provider = new FakeLlmProvider(scenario);

    const result = await provider.runAgentTurn({ turnIndex: 0, conversation: [] });

    expect(result.type).toBe("protocol_error");
    if (result.type !== "protocol_error") {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
  });
});
