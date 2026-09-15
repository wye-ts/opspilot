import { describe, expect, it, vi } from "vitest";

import { MAX_DIAGNOSTIC_TOOL_CALLS, MAX_PROVIDER_TURNS } from "@opspilot/contracts";

import { FakeLlmProvider, type FakeProviderTurn } from "../providers/fake-llm-provider";
import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

import { runAgentOrchestrator } from "./agent-orchestrator";

/**
 * Issue #107 — turn-budget pressure on the corrective-retry mechanisms.
 *
 * These are CHARACTERIZATION tests: they pin what the current bounds actually
 * produce, including the case where a correction cannot run at all. If #107
 * raises MAX_PROVIDER_TURNS, the third test below is expected to flip, and
 * that flip is the point — it is why the assertions capture the invocation
 * count rather than just "the run failed".
 *
 * Why this is testable without paid calls: eligibility is pure arithmetic over
 * turnIndex, so a scripted provider settles it deterministically. Eight real
 * LIVE runs on 2026-09-14/15 split by diagnostic calls used (2 -> 2 of 6
 * completed; 3 -> 0 of 2), and these tests explain that split mechanically
 * rather than by sampling more paid runs.
 *
 * MEASUREMENT WARNING, learned the hard way: the count of REPORT_SUBMITTED
 * events does NOT distinguish "correction ran and failed" from "correction
 * never ran". Per Issue #101 §2.3 a corrected-away attempt emits nothing, so
 * both shapes persist exactly one REPORT_SUBMITTED. Only the provider
 * invocation count separates them — and only under a scripted provider, since
 * in production it saturates at the turn ceiling. Never assert this class of
 * behavior on the event count.
 */
