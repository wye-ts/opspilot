import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentTurnInput, FakeAgentScenario, LlmProvider } from "@opspilot/agent-runtime";
import type { AgentTurnResult, ResolutionReport } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import {
  hasFailingScenario,
  runForcedFinalizationProbe,
  runToolThenReportScenario,
  type SpikeScenarioResult,
} from "./claude-agent-spike-scenarios";

const { FakeLlmProvider, LlmProviderError } = opspilotAgentRuntime;

const usage = { inputTokens: 100, outputTokens: 20 };

const validReport: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause: "notification-service is degraded.",
  customerImpact: "Some customers are receiving delayed notifications.",
  recommendedResolution: "Monitor notification-service until it recovers.",
  confidence: 0.8,
  evidence: [
    { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "notification-service reported DEGRADED." },
  ],
  suggestedActions: [],
};

// A minimal stand-in LlmProvider for exercising exactly one runAgentTurn
// outcome per test, without any network involvement.
class ScriptedProvider implements LlmProvider {
  constructor(private readonly behavior: () => Promise<AgentTurnResult>) {}
  async runAgentTurn(_input: AgentTurnInput): Promise<AgentTurnResult> {
    return this.behavior();
  }
}

class ThrowingProvider implements LlmProvider {
  constructor(private readonly error: unknown) {}
  async runAgentTurn(_input: AgentTurnInput): Promise<AgentTurnResult> {
    throw this.error;
  }
}

describe("hasFailingScenario", () => {
  it("is false when every scenario passed", () => {
    const results: SpikeScenarioResult[] = [{ name: "a", passed: true }, { name: "b", passed: true }];
    expect(hasFailingScenario(results)).toBe(false);
  });

  it("is true when at least one scenario failed", () => {
    const results: SpikeScenarioResult[] = [
      { name: "a", passed: true },
      { name: "b", passed: false, failureCode: "SOMETHING" },
    ];
    expect(hasFailingScenario(results)).toBe(true);
  });

  it("is false for an empty result list", () => {
    expect(hasFailingScenario([])).toBe(false);
  });
});

describe("runToolThenReportScenario", () => {
  it("passes when the orchestrator completes", async () => {
    const scenario: FakeAgentScenario = {
      id: "pass",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage,
          requests: [{ toolCallId: "call-1", toolName: "get_service_status", input: { serviceSlug: "notification-service" } }],
        },
        { kind: "report_submission", usage, rawInput: validReport },
      ],
    };

    const result = await runToolThenReportScenario(new FakeLlmProvider(scenario));

    expect(result).toEqual({ name: "tool-then-report", passed: true });
  });

  it("fails with the orchestrator's failure code when the report fails schema validation", async () => {
    const scenario: FakeAgentScenario = {
      id: "fail-schema",
      turns: [{ kind: "report_submission", usage, rawInput: { category: "SERVICE_DEGRADATION" } }],
    };

    const result = await runToolThenReportScenario(new FakeLlmProvider(scenario));

    expect(result).toEqual({
      name: "tool-then-report",
      passed: false,
      failureCode: "REPORT_SCHEMA_INVALID",
    });
  });

  it("fails with LLM_PROVIDER_ERROR_<category> when the provider throws LlmProviderError", async () => {
    const provider = new ThrowingProvider(new LlmProviderError("RATE_LIMIT", "sanitized message"));

    const result = await runToolThenReportScenario(provider);

    expect(result).toEqual({
      name: "tool-then-report",
      passed: false,
      failureCode: "LLM_PROVIDER_ERROR_RATE_LIMIT",
    });
  });

  it("rethrows an error that is not LlmProviderError instead of swallowing it", async () => {
    const provider = new ThrowingProvider(new Error("unexpected bug"));

    await expect(runToolThenReportScenario(provider)).rejects.toThrow("unexpected bug");
  });
});

function buildReportSubmissionResult(rawInput: unknown): AgentTurnResult {
  return {
    type: "report_submission",
    providerRequestId: "req-1",
    usage,
    rawInput,
  };
}

describe("runForcedFinalizationProbe", () => {
  // Regression coverage for a live-run defect: Claude cited a fabricated
  // evidence id ("toolu_get_service_status_1") instead of the real
  // toolCallId ("call-1") it was never actually shown as a plain string.
  // validReport.evidence[0].evidenceId is exactly "call-1", matching the
  // seeded PROBE_TOOL_CALL_ID — this proves the surfaced exact id passes.
  it("passes when the report cites the exact surfaced evidenceId (call-1)", async () => {
    const provider = new ScriptedProvider(async () => buildReportSubmissionResult(validReport));

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({ name: "forced-finalization-probe", passed: true });
  });

  it("fails when the report cites an invented evidence id shaped like a tool_use id, not the real toolCallId", async () => {
    const provider = new ScriptedProvider(async () =>
      buildReportSubmissionResult({
        ...validReport,
        evidence: [
          {
            evidenceId: "toolu_get_service_status_1",
            sourceType: "TOOL_EXECUTION",
            finding: "invented id, not the real call-1 toolCallId",
          },
        ],
      }),
    );

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({
      name: "forced-finalization-probe",
      passed: false,
      failureCode: "REPORT_EVIDENCE_INVALID",
    });
  });

  it("fails with UNEXPECTED_RESULT_TYPE_<type> when the provider returns anything other than report_submission", async () => {
    const provider = new ScriptedProvider(async () => ({
      type: "protocol_error",
      code: "PROVIDER_PROTOCOL_INVALID",
      message: "no tool call at all",
    }));

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({
      name: "forced-finalization-probe",
      passed: false,
      failureCode: "UNEXPECTED_RESULT_TYPE_protocol_error",
    });
  });

  it("fails with REPORT_SCHEMA_INVALID when rawInput fails ResolutionReportSchema", async () => {
    const provider = new ScriptedProvider(async () =>
      buildReportSubmissionResult({ category: "SERVICE_DEGRADATION" }),
    );

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({
      name: "forced-finalization-probe",
      passed: false,
      failureCode: "REPORT_SCHEMA_INVALID",
    });
  });

  it("fails with REPORT_EVIDENCE_INVALID when the report cites a tool call id other than the seeded one", async () => {
    const provider = new ScriptedProvider(async () =>
      buildReportSubmissionResult({
        ...validReport,
        evidence: [
          { evidenceId: "call-999", sourceType: "TOOL_EXECUTION", finding: "wrong id" },
        ],
      }),
    );

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({
      name: "forced-finalization-probe",
      passed: false,
      failureCode: "REPORT_EVIDENCE_INVALID",
    });
  });

  it("fails with LLM_PROVIDER_ERROR_<category> when the provider throws LlmProviderError", async () => {
    const provider = new ThrowingProvider(new LlmProviderError("TIMEOUT", "sanitized message"));

    const result = await runForcedFinalizationProbe(provider);

    expect(result).toEqual({
      name: "forced-finalization-probe",
      passed: false,
      failureCode: "LLM_PROVIDER_ERROR_TIMEOUT",
    });
  });

  it("rethrows an error that is not LlmProviderError instead of swallowing it", async () => {
    const provider = new ThrowingProvider(new Error("unexpected bug"));

    await expect(runForcedFinalizationProbe(provider)).rejects.toThrow("unexpected bug");
  });
});
