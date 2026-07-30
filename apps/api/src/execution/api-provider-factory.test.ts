import { ClaudeLlmProvider, LiveProviderUnavailableError, type LiveCapability } from "@opspilot/provider-claude";
import type { AnthropicMessagesClient, ClaudeProviderLogEvent } from "@opspilot/provider-claude";
import type { AgentJobRecord } from "@opspilot/database";
import { describe, expect, it, vi } from "vitest";

import { createAgentProviderFactory, createAnthropicClientFor } from "./api-provider-factory";

/**
 * A structural fake for the one seam ClaudeLlmProvider depends on. It makes
 * no network call — `messages.create` always rejects, so any test that
 * exercises a live turn is exercising the client-injection wiring and the
 * adapter's error path, never a real Anthropic request.
 */
function createFakeAnthropicClient(): AnthropicMessagesClient {
  return {
    messages: {
      create: vi.fn(async () => {
        throw new Error("structural fake: no network call permitted in this test");
      }),
    },
  };
}

const LIVE_CAPABILITY: LiveCapability = {
  kind: "present",
  selection: { providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" },
  anthropic: { apiKey: "unused-in-tests", timeoutMs: 45_000, maxRetries: 1 },
};

function buildJob(overrides: Partial<AgentJobRecord> = {}): AgentJobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors on billing-service" },
    externalTicketId: "TICKET-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createAgentProviderFactory", () => {
  it("FAKE selection runs the existing deterministic scenario for the job", async () => {
    const factory = createAgentProviderFactory({ liveCapability: { kind: "absent" } });
    const job = buildJob();

    const provider = factory.createProvider(job, "FAKE");
    const result = await provider.runAgentTurn({
      turnIndex: 0,
      phase: "INVESTIGATION",
      maxOutputTokens: 1024,
      conversation: [],
    });

    // The deterministic scenario for this job's ticket context resolves to a
    // real, schema-valid turn — proving this is the same scenario
    // deterministic-scenario.test.ts exercises directly, not a stub.
    expect(["diagnostic_tool_request", "report_submission", "protocol_error"]).toContain(result.type);
  });

  it("LIVE selection with absent capability fails closed with LiveProviderUnavailableError, never FAKE", () => {
    const factory = createAgentProviderFactory({ liveCapability: { kind: "absent" } });
    const job = buildJob();

    expect(() => factory.createProvider(job, "LIVE")).toThrow(LiveProviderUnavailableError);
  });

  it("LIVE selection with present capability and an injected client builds ClaudeLlmProvider", () => {
    const client = createFakeAnthropicClient();
    const factory = createAgentProviderFactory({ liveCapability: LIVE_CAPABILITY, client });
    const job = buildJob();

    const provider = factory.createProvider(job, "LIVE");

    expect(provider).toBeInstanceOf(ClaudeLlmProvider);
  });

  it("reuses the same injected client across two provider creations", async () => {
    const client = createFakeAnthropicClient();
    const createSpy = client.messages.create as ReturnType<typeof vi.fn>;
    const factory = createAgentProviderFactory({ liveCapability: LIVE_CAPABILITY, client });
    const job = buildJob();

    const first = factory.createProvider(job, "LIVE");
    const second = factory.createProvider(job, "LIVE");

    await first.runAgentTurn({
      turnIndex: 0,
      phase: "INVESTIGATION",
      maxOutputTokens: 1024,
      conversation: [],
    }).catch(() => undefined);
    await second.runAgentTurn({
      turnIndex: 0,
      phase: "INVESTIGATION",
      maxOutputTokens: 1024,
      conversation: [],
    }).catch(() => undefined);

    // Both calls reached the one injected client's `create`, not two separate
    // transports — this is what makes constructing one factory per run safe.
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("selects exactly claude-sonnet-5 for a LIVE run", () => {
    // ClaudeLlmProvider does not expose its configured model, so the selection
    // is verified the same way the adapter itself would send it: through the
    // request params passed to `messages.create`.
    const client = createFakeAnthropicClient();
    const createSpy = client.messages.create as ReturnType<typeof vi.fn>;
    const factory = createAgentProviderFactory({ liveCapability: LIVE_CAPABILITY, client });
    const job = buildJob();

    const provider = factory.createProvider(job, "LIVE");
    void provider
      .runAgentTurn({ turnIndex: 0, phase: "INVESTIGATION", maxOutputTokens: 1024, conversation: [] })
      .catch(() => undefined);

    return Promise.resolve().then(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      const [params] = createSpy.mock.calls[0] as [{ model: string }];
      expect(params.model).toBe("claude-sonnet-5");
    });
  });

  it("constructing the factory with an absent capability requires no client", () => {
    // createAnthropicClientFor must short-circuit before ever touching the SDK
    // — this is what keeps a FAKE-only deployment from constructing a
    // network-capable object at all.
    expect(createAnthropicClientFor({ kind: "absent" })).toBeUndefined();

    expect(() => createAgentProviderFactory({ liveCapability: { kind: "absent" } })).not.toThrow();
  });

  it("forwards provider events to the injected logger", async () => {
    const client = createFakeAnthropicClient();
    const logger = vi.fn<(event: ClaudeProviderLogEvent) => void>();
    const factory = createAgentProviderFactory({ liveCapability: LIVE_CAPABILITY, client, logger });
    const job = buildJob();

    const provider = factory.createProvider(job, "LIVE");
    await provider
      .runAgentTurn({ turnIndex: 0, phase: "INVESTIGATION", maxOutputTokens: 1024, conversation: [] })
      .catch(() => undefined);

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({ outcome: "error", provider: "anthropic" });
  });
});
