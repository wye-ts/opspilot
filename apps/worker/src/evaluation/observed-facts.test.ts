import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";
import { NonJsonSafeValueError } from "./json-value";
import { buildObservedFacts, type ObservedFacts } from "./observed-facts";
import type { RecordedToolExecution } from "./recording-tool-registry";

const VALID_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "summary",
  rootCause: "root cause",
  customerImpact: "impact",
  recommendedResolution: "resolution",
  confidence: 0.5,
  evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "finding" }],
  evidenceState: "SUFFICIENT",
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

  it("derives tools.completed only from TOOL_COMPLETED trace events", () => {
    const agentResult: AgentOrchestratorResult = {
      status: "completed",
      report: VALID_REPORT,
      trace: [{ type: "TOOL_COMPLETED", toolName: "get_service_status", toolCallId: "call-1" }],
    };
    const facts = buildObservedFacts(agentResult, []);

    expect(facts.tools.completed).toEqual([{ toolName: "get_service_status", toolCallId: "call-1" }]);
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
        suggestedActions: [
          { type: "UPDATE_TICKET_STATUS", payload: { status: "IN_PROGRESS", reason: "reason" } },
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

  it("changing failedStage (not part of ObservedFacts) cannot affect normalized facts", () => {
    const resultA: AgentOrchestratorResult = {
      status: "failed",
      code: "TOOL_NOT_FOUND",
      message: "fixed message",
      trace: [],
      failedStage: "DIAGNOSTIC_EXECUTION",
    };
    const resultB: AgentOrchestratorResult = { ...resultA, failedStage: "AGENT_ANALYSIS" };

    expect(buildObservedFacts(resultA, [])).toEqual(buildObservedFacts(resultB, []));
  });

  it("produces exactly the nested v1 shape — top-level keys are runStatus/errorCode/retrieval/tools/report, nothing else", () => {
    const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };
    const facts = buildObservedFacts(agentResult, []);

    expect(Object.keys(facts).sort()).toEqual(["errorCode", "report", "retrieval", "runStatus", "tools"]);
    expect(Object.keys(facts.retrieval).sort()).toEqual(["chunkIds", "completed"]);
    expect(Object.keys(facts.tools).sort()).toEqual(["completed", "executed", "requested"]);
    expect(Object.keys(facts.report!).sort()).toEqual(["evidence", "suggestedActionTypes"]);
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
        { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
        { toolName: "get_service_status", input: { serviceSlug: "billing-service" } },
        { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
      ];

      const facts = buildObservedFacts(agentResult, executedTools);

      // The array-shaped v1 facts carry all three repeats — never collapsed.
      expect(facts.tools.requested).toEqual([
        { toolName: "get_service_status", toolCallId: "call-1" },
        { toolName: "get_service_status", toolCallId: "call-2" },
        { toolName: "get_service_status", toolCallId: "call-3" },
      ]);
      expect(facts.tools.completed).toEqual([
        { toolName: "get_service_status", toolCallId: "call-1" },
        { toolName: "get_service_status", toolCallId: "call-2" },
        { toolName: "get_service_status", toolCallId: "call-3" },
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
        { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
      ];

      const facts = buildObservedFacts(agentResult, executedTools);

      expect(facts.runStatus).toBe("failed");
      expect(facts.errorCode).toBe("TOOL_NOT_FOUND");
      expect(facts.tools.requested).toEqual([
        { toolName: "get_service_status", toolCallId: "call-1" },
        { toolName: "missing_tool", toolCallId: "call-2" },
      ]);
      expect(facts.tools.completed).toEqual([{ toolName: "get_service_status", toolCallId: "call-1" }]);
      expect(facts.tools.executed).toHaveLength(1);
      expect(facts.report).toBeNull();
    });
  });

  describe("ObservedFacts discriminated union (independent-review finding, High #1)", () => {
    it("compile-time: a completed run with a null report is now rejected — the exact contradictory shape TypeScript previously accepted", () => {
      // @ts-expect-error — ObservedFacts ties runStatus/errorCode/report
      // together; "completed" requires a non-null report and errorCode: null.
      // This is the exact shape the independent review found TypeScript
      // silently accepting, which let a completed run with no report score
      // both `status` and `schema-handling` as passing.
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
      // @ts-expect-error — "failed" requires report: null and a non-null errorCode.
      const invalid: ObservedFacts = {
        runStatus: "failed",
        errorCode: null,
        retrieval: { completed: false, chunkIds: [] },
        tools: { requested: [], executed: [], completed: [] },
        report: { evidence: [], suggestedActionTypes: [] },
      };
      expect(invalid.runStatus).toBe("failed");
    });

    it("compile-time: a failed run with errorCode: null is rejected", () => {
      // @ts-expect-error — the "failed" variant requires a real AgentOrchestratorErrorCode, not null.
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
});
