import type Anthropic from "@anthropic-ai/sdk";
import { InternalServerError } from "@anthropic-ai/sdk";
import type { ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  runAgentOrchestrator,
  InMemoryToolRegistry,
  GET_SERVICE_STATUS_CATALOG_ENTRY,
  LlmProviderError,
} from "@opspilot/agent-runtime";

import { ClaudeLlmProvider, type AnthropicMessagesClient } from "./claude-llm-provider";

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
  evidenceState: "SUFFICIENT",
  suggestedActions: [],
};

// A report that cites exactly the toolCallIds that actually completed, as the
// orchestrator's evidence validator requires (it rejects evidence that does not
// reference a completed TOOL_EXECUTION id).
function reportCiting(...evidenceIds: string[]): ResolutionReport {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "The notification service is degraded, delaying outbound email.",
    rootCause: "get_service_status reported the notification service as DEGRADED.",
    customerImpact: "Customers experience delayed notification emails.",
    recommendedResolution: "Escalate to the notifications on-call engineer.",
    confidence: 0.8,
    evidence: evidenceIds.map((evidenceId) => ({
      evidenceId,
      sourceType: "TOOL_EXECUTION",
      finding: `get_service_status returned DEGRADED for notification-service (${evidenceId}).`,
    })),
    evidenceState: "SUFFICIENT",
    suggestedActions: [],
  };
}

// Issue #58 Checkpoint B: the assessment a first diagnostic request must
// carry before any evidence exists — INSUFFICIENT / NO_EVIDENCE_YET with an
// empty supportedBy, exactly the run-state-consistent claim the orchestrator's
// V0 schema + A3 run-state guards require. Later requests carry a
// STATUS_UNRESOLVED assessment citing the already-completed tool call(s), so
// every fixture is consistent with the evidence available BEFORE the request.
const NO_EVIDENCE_YET_ASSESSMENT = {
  evidenceState: "INSUFFICIENT",
  continuationReason: "NO_EVIDENCE_YET",
  supportedBy: [],
} as const;

