import { inspect } from "node:util";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { LlmProvider } from "@opspilot/agent-runtime";
import { MAX_PROVIDER_TURNS } from "@opspilot/contracts";
import { describe, expect, it, vi } from "vitest";

import type { EnvRecord } from "@opspilot/provider-claude";
import {
  PAID_CALL_WARNING,
  SMOKE_MAX_OUTPUT_TOKENS,
  SMOKE_TOTAL_DEADLINE_MS,
  evaluateSmokeGate,
  main,
  runSmokeScenario,
} from "./claude-live-smoke";

const { FakeLlmProvider } = opspilotAgentRuntime;

const SECRET = "sk-ant-test-do-not-use-0123456789";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    OPSPILOT_LIVE_SMOKE: "1",
    AGENT_RUN_PROVIDER_MODE: "LIVE",
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    ...overrides,
  };
}

describe("live smoke gate", () => {
  it("accepts a fully valid invocation", () => {
    const gate = evaluateSmokeGate(validEnv());

    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error("unreachable");
    expect(gate.config.selection).toEqual({
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
    });
    expect(gate.config.anthropic.timeoutMs).toBe(45_000);
    expect(gate.config.anthropic.maxRetries).toBe(1);
  });

  it("refuses without the explicit opt-in flag", () => {
    const gate = evaluateSmokeGate(validEnv({ OPSPILOT_LIVE_SMOKE: undefined }));

    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.reason).toMatch(/OPSPILOT_LIVE_SMOKE/);
  });

  it.each(["0", "true", "yes", ""])("refuses the non-authorizing opt-in value %o", (value) => {
    expect(evaluateSmokeGate(validEnv({ OPSPILOT_LIVE_SMOKE: value })).ok).toBe(false);
  });

  it("refuses in FAKE mode rather than silently running the deterministic provider", () => {
    const gate = evaluateSmokeGate(validEnv({ AGENT_RUN_PROVIDER_MODE: "FAKE" }));

    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.reason).toMatch(/AGENT_RUN_PROVIDER_MODE must be "LIVE"/);
  });

  it("refuses when the mode is unset, which would otherwise default to FAKE", () => {
    expect(evaluateSmokeGate(validEnv({ AGENT_RUN_PROVIDER_MODE: undefined })).ok).toBe(false);
  });

  it("refuses without an API key", () => {
    const gate = evaluateSmokeGate(validEnv({ ANTHROPIC_API_KEY: undefined }));

    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("unreachable");
    expect(gate.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it.each(["claude-opus-5", "claude-haiku-4-5", "sonnet-5", ""])(
    "refuses the wrong model %o",
    (model) => {
      expect(evaluateSmokeGate(validEnv({ ANTHROPIC_MODEL: model })).ok).toBe(false);
    },
  );

  it("does not re-expose the key through JSON serialization of the gate result", () => {
    // Regression guard: an earlier shape copied apiKey into a plain property on
    // the gate result, which silently defeated the config's redaction hooks.
    const gate = evaluateSmokeGate(validEnv());

    const serialized = JSON.stringify(gate);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted]");
  });

  it("does not re-expose the key through inspection of the gate result", () => {
    const gate = evaluateSmokeGate(validEnv());

    expect(inspect(gate, { depth: null })).not.toContain(SECRET);
  });

  it("does not re-expose the key through enumeration or spread of the nested config", () => {
    const gate = evaluateSmokeGate(validEnv());
    if (!gate.ok) throw new Error("unreachable");

    expect(Object.keys(gate.config.anthropic)).not.toContain("apiKey");
    expect(JSON.stringify({ ...gate.config.anthropic })).not.toContain(SECRET);
    expect(Object.keys({ ...gate.config.anthropic })).not.toContain("apiKey");
  });

  it("still lets the runner read the key through the intended non-enumerable property", () => {
    // The protections must hide the key from accidental output without making
    // it unreachable for the one caller that legitimately needs it.
    const gate = evaluateSmokeGate(validEnv());
    if (!gate.ok) throw new Error("unreachable");

    expect(gate.config.anthropic.apiKey).toBe(SECRET);
  });

  it("never puts the API key in a refusal reason", () => {
    for (const env of [
      validEnv({ ANTHROPIC_MODEL: "claude-opus-5" }),
      validEnv({ ANTHROPIC_TIMEOUT_MS: "nope" }),
      validEnv({ AGENT_RUN_PROVIDER_MODE: "FAKE" }),
    ]) {
      const gate = evaluateSmokeGate(env);
      expect(gate.ok).toBe(false);
      if (gate.ok) throw new Error("unreachable");
      expect(gate.reason).not.toContain(SECRET);
    }
  });
});

