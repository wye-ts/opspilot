import {
  InMemoryToolRegistry,
  LlmProviderError,
  getServiceStatusTool,
  runAgentOrchestrator,
  FakeLlmProvider,
  type AgentTurnInput,
  type AgentConversationMessage,
  type LlmProvider,
} from "@opspilot/agent-runtime";
import type { InvestigationEventPayload } from "@opspilot/contracts";
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

  // Issue #99 §3 criterion 9 (retry-detectability): a completed retried run
  // must be distinguishable from an ordinary multi-tool run using only the
  // run's own persisted facts — providerCallsObserved (recorder.length here,
  // the same "count every invocation attempt" semantics
  // run-provider-usage-collector.ts persists) versus what its accepted
  // TOOL_REQUESTED events plus the finalization/report turn account for.
  //
  // An earlier draft of the #99 plan instead pointed at the server log's
  // provider_turn lines to establish this. Independent review correctly
  // rejected that: those lines carry no runId and no turnIndex, and an
  // A3-rejected response logs the IDENTICAL normalizedResultType as an
  // accepted one, so they cannot attribute a retry under concurrent runs.
  // This test proves the arithmetic instead, deterministically, from data
  // the run itself persists.
  describe("Issue #99 criterion 9 — retry-detectability arithmetic", () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const ticketContext: AgentConversationMessage = {
      role: "ticket_context",
      ticketId: "T-1",
      summary: "simulated",
    };
    const validReport = {
      category: "SERVICE_DEGRADATION",
      summary: "s",
      rootCause: "r",
      customerImpact: "c",
      recommendedResolution: "rr",
      confidence: 0.7,
      evidence: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK", finding: "f", supports: ["ROOT_CAUSE"] }],
      suggestedActions: [],
      evidenceState: "SUFFICIENT",
      recommendationDisposition: "ADVISORY",
    };

    // expectedFromLedger: for an ORDINARY run, providerCallsObserved equals
    // the accepted TOOL_REQUESTED count plus exactly one (the terminal
    // report-submission call, whether voluntary or forced finalization) —
    // every investigation turn produces either an accepted TOOL_REQUESTED or
    // is that terminal call. A retried run has one extra invocation (the
    // rejected turn) that produced neither, so the observed count exceeds
    // this expectation by exactly one.
    function retryDelta(providerCallsObserved: number, toolRequestedCount: number): number {
      return providerCallsObserved - (toolRequestedCount + 1);
    }

    it("is 0 for an ordinary (non-retried) completed run", async () => {
      const provider = new FakeLlmProvider({
        id: "ordinary-no-retry",
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
                  supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }],
                },
              },
            ],
          },
          { kind: "report_submission", usage, rawInput: validReport },
        ],
      });
      const recorder: RecordedProviderTurn[] = [];
      const wrapped = createRecordingProvider(provider, recorder);
      const emitted: InvestigationEventPayload[] = [];

      const result = await runAgentOrchestrator({
        provider: wrapped,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
        allowedRagChunkIds: new Set(["rag-chunk-1"]),
        emitLifecycleEvent: async (payload) => {
          emitted.push(payload);
        },
      });

      expect(result.status).toBe("completed");
      const toolRequestedCount = emitted.filter((e) => e.type === "TOOL_REQUESTED").length;
      expect(retryDelta(recorder.length, toolRequestedCount)).toBe(0);
    });

    it("is exactly 1 for a run whose A3 guard retried once and then completed", async () => {
      const provider = new FakeLlmProvider({
        id: "retried-once",
        turns: [
          {
            // Rejected: RAG evidence already allowed, so NO_EVIDENCE_YET trips A3.
            kind: "diagnostic_tool_requests",
            usage,
            requests: [
              {
                toolCallId: "trip-1",
                toolName: "get_service_status",
                input: { serviceSlug: "notification-service" },
                rawAssessment: {
                  evidenceState: "INSUFFICIENT",
                  continuationReason: "NO_EVIDENCE_YET",
                  supportedBy: [],
                },
              },
            ],
          },
          {
            // Corrected retry, accepted.
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
                  supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }],
                },
              },
            ],
          },
          { kind: "report_submission", usage, rawInput: validReport },
        ],
      });
      const recorder: RecordedProviderTurn[] = [];
      const wrapped = createRecordingProvider(provider, recorder);
      const emitted: InvestigationEventPayload[] = [];

      const result = await runAgentOrchestrator({
        provider: wrapped,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
        allowedRagChunkIds: new Set(["rag-chunk-1"]),
        emitLifecycleEvent: async (payload) => {
          emitted.push(payload);
        },
      });

      expect(result.status).toBe("completed");
      const toolRequestedCount = emitted.filter((e) => e.type === "TOOL_REQUESTED").length;
      // 3 attempts observed (rejected + retry + report), but only 1 accepted
      // TOOL_REQUESTED — the retry is exactly the +1 discrepancy.
      expect(recorder.length).toBe(3);
      expect(toolRequestedCount).toBe(1);
      expect(retryDelta(recorder.length, toolRequestedCount)).toBe(1);
    });
  });
});