describe("corrective-retry availability under the turn budget (Issue #107)", () => {
  const usage = { inputTokens: 10, outputTokens: 5 };

  // Valid except that the suggested action cites an evidence locator absent
  // from `evidence` — the F5 violation behind every attributable real LIVE
  // failure observed so far.
  const reportViolatingF5 = {
    category: "AUTHENTICATION",
    summary: "Login failures began after the identity provider rotated its certificate.",
    rootCause: null,
    customerImpact: "Some users intermittently cannot log in.",
    recommendedResolution: "Redistribute the rotated certificate to the auth gateway fleet.",
    confidence: 0.6,
    evidenceState: "INSUFFICIENT",
    recommendationDisposition: "ACTIONABLE",
    evidence: [],
    suggestedActions: [
      {
        type: "CREATE_ESCALATION",
        payload: {
          team: "Identity",
          reason: "The identity provider certificate rotation needs owner review.",
          priority: "MEDIUM",
        },
        groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
      },
    ],
  };

  // Turn 0 has genuinely gathered nothing, so NO_EVIDENCE_YET with an empty
  // supportedBy is the truthful assessment. Every LATER turn has evidence (the
  // prior tool result) and must cite it — claiming NO_EVIDENCE_YET there trips
  // #99's A3 guard and ends the run before the budget question is reached.
  function firstDiagnosticTurn(callId: string): FakeProviderTurn {
    return {
      kind: "diagnostic_tool_requests",
      usage,
      requests: [
        {
          toolCallId: callId,
          toolName: "get_service_status",
          input: { serviceSlug: "notification-service" },
          rawAssessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "NO_EVIDENCE_YET",
            supportedBy: [],
          },
        },
      ],
    };
  }

  function followUpDiagnosticTurn(callId: string, citesCallId: string): FakeProviderTurn {
    return {
      kind: "diagnostic_tool_requests",
      usage,
      requests: [
        {
          toolCallId: callId,
          toolName: "get_service_status",
          input: { serviceSlug: "notification-service" },
          rawAssessment: {
            evidenceState: "INSUFFICIENT",
            continuationReason: "STATUS_UNRESOLVED",
            supportedBy: [{ evidenceId: citesCallId, sourceType: "TOOL_EXECUTION" }],
          },
        },
      ],
    };
  }

  async function run(turns: readonly FakeProviderTurn[]) {
    const emitted: { type: string }[] = [];
    const provider = new FakeLlmProvider({ id: "turn-budget-pressure", turns });
    const spy = vi.spyOn(provider, "runAgentTurn");

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [
        { role: "ticket_context", ticketId: "BUDGET-1", summary: "Intermittent login failures." },
      ],
      emitLifecycleEvent: async (payload) => {
        emitted.push(payload as { type: string });
      },
    });

    return {
      result,
      emitted,
      calls: spy.mock.calls.length,
      // The real discriminator: did a corrective-guidance entry ever reach the
      // provider? This is independent of the turn constants, unlike a raw call
      // count, which equals MAX_PROVIDER_TURNS whether or not a correction
      // fired.
      correctiveTurns: spy.mock.calls.filter(([input]) =>
        (input as { conversation?: readonly { role: string }[] }).conversation?.some(
          (entry) => entry.role === "corrective_guidance",
        ),
      ).length,
    };
  }

  it("the documented headroom bound currently holds with NO slack", () => {
    // docs/04-agent-design.md states MAX_DIAGNOSTIC_TOOL_CALLS <=
    // MAX_PROVIDER_TURNS - 1 and notes equality holds today. Every claim below
    // depends on that equality: it means the single non-diagnostic turn IS the
    // forced finalization turn, leaving nowhere for a corrected report to go.
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBe(MAX_PROVIDER_TURNS - 1);
  });

  it("the correction FIRES when the model leaves a spare turn", async () => {
    const { result, calls, correctiveTurns } = await run([
      firstDiagnosticTurn("call-1"),
      followUpDiagnosticTurn("call-2", "call-1"),
      // Voluntary report on turn 2, with turn 3 still free.
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
    ]);

    // The run still fails — both attempts are bad — but a FOURTH provider call
    // happened, which is only possible if the rejected report was corrected
    // and resubmitted.
    expect(result.status).toBe("failed");
    expect(calls).toBe(4);
    // A corrective prompt genuinely reached the provider.
    expect(correctiveTurns).toBe(1);
  });

  it("the correction CANNOT fire when all diagnostic calls are spent", async () => {
    const { result, emitted, calls, correctiveTurns } = await run([
      firstDiagnosticTurn("call-1"),
      followUpDiagnosticTurn("call-2", "call-1"),
      followUpDiagnosticTurn("call-3", "call-1"),
      // Turn 3 is the forced finalization turn — the only one left, and the
      // one #101's eligibility rule excludes.
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      // Scripted but UNREACHABLE under the current bound. Its presence is what
      // makes the assertion meaningful: the script can support a retry, and
      // the budget still prevents one.
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
    ]);

    expect(result.status).toBe("failed");

    // Only MAX_PROVIDER_TURNS calls happen, and the fifth scripted turn is
    // never consumed — the model never saw the corrective prompt, so this
    // run's failure says NOTHING about whether correction works.
    expect(calls).toBe(MAX_PROVIDER_TURNS);

    // THE assertion. The raw call count alone cannot express this: it equals
    // MAX_PROVIDER_TURNS whether or not a correction fired, so asserting it
    // would pass in both worlds and prove nothing. Under the current bound no
    // corrective prompt is ever built, so the model never had the chance to
    // fix its report.
    expect(correctiveTurns).toBe(0);

    // Documented deliberately: this count is NOT a usable discriminator — it
    // reads 1 here AND in the retried case above (Issue #101 §2.3).
    expect(emitted.filter((e) => e.type === "REPORT_SUBMITTED")).toHaveLength(1);
  });

  it("the A3 retry draws from the SAME budget as the report correction", async () => {
    // #99's A3 guard trips when the model claims NO_EVIDENCE_YET while evidence
    // already exists, and its retry also costs a provider turn — 2 of 3
    // instrumented real runs on 2026-09-15 fired it. Once it does, the run
    // reaches its report with one fewer turn available, so the two corrective
    // mechanisms compete rather than being independently budgeted.
    const { result, calls, correctiveTurns } = await run([
      firstDiagnosticTurn("call-1"),
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: "call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Evidence exists by now, so this claim is false -> A3 trips and
            // consumes the turn without executing a tool.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "NO_EVIDENCE_YET",
              supportedBy: [],
            },
          },
        ],
      },
      followUpDiagnosticTurn("call-3", "call-1"),
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
    ]);

    expect(result.status).toBe("failed");
    expect(calls).toBe(MAX_PROVIDER_TURNS);
    // Two, not one: a corrective-guidance entry is appended to the CONVERSATION
    // and therefore rides along on every subsequent turn. So this counts turns
    // that CARRIED corrective context, not corrective events — which is exactly
    // what the "CANNOT fire" test above needs (zero such turns means no
    // correction was ever built).
    //
    // The A3 correction consumed a turn here; the report correction that would
    // otherwise have followed the rejected report had no turn left to run on.
    expect(correctiveTurns).toBe(2);
  });
});