// toolCallId defaults to TOOL_CALL_ID so single-investigation-turn tests keep
// their existing fixtures; multi-turn tests pass distinct ids, because the
// runtime rejects a reused diagnostic tool-call identity within one run. The
// tool_use input is the §5/§6 nested wrapper { evidenceAssessment, toolInput }.
function investigationTurn(
  toolCallId: string = TOOL_CALL_ID,
  assessment: unknown = NO_EVIDENCE_YET_ASSESSMENT,
): FakeMessage {
  return message({
    content: [
      {
        type: "tool_use",
        id: toolCallId,
        name: "get_service_status",
        input: {
          evidenceAssessment: assessment,
          toolInput: { serviceSlug: "notification-service" },
        },
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

  it("drives exactly four provider turns — three investigation turns, then the reserved finalization turn — with the phase-appropriate tool policy", async () => {
    // Under the #57 bound (MAX_PROVIDER_TURNS = 4, MAX_DIAGNOSTIC_TOOL_CALLS = 3)
    // the provider is called once per turn: turns 0-2 are investigation turns
    // (tool_choice auto), and turn 3 is the reserved finalization turn, which
    // forces submit_resolution_report.
    //
    // The three investigation turns carry DISTINCT toolCallIds (call-1/2/3),
    // as the contract and the runtime's duplicate-identity guard require, and
    // the finalization report cites exactly the successful distinct ids the
    // evidence validator accepts. Each request's assessment is consistent with
    // the evidence available BEFORE it: call-1 claims NO_EVIDENCE_YET (nothing
    // run yet), call-2 and call-3 cite the already-completed call(s).
    const create = vi
      .fn()
      .mockResolvedValueOnce(investigationTurn("call-1", NO_EVIDENCE_YET_ASSESSMENT))
      .mockResolvedValueOnce(
        investigationTurn("call-2", {
          evidenceState: "INSUFFICIENT",
          continuationReason: "STATUS_UNRESOLVED",
          supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
        }),
      )
      .mockResolvedValueOnce(
        investigationTurn("call-3", {
          evidenceState: "INSUFFICIENT",
          continuationReason: "STATUS_UNRESOLVED",
          supportedBy: [
            { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
          ],
        }),
      )
      .mockResolvedValueOnce(finalizationTurn(reportCiting("call-1", "call-2", "call-3")));

    await runOrchestrator(buildProvider(create));

    expect(create).toHaveBeenCalledTimes(4);

    const investigationCalls = create.mock.calls.slice(0, 3);
    for (const [params] of investigationCalls) {
      expect((params as Anthropic.MessageCreateParamsNonStreaming).tool_choice).toEqual({
        type: "auto",
        disable_parallel_tool_use: true,
      });
    }

    const finalizationParams = create.mock.calls[3]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(finalizationParams.tool_choice).toEqual({
      type: "tool",
      name: "submit_resolution_report",
      disable_parallel_tool_use: true,
    });
    // The tool results from all three investigation turns are replayed into the
    // reserved finalization turn's conversation, each carrying its own id.
    const finalizationConversation = JSON.stringify(finalizationParams.messages);
    for (const callId of ["call-1", "call-2", "call-3"]) {
      expect(finalizationConversation).toContain(callId);
    }

    // §10: budget wiring — each investigation turn sees the remaining capacity
    // shrink (3 → 2 → 1), and the FINALIZATION turn carries 0, all in the
    // investigation-only guidance block.
    const systems = create.mock.calls.map(
      (call) => (call[0] as Anthropic.MessageCreateParamsNonStreaming).system,
    );
    expect(String(systems[0])).toContain("diagnosticCallsRemaining is 3 this turn.");
    expect(String(systems[1])).toContain("diagnosticCallsRemaining is 2 this turn.");
    expect(String(systems[2])).toContain("diagnosticCallsRemaining is 1 this turn.");
    expect(String(systems[3])).not.toContain("diagnosticCallsRemaining is");
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
    // surface as an ordinary failed result rather than an exception. Both
    // blocks carry structurally valid wrappers so the violation is the COUNT,
    // not a malformed split.
    const create = vi.fn().mockResolvedValueOnce(
      message({
        content: [
          {
            type: "tool_use",
            id: "toolu_a",
            name: "get_service_status",
            input: {
              evidenceAssessment: NO_EVIDENCE_YET_ASSESSMENT,
              toolInput: { serviceSlug: "billing-service" },
            },
            caller: { type: "direct" },
          },
          {
            type: "tool_use",
            id: "toolu_b",
            name: "get_service_status",
            input: {
              evidenceAssessment: NO_EVIDENCE_YET_ASSESSMENT,
              toolInput: { serviceSlug: "auth-service" },
            },
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

  it("turns a transport failure into a failed result the caller can finalize", async () => {
    // PR 6B1 deliberately inverted this. Through PR 6A the orchestrator let an
    // LlmProviderError propagate, because the only provider in the persisted
    // path was deterministic and a throw genuinely meant "should never happen".
    //
    // Once a live provider is reachable from the API that is no longer true: an
    // auth failure, a rate limit, a timeout, or a cancellation is the ordinary
    // outcome of a network call. Propagating it left AgentRunService no choice
    // but AGENT_EXECUTION_CRASHED, which does not finalize — stranding the
    // agent_runs row in RUNNING forever with no recovery path.
    //
    // The adapter still *throws* LlmProviderError; what changed is that the
    // orchestrator now catches it. That keeps the adapter's contract intact
    // while making the failure persistable.
    const create = vi
      .fn()
      .mockRejectedValue(new InternalServerError(500, { message: "x" }, "x", new Headers()));

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    // The sanitized, category-keyed message — never the SDK's own text.
    expect(result.message).toBe("The Anthropic API returned a server error.");
  });

  it("classifies an unrecognized transport error rather than letting it escape", async () => {
    // The adapter is a classification boundary: anything the transport throws
    // becomes an LlmProviderError, with UNKNOWN as the fallback category. So a
    // TypeError raised inside the SDK is recorded as an unavailable provider,
    // not surfaced as a crash — which is the behaviour you want, since a
    // malformed response from a vendor is not a defect in this codebase.
    //
    // The complementary property — that a defect raised by the *orchestrator's
    // own* collaborators still propagates — is asserted one layer up, in
    // agent-runtime's agent-orchestrator.test.ts, where the provider throws
    // directly without passing through this adapter.
    const create = vi.fn().mockRejectedValue(new TypeError("not a provider failure"));

    const result = await runOrchestrator(buildProvider(create));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
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
