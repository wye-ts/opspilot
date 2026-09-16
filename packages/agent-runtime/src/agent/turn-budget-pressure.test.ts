import { describe, expect, it, vi } from "vitest";

import { MAX_DIAGNOSTIC_TOOL_CALLS, MAX_PROVIDER_TURNS } from "@opspilot/contracts";

import { FakeLlmProvider, type FakeProviderTurn } from "../providers/fake-llm-provider";
import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

import { runAgentOrchestrator } from "./agent-orchestrator";

/**
 * Issue #107 — turn-budget pressure on the corrective-retry mechanisms.
 *
 * ORIGINALLY characterization tests written at the 4/3 bounds, pinning the case
 * where a correction could not run at all. #107 raised MAX_PROVIDER_TURNS to 5
 * and the third test DID flip, exactly as this file predicted it would — that
 * flip was the point, and the assertions were built around the one signal that
 * can express it.
 *
 * They now serve the inverted purpose: proving the headroom is real and stays
 * real. The mechanism they measure is the same.
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

  // Issue #114: identical to reportViolatingF5 except the cited groundedBy
  // locator ("call-unconfirmed") never corresponds to any diagnostic tool
  // call in this file's turn sequences — auto-completion's confirmation gate
  // (§2.4) always rejects it, so tests using this fixture keep exercising
  // the #101/#107 retry-under-turn-budget-pressure path they were written to
  // test. reportViolatingF5 itself (citing "call-1") is now auto-healed by
  // #114 whenever a real "call-1" diagnostic tool call ran earlier in the
  // sequence — which every test below does — so this file uses the
  // unconfirmable variant throughout instead.
  const reportViolatingF5Unconfirmable = {
    ...reportViolatingF5,
    suggestedActions: [
      {
        ...reportViolatingF5.suggestedActions[0],
        groundedBy: [{ evidenceId: "call-unconfirmed", sourceType: "TOOL_EXECUTION" as const }],
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

  it("the documented headroom bound now holds with SLACK", () => {
    // Was: "currently holds with NO slack", asserting equality. #107 replaced
    // the equality with slack, which is the whole point of the issue — the
    // single non-diagnostic turn used to BE the forced finalization turn,
    // leaving nowhere for a corrected report to go.
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBeLessThan(MAX_PROVIDER_TURNS - 1);
  });

  it("the correction FIRES when the model leaves a spare turn", async () => {
    const { result, calls, correctiveTurns } = await run([
      firstDiagnosticTurn("call-1"),
      followUpDiagnosticTurn("call-2", "call-1"),
      // Voluntary report on turn 2, with turn 3 still free.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
    ]);

    // The run still fails — both attempts are bad — but a FOURTH provider call
    // happened, which is only possible if the rejected report was corrected
    // and resubmitted.
    expect(result.status).toBe("failed");
    expect(calls).toBe(4);
    // A corrective prompt genuinely reached the provider.
    expect(correctiveTurns).toBe(1);
  });

  it("the correction NOW FIRES even when all diagnostic calls are spent", async () => {
    // THE test this issue exists for. At the old 4/3 bounds this asserted
    // correctiveTurns === 0: the report landed on the forced finalization turn,
    // #101's eligibility rule excluded it, and the model never saw a corrective
    // prompt — so such a run's failure said NOTHING about whether correction
    // works. Real data agreed: of 8 LIVE runs, the 2 that spent all three
    // diagnostic calls completed 0 times.
    //
    // With slack, the report lands on turn 3 and turn 4 remains, so the
    // correction is built and delivered. The assertion is inverted rather than
    // deleted, deliberately: a future change that restores equality would
    // silently reinstate the defect, and this goes red when it does.
    const { result, emitted, calls, correctiveTurns } = await run([
      firstDiagnosticTurn("call-1"),
      followUpDiagnosticTurn("call-2", "call-1"),
      followUpDiagnosticTurn("call-3", "call-1"),
      // Turn 3 — budget exhausted. The report turn, with turn 4 still after it.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
      // Turn 4 — the corrected resubmission. Still invalid here, so the run
      // fails: this test measures whether the correction RAN, not whether the
      // model got it right. Those are different claims and only the first is
      // deterministically provable.
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
    ]);

    expect(result.status).toBe("failed");
    expect(calls).toBe(MAX_PROVIDER_TURNS);

    // THE assertion, inverted from 0. The raw call count cannot express this:
    // it equals MAX_PROVIDER_TURNS whether or not a correction fired, so
    // asserting it would pass in both worlds and prove nothing.
    expect(correctiveTurns).toBeGreaterThan(0);

    // Unchanged and still worth pinning: this count is NOT a usable
    // discriminator — it reads 1 whether or not the correction ran
    // (Issue #101 §2.3).
    expect(emitted.filter((e) => e.type === "REPORT_SUBMITTED")).toHaveLength(1);
  });

  it("the A3 retry and the report correction draw from the SAME budget — but both now fit", async () => {
    // #99's A3 guard trips when the model claims NO_EVIDENCE_YET while evidence
    // already exists, and its retry also costs a provider turn — 2 of 3
    // instrumented real runs on 2026-09-15 fired it. The two corrective
    // mechanisms therefore compete for one shared budget rather than being
    // independently funded, which is the fact this test pins.
    //
    // At the old 4/3 bounds, competing meant losing: the A3 correction consumed
    // the slack and the later report correction had no turn left to run on.
    // With #107's headroom both fit — the A3 retry rides turn 1, the report
    // still reaches turn 3, and turn 4 carries its correction.
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
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
      { kind: "report_submission", usage, rawInput: reportViolatingF5Unconfirmable },
    ]);

    expect(result.status).toBe("failed");
    expect(calls).toBe(MAX_PROVIDER_TURNS);

    // Counts turns that CARRIED corrective context, not corrective events: an
    // entry is appended to the CONVERSATION and rides along on every subsequent
    // turn. One A3 trip on turn 1 therefore marks turns 2, 3 and 4.
    //
    // Was 2 at the old bounds, where the run ended a turn earlier. The value
    // matters less than what it proves: a corrective prompt reached the
    // provider, and the extra turn did not come out of the report path's slot.
    expect(correctiveTurns).toBe(3);
  });
});
