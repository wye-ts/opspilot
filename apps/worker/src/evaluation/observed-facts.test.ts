import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { InvestigationEventPayload, ResolutionReport } from "@opspilot/contracts";
import { NonJsonSafeValueError } from "./json-value";
import { buildObservedFacts, type ObservedFacts } from "./observed-facts";
import type { RecordedProviderTurn } from "./recording-provider";
import type { RecordedToolExecution } from "./recording-tool-registry";

const VALID_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "summary",
  rootCause: "root cause",
  customerImpact: "impact",
  recommendedResolution: "resolution",
  confidence: 0.5,
  evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "finding", supports: ["ROOT_CAUSE"] }],
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

describe("buildObservedFacts", () => {
  it("derives no retrieval/tool facts, and a non-null report, from an empty trace on a completed run", () => {
    const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.runStatus).toBe("completed");
    expect(facts.errorCode).toBeNull();
    expect(facts.retrieval).toEqual({ completed: false, chunkIds: [] });
    expect(facts.tools).toEqual({ requested: [], executed: [], completed: [] });
    expect(facts.report).toEqual({
      evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION" }],
      suggestedActionTypes: [],
      // v2 report metadata (§4.4) — VALID_REPORT has rootCause set, so
      // rootCausePresent is true.
      category: "SERVICE_DEGRADATION",
      rootCausePresent: true,
      confidence: 0.5,
      evidenceState: "SUFFICIENT",
      recommendationDisposition: "ADVISORY",
      suggestedActions: [],
    });
  });

  it("derives retrieval.chunkIds only from a RETRIEVAL_COMPLETED trace event", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: VALID_REPORT,
      trace: [
        {
          type: "RETRIEVAL_COMPLETED",
          chunks: [
            { chunkId: "c1", rank: 1, score: 1 },
            { chunkId: "c2", rank: 2, score: 0.5 },
          ],
        },
      ],
    };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.retrieval).toEqual({ completed: true, chunkIds: ["c1", "c2"] });
  });

  it("derives tools.requested only from TOOL_REQUESTED trace events", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: VALID_REPORT,
      trace: [{ type: "TOOL_REQUESTED", toolName: "get_service_status", toolCallId: "call-1" }],
    };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.tools.requested).toEqual([{ toolName: "get_service_status", toolCallId: "call-1" }]);
  });

  it("derives tools.completed only from TOOL_COMPLETED trace events, carrying the paired recorded output", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: VALID_REPORT,
      trace: [{ type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-1" }],
    };
    // v2: completed[].output is zipped from the recorded executions — a
    // TOOL_COMPLETED event without a matching output fails closed.
    const executedTools: readonly RecordedToolExecution[] = [
      { toolName: "get_service_status", input: {}, output: { status: "DEGRADED" } },
    ];
    const facts = buildObservedFacts(agentResult, executedTools);

    expect(facts.tools.completed).toEqual([
      { toolName: "get_service_status", toolCallId: "call-1", output: { status: "DEGRADED" } },
    ]);
  });

  it("derives tools.executed from the recorder parameter, independent of the trace (e.g. an execute() that threw)", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_EXECUTION_FAILED",
      message: "fixed message",
      trace: [],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };
    const executedTools: readonly RecordedToolExecution[] = [{ toolName: "always_fails", input: {} }];
    const facts = buildObservedFacts(agentResult, executedTools);

    expect(facts.tools.executed).toEqual(executedTools);
    expect(facts.tools.completed).toEqual([]);
  });

  it("failed-run normalization: failure errorCode, still-nested retrieval/tools, and report: null", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_NOT_FOUND",
      message: "fixed message",
      trace: [
        {
          type: "RETRIEVAL_COMPLETED",
          chunks: [{ chunkId: "c1", rank: 1, score: 1 }],
        },
        { type: "TOOL_REQUESTED", toolName: "missing_tool", toolCallId: "call-1" },
      ],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.runStatus).toBe("failed");
    expect(facts.errorCode).toBe("TOOL_NOT_FOUND");
    expect(facts.retrieval).toEqual({ completed: true, chunkIds: ["c1"] });
    expect(facts.tools).toEqual({
      requested: [{ toolName: "missing_tool", toolCallId: "call-1" }],
      executed: [],
      completed: [],
    });
    expect(facts.report).toBeNull();
  });

  it("sets errorCode: null (never undefined) on a completed result", () => {
    const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.errorCode).toBeNull();
    expect("errorCode" in facts).toBe(true);
  });

  it("derives report.suggestedActionTypes only from a completed report", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: {
        ...VALID_REPORT,
        // Issue #60 Checkpoint C: the override promotes the report to a
        // grounded ACTIONABLE so the fixture stays disposition-consistent
        // (a non-empty action under ADVISORY would violate the contract).
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [
          {
            type: "UPDATE_TICKET_STATUS",
            payload: { status: "IN_PROGRESS", reason: "reason" },
            groundedBy: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION" }],
          },
        ],
      },
      trace: [],
    };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.report?.suggestedActionTypes).toEqual(["UPDATE_TICKET_STATUS"]);
  });

  it("changing a raw AgentOrchestratorResult field that is not part of ObservedFacts cannot affect scoring", () => {
    // `message` is not part of ObservedFacts — two results differing only in
    // it must normalize identically, proving scoring (which only ever sees
    // ObservedFacts) cannot be affected by it either.
    const resultA: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_NOT_FOUND",
      message: "message A",
      trace: [],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };
    const resultB: AgentOrchestratorResult = { ...resultA, message: "message B — completely different" };

    expect(buildObservedFacts(resultA, [])).toEqual(buildObservedFacts(resultB, []));
  });

  it("v2 captures failedStage into the failed-branch observed facts — changing it changes the normalized output", () => {
    // v2 adds failedStage to BOTH observed branches, so it is part of the
    // normalized facts (unlike `message`, proven inert by the test above).
    // Two runs differing only in failedStage must differ in exactly that field.
    const resultA: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_NOT_FOUND",
      message: "fixed message",
      trace: [],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };
    const resultB: AgentOrchestratorResult = { ...resultA, failedStage: "AGENT_ANALYSIS" };

    const factsA = buildObservedFacts(resultA, []);
    const factsB = buildObservedFacts(resultB, []);

    expect(factsA.failedStage).toBe("DIAGNOSTIC_EXECUTION");
    expect(factsB.failedStage).toBe("AGENT_ANALYSIS");
    expect(factsA).not.toEqual(factsB);
  });

  it("produces exactly the nested v2 shape — top-level keys are runStatus/errorCode/retrieval/tools/report/investigation/failedStage, nothing else", () => {
    const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
    const facts = buildObservedFacts(agentResult, []);

    expect(Object.keys(facts).sort()).toEqual([
      "errorCode",
      "failedStage",
      "investigation",
      "report",
      "retrieval",
      "runStatus",
      "tools",
    ]);
    expect(Object.keys(facts.retrieval).sort()).toEqual(["chunkIds", "completed"]);
    expect(Object.keys(facts.tools).sort()).toEqual(["completed", "executed", "requested"]);
    expect(Object.keys(facts.report!).sort()).toEqual([
      "category",
      "confidence",
      "evidence",
      "evidenceState",
      "recommendationDisposition",
      "rootCausePresent",
      "suggestedActionTypes",
      "suggestedActions",
    ]);
  });

  it("rejects a non-JSON-safe recorded tool input (e.g. a BigInt argument) at normalization, rather than scoring a silent pass that fails later at serialization", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: VALID_REPORT,
      trace: [],
    };
    const executedTools: readonly RecordedToolExecution[] = [
      { toolName: "get_service_status", input: { count: 1n } },
    ];

    expect(() => buildObservedFacts(agentResult, executedTools)).toThrow(NonJsonSafeValueError);
  });

  describe("issue #57 — multi-step repeated-tool trace compatibility", () => {
    it("carries every requested/completed tool fact from a three-tool canonical trace, in deterministic order", () => {
      const agentResult: AgentOrchestratorResult = {
        status: "completed",
        report: VALID_REPORT,
        trace: [
          { type: "TOOL_REQUESTED", toolName: "get_service_status", toolCallId: "call-1" },
          { type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-1" },
          { type: "TOOL_REQUESTED", toolName: "get_service_status", toolCallId: "call-2" },
          { type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-2" },
          { type: "TOOL_REQUESTED", toolName: "get_service_status", toolCallId: "call-3" },
          { type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-3" },
        ],
      };
      const executedTools: readonly RecordedToolExecution[] = [
        {
          toolName: "get_service_status",
          input: { serviceSlug: "auth-service" },
          output: { serviceSlug: "auth-service", status: "OPERATIONAL" },
        },
        {
          toolName: "get_service_status",
          input: { serviceSlug: "billing-service" },
          output: { serviceSlug: "billing-service", status: "OUTAGE" },
        },
        {
          toolName: "get_service_status",
          input: { serviceSlug: "notification-service" },
          output: { serviceSlug: "notification-service", status: "DEGRADED" },
        },
      ];

      const facts = buildObservedFacts(agentResult, executedTools);

      // The array-shaped v2 facts carry all three repeats — never collapsed,
      // with each completed entry's paired recorded output (§4.3).
      expect(facts.tools.requested).toEqual([
        { toolName: "get_service_status", toolCallId: "call-1" },
        { toolName: "get_service_status", toolCallId: "call-2" },
        { toolName: "get_service_status", toolCallId: "call-3" },
      ]);
      expect(facts.tools.completed).toEqual([
        {
          toolName: "get_service_status",
          toolCallId: "call-1",
          output: { serviceSlug: "auth-service", status: "OPERATIONAL" },
        },
        {
          toolName: "get_service_status",
          toolCallId: "call-2",
          output: { serviceSlug: "billing-service", status: "OUTAGE" },
        },
        {
          toolName: "get_service_status",
          toolCallId: "call-3",
          output: { serviceSlug: "notification-service", status: "DEGRADED" },
        },
      ]);
      expect(facts.tools.executed).toHaveLength(3);
      expect(facts.runStatus).toBe("completed");
    });

    it("keeps a failed multi-step trace truthful: requested includes the failed call, completed excludes it", () => {
      const agentResult: AgentOrchestratorResult = {
        status: "failed",
        code: "TOOL_NOT_FOUND",
        message: "fixed message",
        failedStage: "DIAGNOSTIC_EXECUTION",
        trace: [
          { type: "TOOL_REQUESTED", toolName: "get_service_status", toolCallId: "call-1" },
          { type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-1" },
          { type: "TOOL_REQUESTED", toolName: "missing_tool", toolCallId: "call-2" },
        ],
      };
      const executedTools: readonly RecordedToolExecution[] = [
        {
          toolName: "get_service_status",
          input: { serviceSlug: "auth-service" },
          output: { serviceSlug: "auth-service", status: "OPERATIONAL" },
        },
      ];

      const facts = buildObservedFacts(agentResult, executedTools);

      expect(facts.runStatus).toBe("failed");
      expect(facts.errorCode).toBe("TOOL_NOT_FOUND");
      expect(facts.tools.requested).toEqual([
        { toolName: "get_service_status", toolCallId: "call-1" },
        { toolName: "missing_tool", toolCallId: "call-2" },
      ]);
      expect(facts.tools.completed).toEqual([
        {
          toolName: "get_service_status",
          toolCallId: "call-1",
          output: { serviceSlug: "auth-service", status: "OPERATIONAL" },
        },
      ]);
      expect(facts.tools.executed).toHaveLength(1);
      expect(facts.report).toBeNull();
    });
  });

  describe("ObservedFacts discriminated union (independent-review finding, High #1)", () => {
    it("compile-time: a completed run with a null report is now rejected — the exact contradictory shape TypeScript previously accepted", () => {
      // ObservedFacts ties runStatus/errorCode/report together; "completed"
      // requires a non-null report and errorCode: null. This is the exact
      // shape the independent review found TypeScript silently accepting,
      // which let a completed run with no report score both `status` and
      // `schema-handling` as passing.
      // @ts-expect-error — "completed" requires a non-null ReportFacts.
      const invalid: ObservedFacts = {
        runStatus: "completed",
        errorCode: null,
        retrieval: { completed: false, chunkIds: [] },
        tools: { requested: [], executed: [], completed: [] },
        report: null,
      };
      expect(invalid.runStatus).toBe("completed");
    });

    it("compile-time: a failed run with a non-null report is also rejected", () => {
      // "failed" requires report: null and a non-null errorCode.
      const invalid: ObservedFacts = {
        runStatus: "failed",
        errorCode: null,
        retrieval: { completed: false, chunkIds: [] },
        tools: { requested: [], executed: [], completed: [] },
        // @ts-expect-error — "failed" requires report: null and a full ReportFacts would not fit.
        report: { evidence: [], suggestedActionTypes: [] },
      };
      expect(invalid.runStatus).toBe("failed");
    });

    it("compile-time: a failed run with errorCode: null is rejected", () => {
      // The "failed" variant requires a real AgentOrchestratorErrorCode, not null.
      // @ts-expect-error — "failed" requires a real AgentOrchestratorErrorCode.
      const invalid: ObservedFacts = {
        runStatus: "failed",
        errorCode: null,
        retrieval: { completed: false, chunkIds: [] },
        tools: { requested: [], executed: [], completed: [] },
        report: null,
      };
      expect(invalid.runStatus).toBe("failed");
    });

    it("buildObservedFacts only ever constructs the two valid variants, for every real completed/failed status", () => {
      const completedFacts = buildObservedFacts(
        { status: "completed", report: VALID_REPORT, trace: [] },
        [],
      );
      expect(completedFacts.errorCode).toBeNull();
      expect(completedFacts.report).not.toBeNull();

      const failedFacts = buildObservedFacts(
        { status: "failed", code: "TOOL_NOT_FOUND", message: "m", trace: [], failedStage: "AGENT_ANALYSIS" },
        [],
      );
      expect(failedFacts.errorCode).toBe("TOOL_NOT_FOUND");
      expect(failedFacts.report).toBeNull();
    });
  });

  describe("Milestone-11 observation facts (OpsPilot #59 Checkpoint A §4) — lifecycle/assessment/turn/stop-reason derivation", () => {
    it("captures diagnostic assessments in canonical TOOL_REQUESTED event order — lifecycle ordering is deterministic", () => {
      const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
      const lifecycleEvents: InvestigationEventPayload[] = [
        {
          type: "TOOL_REQUESTED",
          toolName: "get_service_status",
          toolCallId: "call-1",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "NO_EVIDENCE_YET",
            supportedBy: [],
          },
        },
        {
          type: "TOOL_REQUESTED",
          toolName: "get_service_status",
          toolCallId: "call-2",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "STATUS_UNRESOLVED",
            supportedBy: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION" }],
          },
        },
      ];

      const facts = buildObservedFacts(agentResult, [], lifecycleEvents, []);

      // One entry per canonical TOOL_REQUESTED event, in recorded order —
      // never collapsed or reordered.
      expect(facts.investigation.assessments).toEqual([
        {
          toolCallId: "call-1",
          toolName: "get_service_status",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "NO_EVIDENCE_YET",
            supportedBy: [],
          },
        },
        {
          toolCallId: "call-2",
          toolName: "get_service_status",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "STATUS_UNRESOLVED",
            supportedBy: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION" }],
          },
        },
      ]);
      expect(facts.investigation.diagnosticRequestCount).toBe(2);
    });

    it("derives diagnostic assessments and tool failures only from their canonical lifecycle event types", () => {
      const agentResult: AgentOrchestratorResult = {
        status: "failed",
        code: "TOOL_EXECUTION_FAILED",
        message: "fixed message",
        trace: [],
        failedStage: "DIAGNOSTIC_EXECUTION",
      };
      const lifecycleEvents: InvestigationEventPayload[] = [
        { type: "RUN_CREATED" },
        { type: "AGENT_STARTED" },
        {
          type: "TOOL_REQUESTED",
          toolName: "get_service_status",
          toolCallId: "call-1",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "NO_EVIDENCE_YET",
            supportedBy: [],
          },
        },
        {
          type: "TOOL_FAILED",
          toolCallId: "call-1",
          toolName: "get_service_status",
          failureCode: "TOOL_EXECUTION_FAILED",
        },
        { type: "REPORT_SUBMITTED" },
      ];

      const facts = buildObservedFacts(agentResult, [], lifecycleEvents, []);

      expect(facts.investigation.assessments).toEqual([
        {
          toolCallId: "call-1",
          toolName: "get_service_status",
          assessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "NO_EVIDENCE_YET",
            supportedBy: [],
          },
        },
      ]);
      expect(facts.investigation.toolFailures).toEqual([
        { toolCallId: "call-1", toolName: "get_service_status", failureCode: "TOOL_EXECUTION_FAILED" },
      ]);
      expect(facts.investigation.diagnosticRequestCount).toBe(1);
    });

    it("derives provider turn and token totals deterministically from the recorded provider turns", () => {
      const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
      const providerTurns: RecordedProviderTurn[] = [
        { turnIndex: 0, phase: "INVESTIGATION", usage: { inputTokens: 10, outputTokens: 20 } },
        { turnIndex: 1, phase: "INVESTIGATION", usage: { inputTokens: 30, outputTokens: 40 } },
        { turnIndex: 2, phase: "FINALIZATION", usage: { inputTokens: 5, outputTokens: 8 } },
      ];

      const facts = buildObservedFacts(agentResult, [], [], providerTurns);

      expect(facts.investigation.providerTurnsUsed).toBe(3);
      expect(facts.investigation.usage).toEqual({ inputTokens: 45, outputTokens: 68, providerCalls: 3 });
    });

    it("stopReason uses the existing contract derivation — SUFFICIENT_EVIDENCE without forced finalization, BOUND_EXHAUSTED with it", () => {
      // SUFFICIENT_EVIDENCE: completed run, report evidenceState SUFFICIENT,
      // no REPORT_GENERATION_STARTED event → deriveInvestigationStopReason
      // returns "SUFFICIENT_EVIDENCE".
      const sufficientFacts = buildObservedFacts(
        { status: "completed", report: VALID_REPORT, trace: [] },
        [],
      );
      expect(sufficientFacts.investigation.stopReason).toBe("SUFFICIENT_EVIDENCE");
      expect(sufficientFacts.investigation.forcedFinalization).toBe(false);

      // BOUND_EXHAUSTED: forced finalization is REPORT_GENERATION_STARTED
      // present → deriveInvestigationStopReason returns "BOUND_EXHAUSTED",
      // overriding the evidence state.
      const forcedFacts = buildObservedFacts(
        { status: "completed", report: VALID_REPORT, trace: [] },
        [],
        [{ type: "REPORT_GENERATION_STARTED" }],
      );
      expect(forcedFacts.investigation.forcedFinalization).toBe(true);
      expect(forcedFacts.investigation.stopReason).toBe("BOUND_EXHAUSTED");

      // A failed run has no report evidenceState; with no forced finalization
      // the derivation yields null.
      const failedFacts = buildObservedFacts(
        { status: "failed", code: "TOOL_NOT_FOUND", message: "m", trace: [], failedStage: "DIAGNOSTIC_EXECUTION" },
        [],
      );
      expect(failedFacts.investigation.stopReason).toBeNull();
    });
  });
});