describe("live smoke main — no network", () => {
  it("exits non-zero and prints no paid-call warning when the gate rejects", async () => {
    const log = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await main(validEnv({ OPSPILOT_LIVE_SMOKE: undefined }), log);

    expect(exitCode).toBe(1);
    // Nothing was attempted, so the user must not be told a paid call happened.
    expect(log).not.toHaveBeenCalledWith(PAID_CALL_WARNING);
    errorSpy.mockRestore();
  });

  it.each([
    ["missing opt-in", validEnv({ OPSPILOT_LIVE_SMOKE: undefined })],
    ["FAKE mode", validEnv({ AGENT_RUN_PROVIDER_MODE: "FAKE" })],
    ["missing key", validEnv({ ANTHROPIC_API_KEY: undefined })],
    ["wrong model", validEnv({ ANTHROPIC_MODEL: "claude-opus-5" })],
  ])("exits non-zero for %s without falling back to FAKE", async (_name, env) => {
    const log = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await main(env as EnvRecord, log);

    expect(exitCode).toBe(1);
    // A fallback run would have produced trace or PASSED output.
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(printed).not.toContain("PASSED");
    expect(printed).not.toContain("trace=");
    errorSpy.mockRestore();
  });
});

describe("live smoke scenario wiring", () => {
  it("passes the low output budget and the provider-call deadline through to the turn", async () => {
    // Uses the deterministic provider purely as a recording stand-in: this
    // asserts the orchestrator wiring, and makes no live call.
    const seen: { maxOutputTokens: number | undefined; signal: AbortSignal | undefined } = {
      maxOutputTokens: undefined,
      signal: undefined,
    };
    const controller = new AbortController();

    await runSmokeScenario({
      createProvider: () => ({
        async runAgentTurn(input) {
          seen.maxOutputTokens = input.maxOutputTokens;
          seen.signal = input.signal;
          return {
            type: "protocol_error",
            code: "PROVIDER_PROTOCOL_INVALID",
            message: "stop here",
          };
        },
      }),
      signal: controller.signal,
      log: () => {},
    });

    expect(seen.maxOutputTokens).toBe(SMOKE_MAX_OUTPUT_TOKENS);
    expect(seen.signal).toBe(controller.signal);
  });

  it("keeps the smoke budget small and the provider-call deadline bounded", () => {
    expect(SMOKE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(2048);
    expect(SMOKE_TOTAL_DEADLINE_MS).toBe(120_000);
  });

  it("surfaces a failed agent result rather than reporting success", async () => {
    const result = await runSmokeScenario({
      createProvider: () => new FakeLlmProvider({ id: "empty", turns: [] }),
      signal: AbortSignal.timeout(1000),
      log: () => {},
    }).catch(() => null);

    // An empty scenario throws inside the fake provider; either way the
    // scenario must not resolve to a completed run.
    expect(result === null || result.status !== "completed").toBe(true);
  });
});

describe("live smoke bounded multi-step run (MINOR closure fix)", () => {
  const TOOL_CALL_IDS = ["call-a", "call-b", "call-c"] as const;

  // Deterministic fake provider that drives the full #57 bound: three
  // INVESTIGATION diagnostic turns, then a FINALIZATION report. Records every
  // invocation so the test can assert the exact provider-call count and phase
  // order. No network, no clock, no AbortSignal.timeout — fully deterministic.
  function buildBoundedProvider() {
    const calls: Array<{ turnIndex: number; phase: string }> = [];
    const requestedToolCallIds: string[] = [];

    const provider: LlmProvider = {
      async runAgentTurn(input) {
        calls.push({ turnIndex: input.turnIndex, phase: input.phase });

        if (input.phase === "FINALIZATION") {
          return {
            type: "report_submission",
            providerRequestId: "req-finalization",
            usage: { inputTokens: 1, outputTokens: 1 },
            rawInput: {
              category: "SERVICE_DEGRADATION",
              summary: "Notification delivery is delayed for some customers.",
              rootCause: "notification-service is running in a degraded state.",
              customerImpact:
                "Some customers are experiencing delayed notification emails.",
              recommendedResolution:
                "Escalate to the messaging platform team to investigate notification-service degradation.",
              confidence: 0.9,
              evidence: [
                {
                  evidenceId: TOOL_CALL_IDS[2],
                  sourceType: "TOOL_EXECUTION",
                  finding: "notification-service reported status DEGRADED.",
                },
              ],
              evidenceState: "SUFFICIENT",
              suggestedActions: [],
            },
          };
        }

        // Literal indexes keep the ids definitely-typed under
        // noUncheckedIndexedAccess: INVESTIGATION turns are turnIndex 0..2.
        const toolCallId =
          input.turnIndex === 0
            ? TOOL_CALL_IDS[0]
            : input.turnIndex === 1
              ? TOOL_CALL_IDS[1]
              : TOOL_CALL_IDS[2];
        requestedToolCallIds.push(toolCallId);
        return {
          type: "diagnostic_tool_request",
          providerRequestId: `req-${toolCallId}`,
          usage: { inputTokens: 1, outputTokens: 1 },
          request: {
            toolCallId,
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
          },
        };
      },
    };

    return { provider, calls, requestedToolCallIds };
  }

  it("drives three diagnostic turns plus a finalization report with exactly four provider calls", async () => {
    const { provider, calls, requestedToolCallIds } = buildBoundedProvider();

    const result = await runSmokeScenario({
      createProvider: () => provider,
      // One AbortController for the whole run, threaded to every provider turn —
      // the same aggregate-deadline shape the live smoke uses. No wall-clock wait.
      signal: new AbortController().signal,
      log: () => {},
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // Provider invoked exactly four times — no retry storm, no early exit.
    expect(calls).toHaveLength(4);
    // First three turns are INVESTIGATION; finalization stays the fourth turn.
    expect(calls.slice(0, 3).map((call) => call.phase)).toEqual([
      "INVESTIGATION",
      "INVESTIGATION",
      "INVESTIGATION",
    ]);
    expect(calls[3]?.phase).toBe("FINALIZATION");
    // The three accepted diagnostic toolCallIds are distinct, and every one
    // actually executed (successfulToolExecutionIds gates report evidence).
    const completedToolCallIds = result.trace
      .filter((event) => event.type === "TOOL_COMPLETED")
      .map((event) => event.toolCallId);
    expect(completedToolCallIds).toEqual(["call-a", "call-b", "call-c"]);
    expect(new Set(completedToolCallIds).size).toBe(3);
    expect(requestedToolCallIds).toEqual(["call-a", "call-b", "call-c"]);
    // The accepted report references an executed tool-call evidence id.
    expect(result.report.evidence[0]?.evidenceId).toBe("call-c");
  });

  it("advertises the same max provider-call bound the orchestrator enforces before any call", () => {
    // The pre-call warning is derived from the same reviewed shared constant
    // the orchestrator uses as its provider-turn loop bound, so a change to the
    // runtime bound fails this test instead of silently drifting the warning.
    expect(PAID_CALL_WARNING).toContain(String(MAX_PROVIDER_TURNS));
  });
});
