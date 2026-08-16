import {
  InMemoryToolRegistry,
  LlmProviderError,
  getServiceStatusTool,
  runAgentOrchestrator,
  type AgentTurnInput,
  type AgentConversationMessage,
  type LlmProvider,
} from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";

import { buildObservedFacts } from "./observed-facts";
import { createRecordingProvider, type RecordedProviderTurn } from "./recording-provider";

// One deterministic investigation turn the wrapper is asked to record. turnIndex
// and phase are the orchestrator-supplied identity of the attempt; maxOutputTokens,
// conversation, and diagnosticCallsRemaining are whatever the orchestrator passes —
// the wrapper must not interpret them.
const INVESTIGATION_TURN: AgentTurnInput = {
  turnIndex: 3,
  phase: "INVESTIGATION",
  maxOutputTokens: 1024,
  conversation: [],
  diagnosticCallsRemaining: 3,
};

describe("createRecordingProvider", () => {
  it("A: records a successful call once, returns the result unchanged, and records the returned usage", async () => {
    const successTurn = {
      type: "protocol_error",
      providerRequestId: "req-1",
      usage: { inputTokens: 12, outputTokens: 34 },
      code: "PROVIDER_PROTOCOL_INVALID",
      message: "sentinel",
    } as const;
    let calls = 0;
    const provider: LlmProvider = {
      async runAgentTurn(input) {
        calls += 1;
        expect(input).toBe(INVESTIGATION_TURN);
        return successTurn;
      },
    };
    const recorder: RecordedProviderTurn[] = [];
    const wrapped = createRecordingProvider(provider, recorder);

    const result = await wrapped.runAgentTurn(INVESTIGATION_TURN);

    // Delegate called exactly once, result passed through by object identity,
    // and exactly one record carrying the returned usage.
    expect(calls).toBe(1);
    expect(result).toBe(successTurn);
    expect(recorder).toEqual([
      { turnIndex: 3, phase: "INVESTIGATION", usage: { inputTokens: 12, outputTokens: 34 } },
    ]);
  });

  it("B: a successful result with no reported usage is recorded as deterministic zero usage", async () => {
    const noUsageTurn = {
      type: "protocol_error",
      providerRequestId: "req-2",
      code: "PROVIDER_PROTOCOL_INVALID",
      message: "sentinel",
    } as const;
    const provider: LlmProvider = {
      async runAgentTurn() {
        return noUsageTurn;
      },
    };
    const recorder: RecordedProviderTurn[] = [];
    const wrapped = createRecordingProvider(provider, recorder);

    await wrapped.runAgentTurn(INVESTIGATION_TURN);

    expect(recorder).toEqual([
      { turnIndex: 3, phase: "INVESTIGATION", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("C: still counts an attempt whose delegate then throws, propagating the same error by identity with zero observed usage", async () => {
    const thrown = new LlmProviderError("UNKNOWN", "simulated provider failure");
    let calls = 0;
    const provider: LlmProvider = {
      async runAgentTurn() {
        calls += 1;
        throw thrown;
      },
    };
    const recorder: RecordedProviderTurn[] = [];
    const wrapped = createRecordingProvider(provider, recorder);

    // The exact thrown error object propagates — never swallowed, remapped,
    // wrapped, retried, or re-invoked.
    await expect(wrapped.runAgentTurn(INVESTIGATION_TURN)).rejects.toBe(thrown);
    expect(calls).toBe(1);
    expect(recorder).toEqual([
      { turnIndex: 3, phase: "INVESTIGATION", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("D: a one-attempt provider failure observed through the orchestrator is counted — providerTurnsUsed=1, providerCalls=1, zero tokens, unchanged failed-stage/error", async () => {
    const thrown = new LlmProviderError("UNKNOWN", "simulated provider failure");
    const provider: LlmProvider = {
      async runAgentTurn() {
        throw thrown;
      },
    };
    const recorder: RecordedProviderTurn[] = [];
    const wrapped = createRecordingProvider(provider, recorder);
    const ticketContext: AgentConversationMessage = {
      role: "ticket_context",
      ticketId: "T-1",
      summary: "simulated",
    };

    const result = await runAgentOrchestrator({
      provider: wrapped,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    // The orchestrator maps the thrown provider error to an ordinary failed
    // result exactly as before the fix — the correction only touches the
    // observation recorder, never production runtime behavior.
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
    expect(result.failedStage).toBe("AGENT_ANALYSIS");

    const facts = buildObservedFacts(result, [], [], recorder);

    // The attempt that threw is no longer silently dropped from the
    // observation, and no tokens are fabricated for it.
    expect(facts.runStatus).toBe("failed");
    expect(facts.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(facts.failedStage).toBe("AGENT_ANALYSIS");
    expect(facts.report).toBeNull();
    expect(facts.investigation.providerTurnsUsed).toBe(1);
    expect(facts.investigation.usage.providerCalls).toBe(1);
    expect(facts.investigation.usage.inputTokens).toBe(0);
    expect(facts.investigation.usage.outputTokens).toBe(0);
  });
});
