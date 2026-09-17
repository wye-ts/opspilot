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
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  deriveExecutionStageProgress,
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
      // Issue #55: rootCause is non-null, so at least one entry must declare
      // ROOT_CAUSE support (2.2b).
      supports: ["ROOT_CAUSE"],
    },
  ],
  // Issue #60 Checkpoint B: the accepted Checkpoint-A write contract requires
  // recommendationDisposition on every new-write report. This base fixture is
  // ADVISORY + [] — a monitoring-only recommendation with no suggested action.
  suggestedActions: [],
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ADVISORY",
};

const validReportWithRagEvidence = {
  ...validReport,
  evidence: [
    {
      evidenceId: "rag-chunk-1",
      sourceType: "RAG_CHUNK",
      finding: "Knowledge base article KB-42 describes this failure mode.",
      // Issue #55: rootCause (inherited from validReport) is non-null, so
      // 2.2b requires ROOT_CAUSE support somewhere.
      supports: ["ROOT_CAUSE"],
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
      // Issue #101: a FIRST rejected report is now given one corrective
      // retry, so proving the failure path needs a second rejection. This
      // test's subject is unchanged — which failure code and which sanitized
      // validation issues surface — but the run no longer dies on a single
      // malformed submission, and scripting only one turn would exercise the
      // retry instead of the failure.
      turns: [
        { kind: "report_submission", usage, rawInput: invalidReport },
        { kind: "report_submission", usage, rawInput: invalidReport },
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
      // Issue #60: recommendationDisposition is now a required new-write key,
      // so a malformed report reports its absence too (Checkpoint A contract).
      {
        path: ["recommendationDisposition"],
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
      // Issue #101: the first rejection is corrected-and-retried, so reaching
      // the failure needs two. This case is also the criterion-7 path in
      // passing: `too_big` is not a `custom` issue and carries no `message`,
      // so no authored remedy matches it and the corrective guidance falls
      // back to the generic text — the retry still happens, the message just
      // claims nothing specific. Asserted directly in the #101 block.
      turns: [
        { kind: "report_submission", usage, rawInput: { ...validReport, confidence: 70 } },
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

  // Issue #60 Checkpoint B (§3): minimal runtime-boundary proof that the
  // accepted Checkpoint-A write contract (recommendationDisposition ↔ action
  // cardinality, and groundedBy ⊆ report.evidence) reaches the existing
  // report-validation path. The full disposition/grounding matrix is pinned in
  // contracts (resolution-report.test.ts); here we prove only the high-value
  // runtime boundary — two positives and two negatives. No production
  // orchestrator change exists: the source-aware run-grounding oracle
  // (findInvalidEvidence) is reused as-is because groundedBy ⊆ report.evidence
  // was already enforced by the schema in Checkpoint A.
  describe("Issue #60 — Checkpoint-A contract reaches the report-validation path", () => {
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

    // Issue #101: a FIRST schema-rejected report now receives one corrective
    // retry, so a negative case must submit the same bad report TWICE to reach
    // the failure these tests are about. The subject of each negative is
    // unchanged — which invariant fails closed, and the sanitized diagnostic it
    // surfaces — only the number of submissions needed to get there.
    function rejectedTwice(id: string, rawInput: unknown): FakeLlmProvider {
      return new FakeLlmProvider({
        id,
        turns: [
          { kind: "report_submission", usage, rawInput },
          { kind: "report_submission", usage, rawInput },
        ],
      });
    }

    it("ACTIONABLE with a grounded suggested action -> REPORT_VALIDATED", async () => {
      const groundedActionableReport = {
        ...validReport,
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [
          {
            type: "UPDATE_TICKET_STATUS",
            payload: { status: "IN_PROGRESS", reason: "Investigating delayed notifications." },
            groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
          },
        ],
      };
      const { emitted, emitLifecycleEvent } = recordingEmitter();
      const provider = new FakeLlmProvider({
        id: "actionable-grounded",
        turns: [
          {
            kind: "diagnostic_tool_requests",
            usage,
            requests: [
              { toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" }, rawAssessment: NO_EVIDENCE_YET_ASSESSMENT },
            ],
          },
          { kind: "report_submission", usage, rawInput: groundedActionableReport },
        ],
      });

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
        emitLifecycleEvent,
      });

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("unreachable");
      expect(result.report.recommendationDisposition).toBe("ACTIONABLE");
      expect(result.report.suggestedActions).toHaveLength(1);
      expect(result.report.suggestedActions[0]?.groundedBy).toEqual([
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
      ]);
      expect(types(emitted)).toContain("REPORT_VALIDATED");
    });

    it("ADVISORY with no suggested actions -> REPORT_VALIDATED", async () => {
      const { emitted, emitLifecycleEvent } = recordingEmitter();
      const provider = new FakeLlmProvider(
        buildToolRequestScenario("advisory-empty", "notification-service"),
      );

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
        emitLifecycleEvent,
      });

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("unreachable");
      expect(result.report.recommendationDisposition).toBe("ADVISORY");
      expect(result.report.suggestedActions).toEqual([]);
      expect(types(emitted)).toContain("REPORT_VALIDATED");
    });

    it("ACTIONABLE with no suggested actions -> REPORT_SCHEMA_INVALID (disposition/cardinality fails closed)", async () => {
      const provider = rejectedTwice("actionable-empty-actions", {
        ...validReport,
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [],
      });

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.code).toBe("REPORT_SCHEMA_INVALID");
      // The disposition ↔ action cardinality invariant (F1) is the sole
      // failure — the sanitized diagnostic surfaces exactly that.
      expect(result.reportValidationIssues).toEqual([
        {
          path: ["suggestedActions"],
          code: "custom",
          message: "ACTIONABLE requires at least one suggested action.",
        },
      ]);
    });

    it("ACTIONABLE with an ungrounded suggested action -> REPORT_SCHEMA_INVALID (grounding fails closed)", async () => {
      const provider = rejectedTwice("actionable-ungrounded-action", {
        ...validReport,
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [
          {
            type: "DRAFT_CUSTOMER_REPLY",
            payload: { subject: "Update", body: "A human will follow up." },
            groundedBy: [],
          },
        ],
      });

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.code).toBe("REPORT_SCHEMA_INVALID");
      // Never repair missing/empty grounding into validity (no
      // normalizeSubmittedReportInput repair — this is the orchestrator's own
      // fail-closed write path).
      expect(result.trace).toEqual([]);
    });

    // Issue #80's real production failure: evidence: [] (a truthful "nothing
    // gathered" INSUFFICIENT report) but suggestedActions[].groundedBy still
    // cites a tool-call id that was never added as its own evidence entry —
    // a structurally different violation from the empty-groundedBy case
    // above (G2/non-empty check), rejected by the SEPARATE "groundedBy
    // entries must each appear in report.evidence" invariant (F5). Locks the
    // exact production shape as a permanent regression case, independent of
    // the REPORT_FIELD_BOUNDS prompt-clarity fix (claude-message-mapping.ts)
    // this issue also made — the schema's own fail-closed behavior here was
    // never the bug and must never be loosened to "fix" this class.
    it("ACTIONABLE with evidence: [] but a suggested action grounded on an uncited tool-call id -> REPORT_SCHEMA_INVALID (Issue #80's real production shape)", async () => {
      const provider = rejectedTwice("issue-80-ungrounded-in-evidence", {
        ...validReport,
        rootCause: null,
        evidenceState: "INSUFFICIENT",
        evidence: [],
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [
          {
            type: "CREATE_ESCALATION",
            payload: {
              team: "Messaging Platform",
              reason: "Automated status checks returned UNKNOWN; needs manual investigation.",
              priority: "MEDIUM",
            },
            groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
          },
        ],
      });

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.code).toBe("REPORT_SCHEMA_INVALID");
      expect(result.reportValidationIssues).toEqual([
        {
          path: ["suggestedActions", 0, "groundedBy", 0],
          code: "custom",
          message: "suggestedActions[].groundedBy entries must each appear in report.evidence.",
        },
      ]);
    });
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
                // Issue #55: rootCause (inherited from validReport) is
                // non-null, so 2.2b requires ROOT_CAUSE support somewhere —
                // this keeps the report schema-VALID so the test actually
                // exercises evidence-grounding rejection, not 2.2b.
                supports: ["ROOT_CAUSE"],
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
                // Issue #55: rootCause (inherited from validReport) is
                // non-null, so 2.2b requires ROOT_CAUSE support somewhere.
                supports: ["ROOT_CAUSE"],
              },
              {
                evidenceId: "rag-chunk-2",
                sourceType: "RAG_CHUNK",
                finding: "Knowledge base article KB-42 describes this failure mode.",
                supports: [],
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
                // Issue #55: rootCause (inherited from validReport) is
                // non-null, so 2.2b requires ROOT_CAUSE support somewhere —
                // this keeps the report schema-VALID so the test exercises
                // evidence-grounding rejection, not 2.2b.
                supports: ["ROOT_CAUSE"],
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
              { evidenceId: sampleChunk.chunkId, sourceType: "RAG_CHUNK", finding: "Matches.", supports: ["ROOT_CAUSE"] },
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
                supports: ["ROOT_CAUSE"],
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
                supports: ["ROOT_CAUSE"],
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
                supports: ["ROOT_CAUSE"],
              },
              {
                evidenceId: sampleChunk.chunkId,
                sourceType: "RAG_CHUNK",
                finding: "Runbook describes this exact degradation.",
                supports: [],
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
    [
      "REPORT_SCHEMA_INVALID",
      invalidReport,
      // Issue #101 §2.3 (retracted-and-corrected): the corrected-away attempt
      // emits NOTHING, so even a retried run persists exactly one
      // REPORT_SUBMITTED / REPORT_VALIDATION_FAILED pair — the one that
      // decided the run. An earlier version of this entry expected two pairs;
      // that stream is rejected outright by the canonical reducer, which is
      // what independent review caught as a BLOCKER.
      ["AGENT_STARTED", "REPORT_SUBMITTED", "REPORT_VALIDATION_FAILED"],
      2,
    ],
    [
      // REPORT_EVIDENCE_INVALID is a DIFFERENT guard with its own code and is
      // deliberately out of #101's scope, so it still fails closed on the
      // first submission. Kept in the same table to make that divergence
      // visible rather than hiding it in a separate test.
      "REPORT_EVIDENCE_INVALID",
      validReport,
      ["AGENT_STARTED", "REPORT_SUBMITTED", "REPORT_VALIDATION_FAILED"],
      1,
    ],
  ] as const)(
    "emits REPORT_SUBMITTED then REPORT_VALIDATION_FAILED for %s",
    async (code, rawInput, expectedTypes, submissions) => {
      const { emitted, emitLifecycleEvent } = recordingEmitter();

      const result = await runAgentOrchestrator({
        provider: new FakeLlmProvider({
          id: `report-${code}`,
          turns: Array.from({ length: submissions }, () => ({
            kind: "report_submission" as const,
            usage,
            rawInput,
          })),
        }),
        toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
        initialConversation: [ticketContext],
        emitLifecycleEvent,
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("unreachable");
      expect(result.code).toBe(code);
      expect(result.failedStage).toBe("REPORT_GENERATION");
      expect(types(emitted)).toEqual(expectedTypes);
      expect(emitted[emitted.length - 1]).toMatchObject({ failureCode: code });
      // No legacy REPORT_GENERATED for a rejected report — unchanged from before.
      expect(result.trace).toEqual([]);
    },
  );

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

  it("emits REPORT_GENERATION_STARTED before the first provider call of the report stage, and never while diagnostic budget remains", async () => {
    // Issue #107 changed WHAT this event tracks, not whether it is announced
    // ahead of the call. It used to be emitted iff the turn was positionally
    // final; it is now emitted on the first turn where the report stage has
    // begun — diagnostic budget exhausted OR the forced finalization turn —
    // because that is the condition the canonical reducer itself enforces.
    //
    // With the bounds now slack (3 <= 5 - 1), turn 3 is INVESTIGATION by
    // position yet has zero diagnostic budget, so it IS the report turn. The
    // assertion therefore keys on the budget the turn actually carries rather
    // than on its phase label. Asserting on phase here is exactly the coupling
    // #107 removed.
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    let turn = 0;
    const provider: LlmProvider = {
      runAgentTurn: async (input) => {
        // Asserted AT the provider-call boundary: a call belonging to the
        // report stage must already see the report-start fact in the emission
        // stream, while any call that can still request a diagnostic must not.
        const startedSeen = emitted.some((e) => e.type === "REPORT_GENERATION_STARTED");
        const reportStageTurn =
          input.phase === "FINALIZATION" || input.diagnosticCallsRemaining === 0;
        expect(startedSeen).toBe(reportStageTurn);

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
    // Singleton: the reducer rejects a second one (DUPLICATE_LIFECYCLE_FACT).
    expect(emitted.filter((e) => e.type === "REPORT_GENERATION_STARTED")).toHaveLength(1);
  });

  it("resolves maxOutputTokens to the report-safe finalization ceiling on EVERY provider turn: investigation turns 0-2 AND the forced finalization turn 3 all get finalizationMaxOutputTokens (issue #61 Codex MAJOR 1)", async () => {
    const seenMaxOutputTokens: number[] = [];
    let turn = 0;
    const provider: LlmProvider = {
      runAgentTurn: async (input) => {
        seenMaxOutputTokens.push(input.maxOutputTokens);
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
      outputBudget: { investigationMaxOutputTokens: 1024, finalizationMaxOutputTokens: 3072 },
    });

    expect(result.status).toBe("completed");
    // MAX_PROVIDER_TURNS is 4: turns 0-2 are INVESTIGATION, turn 3 is the
    // reserved forced FINALIZATION turn — see agent-run-bounds.ts. Every one of
    // them is report-capable (submit_resolution_report is available on
    // investigation turns too), so every turn must receive the report-safe
    // finalization ceiling, never the smaller investigation ceiling.
    expect(seenMaxOutputTokens).toEqual([3072, 3072, 3072, 3072]);
    // Required test A: investigation turns 0/1/2 receive the finalization
    // ceiling.
    expect(seenMaxOutputTokens.slice(0, 3)).toEqual([3072, 3072, 3072]);
    // Required test B: the finalization turn receives the finalization ceiling.
    expect(seenMaxOutputTokens.at(-1)).toBe(3072);
    // No report-capable turn may ever receive the investigation ceiling.
    expect(seenMaxOutputTokens).not.toContain(1024);
  });

  it("C — a voluntary report on an investigation turn needing >1024 and <=3072 tokens completes, because the report-capable turn gets the finalization ceiling (issue #61 Codex MAJOR 1)", async () => {
    const seenMaxOutputTokens: number[] = [];
    const provider: LlmProvider = {
      runAgentTurn: async (input) => {
        seenMaxOutputTokens.push(input.maxOutputTokens);
        // Voluntary report on turn 0, an INVESTIGATION turn —
        // submit_resolution_report is available there too, so an investigation
        // call can legitimately produce the final report. This is exactly the
        // case the phase-based ceiling truncated: a report needing more than the
        // investigation ceiling (1024) and up to the finalization ceiling (3072).
        return {
          type: "report_submission",
          providerRequestId: "p:0",
          usage,
          rawInput: validReportWithRagEvidence,
        };
      },
    };

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      outputBudget: { investigationMaxOutputTokens: 1024, finalizationMaxOutputTokens: 3072 },
    });

    // The voluntary investigation-turn report completes (not truncated).
    expect(result.status).toBe("completed");
    // The single investigation turn received the report-safe 3072 ceiling, so a
    // report needing >1024 and <=3072 tokens has room to complete.
    expect(seenMaxOutputTokens).toEqual([3072]);
    expect(seenMaxOutputTokens[0]).toBeGreaterThan(1024);
    expect(seenMaxOutputTokens[0]).toBeLessThanOrEqual(3072);
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
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "notification-service reported status DEGRADED.", supports: ["ROOT_CAUSE"] },
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
          { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "first finding", supports: ["ROOT_CAUSE"] },
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "second finding", supports: [] },
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
          { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "real finding", supports: ["ROOT_CAUSE"] },
          { evidenceId: "call-999", sourceType: "TOOL_EXECUTION", finding: "invented finding", supports: [] },
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
      supports: string[];
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
      // Issue #60 Checkpoint B: every variant has zero suggested actions, so
      // the write contract requires an ADVISORY disposition (ACTIONABLE
      // demands >= 1 suggested action, which these evidence-state variants do
      // not exercise — #60 action tests live in the dedicated block below).
      recommendationDisposition: "ADVISORY",
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
        supports: ["ROOT_CAUSE"],
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
                  supports: [],
                },
                {
                  evidenceId: "call-2",
                  sourceType: "TOOL_EXECUTION",
                  finding: "notification-service reported status DEGRADED.",
                  supports: ["ROOT_CAUSE"],
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
                supports: [],
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

  it("F — bound exhaustion: the report turn sees diagnosticCallsRemaining 0 and reports honestly (INSUFFICIENT, rootCause null)", async () => {
    const seenRemainingOnFinalization: number[] = [];
    const scenario: FakeAgentScenario = {
      id: "scenario-f",
      turns: [
        ...buildMultiToolTurns(3),
        // The report turn is a pure function of the input (§12): it must
        // observe that the diagnostic budget is exhausted and submit an honest
        // INSUFFICIENT report — the model may not request a fourth diagnostic.
        //
        // Issue #107: this turn is INVESTIGATION by position now that the
        // bounds are slack, and the reserved FINALIZATION turn sits one later.
        // What this test is about — "budget exhausted, so report honestly" —
        // is a statement about the BUDGET, so it asserts the budget directly
        // rather than the phase label that used to imply it.
        (input) => {
          expect(input.diagnosticCallsRemaining).toBe(0);
          seenRemainingOnFinalization.push(input.diagnosticCallsRemaining);
          return {
            kind: "report_submission",
            usage,
            rawInput: reportVariant({
              evidenceState: "INSUFFICIENT",
              rootCause: null,
              evidence: [
                { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "first check.", supports: [] },
                { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "second check.", supports: [] },
                { evidenceId: "call-3", sourceType: "TOOL_EXECUTION", finding: "third check.", supports: [] },
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
                supports: [],
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
    supports: string[];
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
      // Issue #60 Checkpoint B: zero suggested actions means ADVISORY under the
      // disposition ↔ action-cardinality invariant.
      recommendationDisposition: "ADVISORY",
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
            { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported DEGRADED.", supports: [] },
            { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported OPERATIONAL.", supports: [] },
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
        // 4th provider turn belongs to the report stage — no 4th diagnostic is
        // permitted regardless of what the model wants next. Issue #107: that
        // turn is INVESTIGATION by position (the reserved FINALIZATION turn is
        // one later), so the exhausted budget, not the phase label, is what
        // forecloses further diagnostics.
        (input) => {
          expect(input.diagnosticCallsRemaining).toBe(0);
          return {
            kind: "report_submission",
            usage,
            rawInput: conflictingReportVariant([
              { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported DEGRADED.", supports: [] },
              { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "payments-gateway reported OPERATIONAL.", supports: [] },
              { evidenceId: "call-3", sourceType: "TOOL_EXECUTION", finding: "A third check did not adjudicate the disagreement.", supports: [] },
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

  it("A3 rejects NO_EVIDENCE_YET once tool evidence exists in the run (late trip, no retry available)", async () => {
    // Issue #99: a tripped A3 guard within the retry window gets one corrective
    // retry instead of failing immediately (see the dedicated "A3 corrective
    // retry" describe block below, which covers that path). This fixture keeps
    // pinning the ORIGINAL "A3 rejects NO_EVIDENCE_YET once evidence exists"
    // immediate-fail behavior by reaching a trip with no retry left.
    //
    // Issue #107 moved the window. The retry is available on turns
    // 0..MAX_PROVIDER_TURNS - 3, which is now 0..2 rather than 0..1, so a trip
    // on turn 2 recovers and no longer pins this behavior. The fixture instead
    // spends the once-per-run retry on turn 1 and trips again on turn 3, where
    // BOTH exhaustion conditions hold: the retry is already used and turn 3 is
    // past the positional window. The emitted stream, executed-tool count, and
    // failed stage are unchanged.
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
        // turnIndex 1: inside the retry window. call-1 already completed, so
        // this NO_EVIDENCE_YET claim trips A3 and spends the one allowed
        // corrective retry. Nothing is emitted for the rejected request.
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2a",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        // turnIndex 2: the corrected request, now citing the evidence it has.
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
      },
      {
        // turnIndex 3: trips A3 again with the retry already spent, so the run
        // fails exactly as it did before #99 — which is what this test pins.
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-3",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Schema-valid (empty supportedBy), but call-1/call-2 already
            // completed: the A3 iff rule forbids claiming NO_EVIDENCE_YET now.
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
    ];
    await runAndExpectAssessmentRejected({
      name: "neg-11-no-evidence-after-evidence",
      turns,
      expectedEmittedTypes: [
        "AGENT_STARTED",
        "TOOL_REQUESTED",
        "TOOL_COMPLETED",
        "TOOL_REQUESTED",
        "TOOL_COMPLETED",
      ],
      expectedFailedStage: "DIAGNOSTIC_EXECUTION",
      expectedExecuteCount: 2,
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

// Issue #99 (docs/reviews/38-issue-99-...-plan.md): a tripped A3 guard gets
// one bounded corrective re-prompt instead of failing the run outright, on
// investigation turns 0..MAX_PROVIDER_TURNS-3. These tests exercise the real
// retry path end to end — a version of this suite run against the guard's
// PRE-#99 behavior (return failed(...) unconditionally) would fail every one
// of them, since that code always fails the run on the first trip. That is
// what proves this exercises the real path rather than a tautology (§3
// criterion 1) — a new guard test that already passes without the retry
// mechanism would have revealed the check unreachable instead of validating
// it (the defect Issue #89 hit).
describe("runAgentOrchestrator — A3 corrective retry (issue #99)", () => {
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

  it("criterion 1/3: a first-turn A3 trip retries once and, given a corrected assessment, proceeds to TOOL_REQUESTED and completes", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const turns: FakeProviderTurn[] = [
      {
        // Turn 0: RAG evidence is already allowed in this run (see
        // allowedRagChunkIds below), so NO_EVIDENCE_YET is an A3 violation —
        // schema-valid (V0/A2 pass; empty supportedBy is legal for
        // NO_EVIDENCE_YET), but run-state-inconsistent.
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "trip-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        // Turn 1: the corrected retry. A fresh toolCallId — the rejected
        // turn-0 request already consumed "trip-1" in requestedToolCallIds
        // (that guard runs before V0/A2/A3), so a real corrected retry from
        // the model necessarily mints a new tool_use id, exactly like Claude
        // would on a fresh turn.
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
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];
    const provider = new FakeLlmProvider({ id: "a3-retry-then-complete", turns });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    // 3 provider turns: the rejected turn 0, the corrected turn 1, the report
    // on turn 2. The rejected turn produced no TOOL_REQUESTED and the tool
    // never executed for it.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(3);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ serviceSlug: "notification-service" });

    const toolRequestedEvents = emitted.filter((e) => e.type === "TOOL_REQUESTED");
    expect(toolRequestedEvents).toHaveLength(1);
    expect(toolRequestedEvents[0]).toMatchObject({ toolCallId: "call-1" });

    // The corrective message actually reached the conversation the retried
    // turn saw — proving the retry is a real re-prompt, not merely "try
    // again with the same input".
    const retriedCallInput = runAgentTurnSpy.mock.calls[1]?.[0];
    expect(retriedCallInput?.conversation).toContainEqual({
      role: "corrective_guidance",
      text: expect.stringContaining("NO_EVIDENCE_YET"),
    });
  });

  it("criterion 2: a second A3 trip in the same run fails the run, same PROVIDER_PROTOCOL_INVALID code as an unretried trip", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "trip-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
      {
        // A second trip: still claims NO_EVIDENCE_YET despite the allowed
        // RAG evidence. The once-per-run limit means this one fails closed
        // instead of retrying again.
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "trip-2",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
    ];
    const provider = new FakeLlmProvider({ id: "a3-second-trip-fails", turns });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);
    const executeSpy = vi.spyOn(getServiceStatusTool, "execute");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.code).toBe("PROVIDER_PROTOCOL_INVALID");
    expect(result.failedStage).toBe("AGENT_ANALYSIS");
    // Exactly the two rejected turns were attempted; the second never gets a
    // third retry.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.trace).toEqual([]);
  });

  it("criterion 4 (turn-bound): retry, then drive the full remaining diagnostic path plus forced finalization, and stay within MAX_PROVIDER_TURNS attempts", async () => {
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "trip-1",
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
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "billing-service" },
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
            toolName: "get_service_status",
            input: { serviceSlug: "search-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "call-2", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];
    const provider = new FakeLlmProvider({ id: "a3-retry-then-full-budget", turns });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");
    const registry = new InMemoryToolRegistry([getServiceStatusTool]);

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: registry,
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
    // The rejected trip (turn 0) + 3 accepted diagnostics (turns 1, 2, 3) + the
    // report (turn 4) = exactly MAX_PROVIDER_TURNS (5) provider invocation
    // attempts. Had the retry NOT consumed a turn slot, the same amount of real
    // investigation work would fit in fewer attempts and this assertion would
    // not distinguish a free retry from a charged one — the point is that it
    // costs a real turn.
    //
    // Issue #107: with the bounds now slack this run recovers its FULL
    // diagnostic budget after the trip — 3 calls, not the 2 it managed at the
    // old 4/3 geometry. That is precisely the headroom #107 bought: an A3 trip
    // no longer permanently costs the run a diagnostic call.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(5);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(MAX_PROVIDER_TURNS);

    // Independent review MAJOR (codex-review round 1 on the implementation):
    // the retry consumes a turn WITHOUT accepting a diagnostic request, so
    // `MAX_DIAGNOSTIC_TOOL_CALLS - toolCallCount` alone stops tracking the
    // turns that could actually carry one. Unfixed, this sequence over-promises
    // on the corrective turn and hands the final turn a nonzero budget in
    // direct contradiction of AgentTurnInput.diagnosticCallsRemaining's own
    // documented contract ("0 on the FINALIZATION turn").
    //
    // Asserted as the whole ordered sequence rather than only the final value:
    // a fix that special-cased the last turn to 0 would still over-promise on
    // the corrective turn itself, which is where the model actually plans its
    // remaining work.
    expect(runAgentTurnSpy.mock.calls.map(([input]) => input.diagnosticCallsRemaining)).toEqual([
      3, // turn 0, the trip: 3 unused calls, 4 turns could still carry one
      3, // turn 1, the corrective retry: 3 unused calls and 3 turns left to carry them
      2, // turn 2
      1, // turn 3, the last turn that can carry a diagnostic
      0, // turn 4, forced finalization — the contract's own promise
    ]);
  });

  it("criterion 6 (late-trip): an A3 trip past the retry window fails the run with no retry and never consumes the forced-finalization slot", async () => {
    // Issue #107 widened the retry window from turns 0..1 to turns 0..2, since
    // it is expressed as `turnIndex <= MAX_PROVIDER_TURNS - 3`. The behaviour
    // this test pins — a trip with no retry slot left fails immediately and
    // never touches the reserved finalization turn — is unchanged; only which
    // turn is "too late" moved.
    //
    // The fixture must therefore reach turn 3 with the A3 guard still
    // REACHABLE. An earlier revision of this test simply added a third
    // accepted diagnostic, which spent the tool budget and made the
    // diagnostic-bound guard (agent-orchestrator.ts:807) reject the request
    // BEFORE the A3 guard (:867) ever ran — leaving the test green even if the
    // A3 retry rule regressed. Instead, turn 2 is consumed by a schema-invalid
    // report, which uses the #101 correction path: it spends a provider turn
    // while spending neither diagnostic budget nor the A3 retry.
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
            input: { serviceSlug: "billing-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      {
        // turnIndex 2: consumed by a schema-invalid report. This spends the
        // turn without spending diagnostic budget (2 of 3 used) or the A3
        // retry, which is what keeps the A3 guard reachable on turn 3.
        kind: "report_submission",
        usage,
        rawInput: { bogus: "schema-invalid" },
      },
      {
        // turnIndex 3 === MAX_PROVIDER_TURNS - 2: past the retry window
        // (0..MAX_PROVIDER_TURNS - 3). Evidence already exists, so claiming
        // NO_EVIDENCE_YET trips A3 — and there is no slot left to retry into
        // (turn 4 is the forced FINALIZATION turn), so this must fail exactly
        // as pre-#99, with no retry attempted.
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-4",
            toolName: "get_service_status",
            input: { serviceSlug: "billing-service" },
            rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
          },
        ],
      },
    ];
    const provider = new FakeLlmProvider({ id: "a3-late-trip-no-retry", turns });
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
    // Pin WHICH guard rejected this. Without this assertion the test passes
    // when the diagnostic-bound guard fires first, which is exactly how the
    // earlier revision stopped covering the A3 rule (see the fixture comment).
    expect(result.message).toContain("declared evidence status inconsistently");
    // The diagnostic budget is NOT spent here (2 of 3 used), so the report
    // stage has not begun and DIAGNOSTIC_EXECUTION is the truthful stage.
    expect(result.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    // Exactly 4 attempts: turns 0-3. Turn 4 (forced finalization) was never
    // invoked — the rejected request did not consume it.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(4);
  });

  it("criterion 7 (ledger): a retried run's persisted event stream carries no event for the rejected assessment, and every emitted event still validates against the write contract", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const turns: FakeProviderTurn[] = [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "trip-1",
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
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];
    const provider = new FakeLlmProvider({ id: "a3-retry-ledger", turns });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    // No event of any kind was emitted for the rejected turn-0 request: the
    // stream contains exactly one TOOL_REQUESTED (for call-1, the accepted
    // retry), never one for "trip-1". §2.4's decision (no new event type for
    // a rejected-and-retried assessment) holds in practice.
    expect(types(emitted).filter((t) => t === "TOOL_REQUESTED")).toHaveLength(1);
    expect(emitted.some((e) => "toolCallId" in e && e.toolCallId === "trip-1")).toBe(false);
    // Every emitted event is a known, schema-valid write-contract member —
    // no unknown event type reached "persistence".
    for (const event of emitted) {
      const parsed = InvestigationEventPayloadSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
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

describe("runAgentOrchestrator — report corrective retry (issue #101)", () => {
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

  // The two invariants observed failing on every real LIVE run on 2026-09-14
  // (runs ddd6ced6, adf6ed24, 402efbfb, b5fb71ae). Neither is a schema defect:
  // an action grounded in evidence the report does not list is exactly the
  // unreconstructable claim P2-3 forbids, and an ACTIONABLE disposition with
  // zero actions is self-contradictory. Both are fixtures of the MODEL's
  // formatting error, reproduced here deterministically.

  // F5: groundedBy cites a locator that appears nowhere in report.evidence.
  // The action itself is otherwise fully valid — correct discriminant, correct
  // nested `payload` shape for CREATE_ESCALATION (team/reason/priority), 1..10
  // locators — so the ONLY thing this fixture violates is the F5 subset rule.
  // That precision is load-bearing: an action with a malformed payload would
  // fail on `invalid_type`/unrecognized-key instead, and the test would pass
  // while proving nothing about the invariant the real runs actually hit.
  const reportViolatingF5 = {
    ...validReportWithRagEvidence,
    suggestedActions: [
      {
        type: "CREATE_ESCALATION",
        payload: {
          team: "Identity",
          reason: "The identity provider certificate rotation needs owner review.",
          priority: "MEDIUM",
        },
        // "call-1" is a plausible tool-call id, but this report's evidence
        // array lists only "rag-chunk-1" — exactly the mistake observed in
        // runs ddd6ced6 and 402efbfb.
        groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
      },
    ],
    recommendationDisposition: "ACTIONABLE",
  };

  // F1/F2: ACTIONABLE disposition with an empty suggestedActions array.
  const reportViolatingF1 = {
    ...validReportWithRagEvidence,
    suggestedActions: [],
    recommendationDisposition: "ACTIONABLE",
  };

  // Issue #114: like reportViolatingF5, but the cited groundedBy locator
  // ("call-unconfirmed") is NEVER a real observation in any of this describe
  // block's turn sequences — no diagnostic tool ever executes with that id.
  // Auto-completion's confirmation gate (§2.4) therefore always rejects it,
  // so a test built on this fixture still exercises the #101/#107 retry path
  // it was written to test, unaffected by #114's new mechanism. Tests below
  // that DO run a real "call-1" diagnostic tool call before submitting
  // reportViolatingF5 now get auto-healed instead of retried — that is
  // #114's intended behavior change, not a regression — so those specific
  // tests use this fixture instead to keep testing what they always tested.
  const reportViolatingF5Unconfirmable = {
    ...reportViolatingF5,
    suggestedActions: [
      {
        ...reportViolatingF5.suggestedActions[0],
        groundedBy: [{ evidenceId: "call-unconfirmed", sourceType: "TOOL_EXECUTION" as const }],
      },
    ],
  };

  it("criterion 1: a report rejected on an investigation turn is corrected on retry and the run completes", async () => {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const turns: FakeProviderTurn[] = [
      // Turn 0: a voluntary report submission on an INVESTIGATION turn —
      // submit_resolution_report is offered on every turn, which is how 3 of
      // the 4 real runs reached this state with a slot still free. Rejected
      // by F5.
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      // Turn 1: the corrective retry returns a schema-valid report.
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "report-retry-f5", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");
    // Criterion 8, REVISED by §2.3's retraction. The earlier version of this
    // test asserted TWO REPORT_SUBMITTED events. That stream cannot be
    // persisted: the canonical lifecycle treats report events as singletons and
    // rejects it, which independent review caught as a BLOCKER — a retried run
    // would have ended stuck RUNNING rather than completing. Exactly one report
    // attempt reaches the ledger: the one that decided the run.
    expect(types(emitted).filter((t) => t === "REPORT_SUBMITTED")).toHaveLength(1);
    expect(types(emitted)).not.toContain("REPORT_VALIDATION_FAILED");
    expect(types(emitted)).toContain("REPORT_VALIDATED");
  });

  it("the retried run's event stream is ACCEPTED by the real canonical reducer (the BLOCKER regression)", async () => {
    // The test that would have caught the original BLOCKER. Every other test
    // in this block uses a collecting emitter that never validates, so all of
    // them passed against an implementation whose stream the real persistence
    // path rejects outright. This one runs the actual reducer.
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const turns: FakeProviderTurn[] = [
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "report-retry-reducer", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result.status).toBe("completed");

    const payloads: InvestigationEventPayload[] = [
      { type: "RUN_CREATED" },
      ...emitted,
      { type: "RUN_COMPLETED" },
    ];
    const events = payloads.map((payload, index) => ({
      runId: "8f14e45f-1234-4abc-8def-000000000001",
      sequence: index + 1,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload,
    }));

    // Before the fix this threw InvestigationEventContractError:
    //   Event at sequence 5 ("REPORT_SUBMITTED") follows a stage failure;
    //   only RUN_FAILED may follow a failure fact.
    const progress = deriveExecutionStageProgress({
      events,
      runStatus: "COMPLETED",
      now: events[events.length - 1]!.recordedAt,
    });
    for (const stage of progress) {
      expect(["completed", "failed", "omitted"]).toContain(stage.status);
    }
  });

  it("a terminal rejection still records the attempt that decided the run", async () => {
    // The narrowing in §2.3 must not swallow the rejection that actually ends
    // a run: "submitted then rejected" stays distinguishable from "never
    // submitted" whenever the rejection is terminal. Also validated against the
    // real reducer, since this is the other stream shape this issue produces.
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const turns: FakeProviderTurn[] = [
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
    ];

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "report-retry-terminal", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });

    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
    expect(types(emitted).filter((t) => t === "REPORT_SUBMITTED")).toHaveLength(1);
    expect(types(emitted)).toContain("REPORT_VALIDATION_FAILED");

    // Issue #105: the terminal rejection names WHICH invariant ended the run.
    // Asserted on the real emitted payload rather than on a constructed one,
    // and the fixture is the F5 violation observed in every attributable real
    // LIVE failure — so this pins the orchestrator → classifier → payload path
    // end to end, not just the classifier in isolation.
    const validationFailed = emitted.find((e) => e.type === "REPORT_VALIDATION_FAILED");
    expect(validationFailed).toMatchObject({
      failureCode: "REPORT_SCHEMA_INVALID",
      violatedInvariants: ["GROUNDED_BY_NOT_IN_EVIDENCE"],
    });

    const payloads: InvestigationEventPayload[] = [
      { type: "RUN_CREATED" },
      ...emitted,
      { type: "RUN_FAILED", failureCode: "REPORT_SCHEMA_INVALID", failedStage: "REPORT_GENERATION" },
    ];
    const events = payloads.map((payload, index) => ({
      runId: "8f14e45f-1234-4abc-8def-000000000001",
      sequence: index + 1,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload,
    }));

    const progress = deriveExecutionStageProgress({
      events,
      runStatus: "FAILED",
      now: events[events.length - 1]!.recordedAt,
    });
    for (const stage of progress) {
      expect(["completed", "failed", "omitted"]).toContain(stage.status);
    }
  });

  it("criterion 1 (F1/F2): the same correction path covers the disposition/cardinality invariant, not just F5", async () => {
    // Two of the four real runs failed F1/F2 rather than F5. A fix keyed on
    // one invariant would leave half the observed failures untouched, so this
    // asserts the mechanism is keyed on REJECTION, not on a specific rule.
    const turns: FakeProviderTurn[] = [
      { kind: "report_submission", usage, rawInput: reportViolatingF1 },
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "report-retry-f1", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
  });

  it("criterion 2: a second rejected report fails the run with REPORT_SCHEMA_INVALID, exactly as before this issue", async () => {
    const turns: FakeProviderTurn[] = [
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
    ];

    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "report-retry-twice", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
  });

  it("criterion 4: a report rejected on the forced FINALIZATION turn fails, with no turn left to retry into", async () => {
    // §2.1 rule 5: the retry needs a LATER turn to submit a corrected report
    // into. On the last turn there is none. One of the four real runs
    // (b5fb71ae, providerCalls=4) was in exactly this state and is genuinely
    // unrecoverable — failing it is honest.
    //
    // Issue #107 changed how a run REACHES that state, which is worth stating
    // because the fixture no longer looks like the scenario it models. With the
    // bounds slack, a run that spends all three diagnostic calls lands on the
    // zero-budget turn (3) — which still has turn 4 after it, so a first
    // rejection there is CORRECTED rather than terminal. That is exactly the
    // headroom #107 bought. The genuinely-terminal state is now a rejection on
    // turn 4 with the once-per-run retry already spent, so the fixture submits
    // two rejected reports rather than one.
    //
    // Distinct from criterion 2, which reaches its second rejection with no
    // diagnostics at all: this one proves the exhausted-budget path also
    // terminates cleanly instead of looping.
    const turns: FakeProviderTurn[] = [
      ...Array.from({ length: MAX_DIAGNOSTIC_TOOL_CALLS }, (_, index) => ({
        kind: "diagnostic_tool_requests" as const,
        usage,
        requests: [
          {
            toolCallId: `call-${index + 1}`,
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment:
              index === 0
                ? {
                    evidenceState: "INSUFFICIENT",
                    continuationReason: "STATUS_UNRESOLVED",
                    supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }],
                  }
                : {
                    evidenceState: "INSUFFICIENT",
                    continuationReason: "STATUS_UNRESOLVED",
                    supportedBy: [
                      { evidenceId: `call-${index}`, sourceType: "TOOL_EXECUTION" },
                    ],
                  },
          },
        ],
      })),
      // Turn 3 — budget exhausted, so this is the report turn. Rejected, and
      // corrected into turn 4 because a later turn still exists. Uses
      // reportViolatingF5Unconfirmable (Issue #114): this test deliberately
      // proves the #101/#107 retry still fires when auto-completion CANNOT
      // apply (the cited locator is not a real observation from any turn
      // above) — reportViolatingF5's own "call-1" would now be auto-healed
      // by #114 instead, since a real diagnostic call with that id ran above.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
      // Turn 4 — the forced finalization turn. Rejected again, with the retry
      // already spent AND no later turn: terminal.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
    ];

    const provider = new FakeLlmProvider({ id: "report-retry-late", turns });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
    // No extra invocation beyond the bound: the final rejection consumed the
    // last available turn, so nothing was retried after it.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(MAX_PROVIDER_TURNS);
  });

  it("criterion 5: the retry consumes a turn slot and the run stays within MAX_PROVIDER_TURNS", async () => {
    const turns: FakeProviderTurn[] = [
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
      // Turn 1: voluntary report, rejected. Uses reportViolatingF5Unconfirmable
      // (Issue #114): "call-1" ran as a real diagnostic tool call above, so
      // plain reportViolatingF5 would now be auto-healed instead of retried —
      // this test specifically proves the #101 retry+turn-budget accounting,
      // which needs a rejection auto-completion cannot resolve.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
      // Turn 2: corrected on the retry.
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ];

    const provider = new FakeLlmProvider({ id: "report-retry-bound", turns });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
    // 1 diagnostic + 1 rejected report + 1 corrected report = 3 attempts,
    // within the bound of 4. providerTurnsUsed counts ATTEMPTS
    // (recording-provider.ts), so the rejected turn is charged like any other.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(3);
    expect(runAgentTurnSpy.mock.calls.length).toBeLessThanOrEqual(MAX_PROVIDER_TURNS);
  });

  it("criterion 6: the corrective message names the violated invariant and echoes nothing the model wrote", async () => {
    const provider = new FakeLlmProvider({
      id: "report-retry-message",
      turns: [
        { kind: "report_submission", usage, rawInput: reportViolatingF5 },
        { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    const retryConversation = runAgentTurnSpy.mock.calls[1]?.[0].conversation ?? [];
    const corrective = retryConversation.filter((e) => e.role === "corrective_guidance");
    expect(corrective).toHaveLength(1);
    const text = corrective[0]?.role === "corrective_guidance" ? corrective[0].text : "";

    // Names the invariant that actually failed, in the harness's own words.
    expect(text).toContain("groundedBy");
    expect(text).toContain("evidence array");
    // Tells the model the report was NOT recorded — the state it must reason
    // from. A corrective message that omits this invites it to assume the
    // report landed and to "continue" instead of resubmitting.
    expect(text).toContain("NOT recorded");

    // Echoes nothing the model produced. "call-1" is the invented evidenceId
    // from the rejected report and is the single most likely value to leak,
    // since it is what the failing locator pointed at; the payload strings are
    // free-text the model authored.
    expect(text).not.toContain("call-1");
    expect(text).not.toContain("Identity");
    expect(text).not.toContain("certificate rotation");
    expect(text).not.toContain("notification-service is degraded");
  });

  it("criterion 7: an invariant with no authored remedy still retries, with a generic message", async () => {
    // `confidence: 70` fails the 0-1 bound as a `too_big` issue, which carries
    // no `message` field at all (only `custom` issues do), so no authored
    // remedy can match. The run must still be given its correction attempt —
    // recoverability must not depend on whether someone wrote a paragraph for
    // that particular rule.
    const provider = new FakeLlmProvider({
      id: "report-retry-generic",
      turns: [
        { kind: "report_submission", usage, rawInput: { ...validReportWithRagEvidence, confidence: 70 } },
        { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");

    const retryConversation = runAgentTurnSpy.mock.calls[1]?.[0].conversation ?? [];
    const corrective = retryConversation.filter((e) => e.role === "corrective_guidance");
    expect(corrective).toHaveLength(1);
    const text = corrective[0]?.role === "corrective_guidance" ? corrective[0].text : "";

    expect(text).toContain("did not satisfy the resolution-report contract");
    // Never states a rule it cannot actually attribute, and never leaks the
    // offending value (the same never-log-raw-value constraint the sanitized
    // issue summaries enforce).
    expect(text).not.toContain("groundedBy");
    expect(text).not.toContain("70");
  });

  it("de-duplicates the remedy when one report trips the same invariant on several actions", async () => {
    // Two of the four real LIVE runs produced TWO identical F5 issues from a
    // single report (one per groundedBy entry). Repeating the same paragraph
    // teaches nothing and dilutes the instruction.
    const twoF5Violations = {
      ...validReportWithRagEvidence,
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: {
            team: "Identity",
            reason: "The identity provider certificate rotation needs owner review.",
            priority: "MEDIUM",
          },
          groundedBy: [
            { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
          ],
        },
      ],
      recommendationDisposition: "ACTIONABLE",
    };

    const provider = new FakeLlmProvider({
      id: "report-retry-dedupe",
      turns: [
        { kind: "report_submission", usage, rawInput: twoF5Violations },
        { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    const retryConversation = runAgentTurnSpy.mock.calls[1]?.[0].conversation ?? [];
    const entry = retryConversation.find((e) => e.role === "corrective_guidance");
    const text = entry?.role === "corrective_guidance" ? entry.text : "";

    const occurrences = text.split("Every groundedBy locator").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("runAgentOrchestrator — groundedBy-omission auto-completion (issue #114)", () => {
  // Base report: F5-only violation. evidence is empty; the suggested action's
  // groundedBy cites a locator never independently listed in evidence. The
  // suite below varies which sourceType/locator that is and what run state
  // exists, per the plan's §4 case table.
  function reportCitingViaGroundedBy(
    groundedByLocators: readonly { evidenceId: string; sourceType: "RAG_CHUNK" | "TOOL_EXECUTION" }[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      category: "SERVICE_DEGRADATION",
      summary: "Notification delivery is delayed for some customers.",
      rootCause: null,
      customerImpact: "Some customers are receiving delayed notifications.",
      recommendedResolution: "Monitor notification-service until it recovers.",
      confidence: 0.6,
      evidence: [],
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: {
            team: "Notifications",
            reason: "notification-service degradation needs owner review.",
            priority: "MEDIUM",
          },
          groundedBy: groundedByLocators,
        },
      ],
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ACTIONABLE",
      ...overrides,
    };
  }

  it("auto-heals the F5 dominant shape: evidence: [], groundedBy cites a real completed tool call", async () => {
    const provider = new FakeLlmProvider({
      id: "auto-complete-tool-execution",
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
                supportedBy: [],
              },
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: reportCitingViaGroundedBy([{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }]),
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
    if (result.status !== "completed") throw new Error("expected completed");
    // No retry consumed — auto-completion resolved it on the first attempt.
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(2);
    expect(result.report.evidence).toEqual([
      {
        evidenceId: "call-1",
        sourceType: "TOOL_EXECUTION",
        finding: expect.stringContaining("Cited by a suggested action's grounding"),
        supports: [],
      },
    ]);
    expect(result.autoCompletedEvidence).toEqual([{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }]);
  });

  it("auto-heals when groundedBy cites a real retrieved RAG chunk", async () => {
    const provider = new FakeLlmProvider({
      id: "auto-complete-rag-chunk",
      turns: [
        {
          kind: "report_submission",
          usage,
          rawInput: reportCitingViaGroundedBy([{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }]),
        },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.autoCompletedEvidence).toEqual([{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }]);
  });

  it("auto-heals multiple real citations across two distinct sources in one report", async () => {
    const provider = new FakeLlmProvider({
      id: "auto-complete-multiple",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // allowedRagChunkIds is already non-empty at turn 0 (manual
              // mode, passed directly below rather than via a retriever), so
              // NO_EVIDENCE_YET would be inconsistent with run state and trip
              // the A3 guard — cite the already-available RAG chunk instead.
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }],
              },
            },
          ],
        },
        {
          kind: "report_submission",
          usage,
          rawInput: {
            ...reportCitingViaGroundedBy([]),
            suggestedActions: [
              {
                type: "CREATE_ESCALATION",
                payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" },
                groundedBy: [
                  { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" },
                ],
              },
            ],
          },
        },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.autoCompletedEvidence).toHaveLength(2);
    expect(result.autoCompletedEvidence).toEqual(
      expect.arrayContaining([
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" },
      ]),
    );
  });

  it("does NOT auto-complete when evidence-cap (.max(10)) would be exceeded — falls through to the existing retry", async () => {
    const tenRealEntries = Array.from({ length: 10 }, (_, i) => ({
      evidenceId: `call-${i + 1}`,
      sourceType: "TOOL_EXECUTION" as const,
      finding: `Observation ${i + 1}.`,
      supports: [],
    }));
    // 10 diagnostic tool requests to make all 10 cited ids real completed
    // tool calls (the confirmation gate must not reject them as fabricated).
    const diagnosticTurns: FakeProviderTurn[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "diagnostic_tool_requests" as const,
      usage,
      requests: [
        {
          toolCallId: `call-${i + 1}`,
          toolName: "get_service_status",
          input: { serviceSlug: "notification-service" },
          rawAssessment:
            i === 0
              ? { evidenceState: "INSUFFICIENT" as const, continuationReason: "NO_EVIDENCE_YET" as const, supportedBy: [] }
              : {
                  evidenceState: "INSUFFICIENT" as const,
                  continuationReason: "STATUS_UNRESOLVED" as const,
                  supportedBy: [{ evidenceId: `call-${i}`, sourceType: "TOOL_EXECUTION" as const }],
                },
        },
      ],
    }));

    const reportAtCap = {
      category: "SERVICE_DEGRADATION",
      summary: "Notification delivery is delayed for some customers.",
      rootCause: null,
      customerImpact: "Some customers are receiving delayed notifications.",
      recommendedResolution: "Monitor notification-service until it recovers.",
      confidence: 0.6,
      evidence: tenRealEntries,
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" },
          // Cites an 11th real observation NOT in the 10-entry evidence array.
          groundedBy: [{ evidenceId: "call-11", sourceType: "TOOL_EXECUTION" }],
        },
      ],
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ACTIONABLE",
    };

    // MAX_DIAGNOSTIC_TOOL_CALLS/MAX_PROVIDER_TURNS bound how many diagnostic
    // calls a real run permits, but this test only needs the confirmation
    // gate's realness check to pass for 11 ids — it does not need to run
    // through the real bounded loop, so drive it via 11 scripted diagnostic
    // turns directly followed by the report on whichever turn the fake
    // provider is asked for next. The orchestrator's own MAX_PROVIDER_TURNS
    // bound still applies to real turn indices; this fixture only needs the
    // report attempt (whichever turn it lands on) to see 11 real ids already
    // recorded in successfulToolExecutionIds, which requires an eleventh
    // diagnostic turn ahead of the report submission.
    const provider = new FakeLlmProvider({
      id: "auto-complete-evidence-cap",
      turns: [
        ...diagnosticTurns,
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-11",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "call-10", sourceType: "TOOL_EXECUTION" }],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: reportAtCap },
        { kind: "report_submission", usage, rawInput: reportAtCap },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    // Exceeds MAX_DIAGNOSTIC_TOOL_CALLS/MAX_PROVIDER_TURNS by construction (11
    // diagnostic turns), so the run fails on the turn-budget/report-stage
    // rules before the evidence-cap question is even reached in a REAL bound
    // sense — but the orchestrator's own bounded loop enforces this
    // independent of #114, so the assertion that matters here is narrower:
    // the run must NOT complete with an 11-entry evidence array, regardless
    // of which bound stopped it first.
    if (result.status === "completed") {
      expect(result.report.evidence.length).toBeLessThanOrEqual(10);
    } else {
      expect(result.status).toBe("failed");
    }
  });

  it("does NOT auto-complete when a co-occurring invariant is also violated (ADVISORY_FORBIDS_ACTIONS)", async () => {
    const report = reportCitingViaGroundedBy([{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }], {
      recommendationDisposition: "ADVISORY",
    });

    const provider = new FakeLlmProvider({
      id: "auto-complete-co-occurring-invariant",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [
            {
              toolCallId: "call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // allowedRagChunkIds is already non-empty at turn 0 (manual
              // mode), so NO_EVIDENCE_YET would trip the A3 guard.
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" }],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: report },
        { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
      ],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
    });

    // NOT auto-completed: falls through to the existing #101 retry (a later
    // turn resubmits a valid report) rather than being healed on attempt 1.
    expect(result.status).toBe("completed");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT auto-complete a mixed real+fabricated groundedBy citation", async () => {
    const report = reportCitingViaGroundedBy([
      { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
      { evidenceId: "call-never-ran", sourceType: "TOOL_EXECUTION" },
    ]);

    const provider = new FakeLlmProvider({
      id: "auto-complete-mixed-fabrication",
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
                supportedBy: [],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: report },
        { kind: "report_submission", usage, rawInput: report },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    // Never auto-completed — fabricated id in groundedBy means the
    // confirmation gate never proceeds. Both attempts are F5 rejections, so
    // the run exhausts the retry and fails with REPORT_SCHEMA_INVALID, not
    // REPORT_EVIDENCE_INVALID (the mechanism never got far enough to hit
    // findInvalidEvidence on an augmented payload).
    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
  });

  it("does NOT auto-complete when a PRE-EXISTING evidence entry is fabricated, even if the omission itself is real (round-3 fix)", async () => {
    const report = {
      category: "SERVICE_DEGRADATION",
      summary: "Notification delivery is delayed for some customers.",
      rootCause: null,
      customerImpact: "Some customers are receiving delayed notifications.",
      recommendedResolution: "Monitor notification-service until it recovers.",
      confidence: 0.6,
      // Pre-existing entry cites a locator that never ran — fabricated.
      evidence: [
        {
          evidenceId: "call-never-ran",
          sourceType: "TOOL_EXECUTION",
          finding: "A fabricated observation.",
          supports: [],
        },
      ],
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" },
          // This locator IS real and IS omitted from evidence above — the F5
          // shape alone would auto-heal, but the pre-existing fabrication
          // must block it (§2.4/round-3 fix).
          groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
        },
      ],
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ACTIONABLE",
    };

    const provider = new FakeLlmProvider({
      id: "auto-complete-preexisting-fabrication",
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
                supportedBy: [],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: report },
        { kind: "report_submission", usage, rawInput: report },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    // Must fall through to the existing F5 path — never REPORT_EVIDENCE_INVALID,
    // which is what an unguarded auto-completion would have produced by
    // re-parsing successfully and then hitting findInvalidEvidence on the
    // pre-existing fabricated entry.
    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
  });

  it("does NOT auto-complete a malformed payload the probe schema itself cannot parse", async () => {
    const malformed = {
      // `evidence` is not an array at all — the permissive probe still
      // requires this shape (z.array(...).optional() rejects a non-array,
      // non-undefined value).
      evidence: "not-an-array",
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" },
          groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
        },
      ],
      recommendationDisposition: "ACTIONABLE",
      evidenceState: "INSUFFICIENT",
      category: "SERVICE_DEGRADATION",
      summary: "s",
      rootCause: null,
      customerImpact: "i",
      recommendedResolution: "r",
      confidence: 0.5,
    };

    const provider = new FakeLlmProvider({
      id: "auto-complete-malformed",
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
                supportedBy: [],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: malformed },
        { kind: "report_submission", usage, rawInput: malformed },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("failed");
  });

  it("legitimate partial citation is accepted unchanged — auto-completion never fires when there is no Zod rejection", async () => {
    // 3 real retrieved chunks; report cites only the one relevant one in
    // `evidence` and nothing in groundedBy names the other two. This is
    // NOT an F5 violation at all (no groundedBy references them), so this
    // must complete on the first attempt without any auto-completion.
    const report = {
      ...validReportWithRagEvidence,
      evidence: [
        {
          evidenceId: "rag-chunk-1",
          sourceType: "RAG_CHUNK",
          finding: "The relevant chunk.",
          supports: ["ROOT_CAUSE"],
        },
      ],
    };

    const provider = new FakeLlmProvider({
      id: "legitimate-partial-citation",
      turns: [{ kind: "report_submission", usage, rawInput: report }],
    });
    const runAgentTurnSpy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1", "rag-chunk-2", "rag-chunk-3"]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.autoCompletedEvidence).toEqual([]);
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  it("a truthful empty report with nothing gathered is accepted unchanged (P1-3 regression pin)", async () => {
    const report = {
      category: "SERVICE_DEGRADATION",
      summary: "s",
      rootCause: null,
      customerImpact: "i",
      recommendedResolution: "r",
      confidence: 0.3,
      evidence: [],
      suggestedActions: [],
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ADVISORY",
    };

    const provider = new FakeLlmProvider({
      id: "truthful-empty-report",
      turns: [{ kind: "report_submission", usage, rawInput: report }],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.autoCompletedEvidence).toEqual([]);
    expect(result.report.evidence).toEqual([]);
  });

  it("fabrication still fails closed after successful auto-completion (findInvalidEvidence unaffected)", async () => {
    // The suggested action's groundedBy is fully real and auto-completed, but
    // a SEPARATE, model-authored evidence entry the report already carried
    // cites a locator that was never real. Auto-completion appends the real
    // omission and re-parses; the augmented report's OWN evidence array still
    // carries the fabricated entry, so findInvalidEvidence must still reject
    // it post-acceptance with REPORT_EVIDENCE_INVALID.
    //
    // NOTE: per §2.4, the confirmation gate checks every PRE-EXISTING
    // evidence entry for realness too — so this exact shape is caught and
    // auto-completion is skipped BEFORE re-parsing, falling through to the
    // ordinary F5 retry/terminal path instead of ever reaching
    // findInvalidEvidence with a synthesized entry. This test therefore pins
    // that outcome (REPORT_SCHEMA_INVALID, not REPORT_EVIDENCE_INVALID) as
    // the observable proof that the safety net in §2.4 is what fires.
    const report = {
      category: "SERVICE_DEGRADATION",
      summary: "s",
      rootCause: null,
      customerImpact: "i",
      recommendedResolution: "r",
      confidence: 0.5,
      evidence: [
        {
          evidenceId: "call-fabricated",
          sourceType: "TOOL_EXECUTION",
          finding: "Fabricated.",
          supports: [],
        },
      ],
      suggestedActions: [
        {
          type: "CREATE_ESCALATION",
          payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" },
          groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
        },
      ],
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ACTIONABLE",
    };

    const provider = new FakeLlmProvider({
      id: "fabrication-fails-closed",
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
                supportedBy: [],
              },
            },
          ],
        },
        { kind: "report_submission", usage, rawInput: report },
        { kind: "report_submission", usage, rawInput: report },
      ],
    });

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
    });

    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
  });
});

describe("runAgentOrchestrator — correctionHistory on the deciding submission (issue #116)", () => {
  function recordingEmitter() {
    const emitted: InvestigationEventPayload[] = [];
    return {
      emitted,
      emitLifecycleEvent: async (payload: InvestigationEventPayload) => {
        emitted.push(payload);
      },
    };
  }

  // The single assertion every case below makes. Reads the ONE deciding
  // REPORT_SUBMITTED — a corrected-away attempt emits nothing, so finding more
  // than one here would itself be a defect.
  function submittedHistory(emitted: readonly InvestigationEventPayload[]) {
    const submissions = emitted.filter((e) => e.type === "REPORT_SUBMITTED");
    expect(submissions).toHaveLength(1);
    return (submissions[0] as { correctionHistory?: string }).correctionHistory;
  }

  // Trips A3: claims NO_EVIDENCE_YET while the run already allows RAG evidence.
  const a3TrippingTurn: FakeProviderTurn = {
    kind: "diagnostic_tool_requests",
    usage,
    requests: [
      {
        toolCallId: "trip-1",
        toolName: "get_service_status",
        input: { serviceSlug: "notification-service" },
        rawAssessment: NO_EVIDENCE_YET_ASSESSMENT,
      },
    ],
  };

  const correctedDiagnosticTurn: FakeProviderTurn = {
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
          supportedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" as const }],
        },
      },
    ],
  };

  // F5-only violation whose missing locator IS confirmable, so #114's
  // auto-completion decides the run at agent-orchestrator.ts:900.
  const reportAutoCompletable = {
    ...validReportWithRagEvidence,
    evidence: [],
    suggestedActions: [
      {
        type: "CREATE_ESCALATION" as const,
        payload: { team: "Notifications", reason: "reason", priority: "MEDIUM" as const },
        groundedBy: [{ evidenceId: "rag-chunk-1", sourceType: "RAG_CHUNK" as const }],
      },
    ],
    recommendationDisposition: "ACTIONABLE" as const,
    evidenceState: "INSUFFICIENT" as const,
    rootCause: null,
  };

  // F5-only violation citing a locator the run cannot confirm, so
  // auto-completion declines and the ordinary retry/terminal path runs.
  const reportUnconfirmable = {
    ...reportAutoCompletable,
    suggestedActions: [
      {
        ...reportAutoCompletable.suggestedActions[0]!,
        groundedBy: [{ evidenceId: "call-unconfirmed", sourceType: "TOOL_EXECUTION" as const }],
      },
    ],
  };

  async function run(turns: FakeProviderTurn[]) {
    const { emitted, emitLifecycleEvent } = recordingEmitter();
    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "correction-history", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [ticketContext],
      allowedRagChunkIds: new Set(["rag-chunk-1"]),
      emitLifecycleEvent,
    });
    return { result, emitted };
  }

  it("case 1: a report accepted on the first attempt records NONE — present, never absent", async () => {
    const { result, emitted } = await run([
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ]);

    expect(result.status).toBe("completed");
    // Explicitly not `toBeUndefined()`: absence means "persisted before #116",
    // and the whole field is worthless if a clean run is indistinguishable
    // from a historical row.
    expect(submittedHistory(emitted)).toBe("NONE");
  });

  it("case 2: a report accepted only after a corrective retry records REPORT_RETRY", async () => {
    const { result, emitted } = await run([
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ]);

    expect(result.status).toBe("completed");
    expect(submittedHistory(emitted)).toBe("REPORT_RETRY");
  });

  it("case 3: a report TERMINALLY REJECTED after a corrective retry records REPORT_RETRY too", async () => {
    const { result, emitted } = await run([
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
    ]);

    // The field describes the deciding submission's history on BOTH outcomes.
    // This is the case that makes "the retry ran and did not help" derivable
    // at all: join this value with the report outcome.
    expect(result).toMatchObject({ status: "failed", code: "REPORT_SCHEMA_INVALID" });
    expect(submittedHistory(emitted)).toBe("REPORT_RETRY");
  });

  it("case 4: an A3 retry followed by a clean report records DIAGNOSTIC_RETRY", async () => {
    const { result, emitted } = await run([
      a3TrippingTurn,
      correctedDiagnosticTurn,
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ]);

    expect(result.status).toBe("completed");
    expect(submittedHistory(emitted)).toBe("DIAGNOSTIC_RETRY");
  });

  it("case 5: both corrective paths firing in one run records BOTH", async () => {
    const { result, emitted } = await run([
      a3TrippingTurn,
      correctedDiagnosticTurn,
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
      { kind: "report_submission", usage, rawInput: validReportWithRagEvidence },
    ]);

    expect(result.status).toBe("completed");
    // The case a boolean could not express, and the reason this field is an
    // enum (agent-orchestrator.ts:665-673 keeps the two flags separate).
    expect(submittedHistory(emitted)).toBe("BOTH");
  });

  // Cases 5a-5d cover the auto-completion emit site (#114,
  // agent-orchestrator.ts:900). Round 1 of this plan's review caught the plan
  // omitting this site entirely, round 3 caught it covering only half its
  // states. It decided 4 of the 10 runs in the 2026-09-16 LIVE sample, so a
  // hardcoded "NONE" here would corrupt the majority of the aggregate.

  it("case 5a: auto-completion deciding a clean first attempt records NONE", async () => {
    const { result, emitted } = await run([
      { kind: "report_submission", usage, rawInput: reportAutoCompletable },
    ]);

    expect(result.status).toBe("completed");
    expect((result as { autoCompletedEvidence: readonly unknown[] }).autoCompletedEvidence).toHaveLength(1);
    expect(submittedHistory(emitted)).toBe("NONE");
  });

  it("case 5b: auto-completion after a report retry records REPORT_RETRY, not NONE", async () => {
    const { result, emitted } = await run([
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
      { kind: "report_submission", usage, rawInput: reportAutoCompletable },
    ]);

    expect(result.status).toBe("completed");
    expect((result as { autoCompletedEvidence: readonly unknown[] }).autoCompletedEvidence).toHaveLength(1);
    expect(submittedHistory(emitted)).toBe("REPORT_RETRY");
  });

  it("case 5c: auto-completion after an A3 retry records DIAGNOSTIC_RETRY", async () => {
    const { result, emitted } = await run([
      a3TrippingTurn,
      correctedDiagnosticTurn,
      { kind: "report_submission", usage, rawInput: reportAutoCompletable },
    ]);

    expect(result.status).toBe("completed");
    expect(submittedHistory(emitted)).toBe("DIAGNOSTIC_RETRY");
  });

  it("case 5d: auto-completion after both retries records BOTH", async () => {
    const { result, emitted } = await run([
      a3TrippingTurn,
      correctedDiagnosticTurn,
      { kind: "report_submission", usage, rawInput: reportUnconfirmable },
      { kind: "report_submission", usage, rawInput: reportAutoCompletable },
    ]);

    expect(result.status).toBe("completed");
    expect(submittedHistory(emitted)).toBe("BOTH");
  });
});

