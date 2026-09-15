import { describe, expect, it } from "vitest";

import {
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  deriveExecutionStageProgress,
  type InvestigationEventPayload,
} from "@opspilot/contracts";

import { FakeLlmProvider, type FakeProviderTurn } from "../providers/fake-llm-provider";
import { LlmProviderError, type LlmProvider } from "../providers/llm-provider";
import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

import { runAgentOrchestrator } from "./agent-orchestrator";

/**
 * Issue #107 — the orchestrator's emitted stream, validated by the REAL reducer.
 *
 * WHY THIS FILE EXISTS. Every other orchestrator test uses a collecting emitter
 * that appends payloads and validates nothing, so the canonical ledger's
 * ordering, singleton, and stage-truthfulness rules are invisible to them. That
 * gap is not theoretical: raising MAX_PROVIDER_TURNS to 5 produced a stream the
 * real reducer REJECTS while 342 of 343 contracts tests and every orchestrator
 * test except a hard-coded constant assertion still passed. A rejected stream
 * does not fail a run cleanly — persistence returns unavailable and the run is
 * left RUNNING, which is worse than the bug #107 set out to fix.
 *
 * THE COUPLING UNDER TEST. The reducer requires REPORT_GENERATION_STARTED once
 * `toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS`, on the grounds that the next
 * provider call must then be the forced finalization turn. The orchestrator
 * used to emit it iff the turn was positionally last. Those two conditions
 * coincided ONLY while MAX_DIAGNOSTIC_TOOL_CALLS === MAX_PROVIDER_TURNS - 1.
 * #107 introduces slack and therefore splits them apart, so the orchestrator
 * now derives the report-stage transition from the exhausted-or-final condition
 * itself.
 *
 * MEASURED BASELINES at 5/3 against the OLD positional rule — these are what
 * make the suite meaningful, and they were observed, not assumed:
 *
 *   case 1 (valid report on the first announced turn)  -> MISSING_LIFECYCLE_FACT
 *   case 2 (rejected then corrected on the final turn) -> ACCEPTED
 *   case 3 (provider failure on the announced turn)    -> FAILED_STAGE_NOT_TRUTHFUL
 *
 * Cases 1 and 3 are the red-first tests. CASE 2 PASSES BOTH BEFORE AND AFTER and
 * is deliberately not a red-first test: it guards the duplicate-emission defect
 * (a naive "emit whenever exhausted OR final" rule fires the singleton twice and
 * the reducer rejects it with DUPLICATE_LIFECYCLE_FACT). Do not "fix" case 2 by
 * making it fail first — see docs/reviews/41-issue-107-...-plan.md §2.3a, where
 * an earlier draft of exactly that criterion was withdrawn as unsatisfiable.
 *
 * None of these shapes exists at the old 4/3 bounds: there, the first turn after
 * the budget is exhausted IS the forced finalization turn, so the positional
 * rule announces it correctly and there is nothing to observe.
 */
describe("emitted stream against the real reducer (Issue #107)", () => {
  const usage = { inputTokens: 10, outputTokens: 5 };
  const runId = "8f14e45f-1234-4abc-8def-000000000107";

  const validReport = {
    category: "SERVICE_DEGRADATION",
    summary: "Notification service reported a degraded status.",
    rootCause: null,
    customerImpact: "Delayed notifications for a subset of users.",
    recommendedResolution: "No action required; monitor for regression.",
    confidence: 0.6,
    evidenceState: "INSUFFICIENT",
    recommendationDisposition: "ADVISORY",
    evidence: [
      {
        evidenceId: "call-1",
        sourceType: "TOOL_EXECUTION",
        finding: "get_service_status returned a status for the notification service.",
        supports: [],
      },
    ],
    suggestedActions: [],
  };

  // F5: the action cites a locator absent from `evidence` — the violation
  // behind every attributable real LIVE failure so far.
  const reportViolatingF5 = {
    ...validReport,
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
  // supportedBy is truthful. Every later turn has the prior tool result and
  // must cite it, or #99's A3 guard trips and ends the run before the budget
  // question is reached.
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

  /** Spends every diagnostic call, one per investigation turn. */
  function allDiagnosticsSpent(): FakeProviderTurn[] {
    const turns: FakeProviderTurn[] = [firstDiagnosticTurn("call-1")];
    for (let index = 1; index < MAX_DIAGNOSTIC_TOOL_CALLS; index++) {
      turns.push(followUpDiagnosticTurn(`call-${index + 1}`, "call-1"));
    }
    return turns;
  }

  async function run(turns: readonly FakeProviderTurn[]) {
    const emitted: InvestigationEventPayload[] = [];
    const result = await runAgentOrchestrator({
      provider: new FakeLlmProvider({ id: "real-reducer", turns }),
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [
        { role: "ticket_context", ticketId: "LEDGER-107", summary: "Intermittent login failures." },
      ],
      emitLifecycleEvent: async (payload) => {
        emitted.push(payload);
      },
    });
    return { result, emitted };
  }

  /**
   * Runs the scripted turns, then makes the NEXT provider call throw — the real
   * mechanism by which a transport failure reaches the orchestrator. Used to
   * exercise a failure landing on the first exhausted-budget turn.
   */
  async function runThenFail(turns: readonly FakeProviderTurn[]) {
    const emitted: InvestigationEventPayload[] = [];
    const scripted = new FakeLlmProvider({ id: "real-reducer-fail", turns });
    const provider: LlmProvider = {
      runAgentTurn: async (input) => {
        if (input.turnIndex >= turns.length) {
          throw new LlmProviderError("SERVER_ERROR", "sanitized provider message");
        }
        return scripted.runAgentTurn(input);
      },
    };

    const result = await runAgentOrchestrator({
      provider,
      toolRegistry: new InMemoryToolRegistry([getServiceStatusTool]),
      initialConversation: [
        { role: "ticket_context", ticketId: "LEDGER-107", summary: "Intermittent login failures." },
      ],
      emitLifecycleEvent: async (payload) => {
        emitted.push(payload);
      },
    });
    return { result, emitted };
  }

  /**
   * Feeds the ACTUAL emitted payloads to the ACTUAL reducer. Returns rather than
   * throws so a rejection can be asserted on precisely — a bare expect(...).toThrow()
   * would pass for the wrong contract error and hide which rule fired.
   */
  function reduce(
    emitted: readonly InvestigationEventPayload[],
    terminal: InvestigationEventPayload,
    runStatus: "COMPLETED" | "FAILED",
  ): { ok: true } | { ok: false; code: string } {
    const payloads: InvestigationEventPayload[] = [
      { type: "RUN_CREATED" },
      ...emitted,
      terminal,
    ];
    const events = payloads.map((payload, index) => ({
      runId,
      sequence: index + 1,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload,
    }));

    try {
      const progress = deriveExecutionStageProgress({
        events,
        runStatus,
        now: events[events.length - 1]!.recordedAt,
      });
      for (const stage of progress) {
        expect(["completed", "failed", "omitted"]).toContain(stage.status);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "UNKNOWN" };
    }
  }

  const reportStartCount = (emitted: readonly InvestigationEventPayload[]): number =>
    emitted.filter((event) => event.type === "REPORT_GENERATION_STARTED").length;

  it("case 1: all diagnostics spent, then a VALID report on the first announced turn", async () => {
    // Pre-fix baseline at 5/3: REJECTED with MISSING_LIFECYCLE_FACT, because the
    // positional rule stays silent on turn 3 while the reducer already demands
    // the report-start fact. This is the defect #107 uncovered.
    const { result, emitted } = await run([
      ...allDiagnosticsSpent(),
      { kind: "report_submission", usage, rawInput: validReport },
    ]);

    expect(result.status).toBe("completed");
    expect(reportStartCount(emitted)).toBe(1);
    expect(reduce(emitted, { type: "RUN_COMPLETED" }, "COMPLETED")).toEqual({ ok: true });
  });

  it("case 2: all diagnostics spent, report rejected, corrected on the finalization turn", async () => {
    // Pre-fix baseline at 5/3: ACCEPTED. Deliberately not a red-first test.
    // Its job is the duplicate-emission guard: turn 3 satisfies the
    // exhausted-budget clause and turn 4 satisfies both clauses, so a rule that
    // re-evaluates the disjunction per turn emits the singleton twice and the
    // reducer rejects it with DUPLICATE_LIFECYCLE_FACT.
    const { result, emitted } = await run([
      ...allDiagnosticsSpent(),
      { kind: "report_submission", usage, rawInput: reportViolatingF5 },
      { kind: "report_submission", usage, rawInput: validReport },
    ]);

    expect(result.status).toBe("completed");
    expect(reportStartCount(emitted)).toBe(1);
    expect(reduce(emitted, { type: "RUN_COMPLETED" }, "COMPLETED")).toEqual({ ok: true });
  });

  it("case 3: a provider failure on the announced turn is attributed to REPORT_GENERATION", async () => {
    // Pre-fix baseline at 5/3: REJECTED with FAILED_STAGE_NOT_TRUTHFUL. Emitting
    // the report-start fact transitions the reducer's ACTIVE STAGE, so a failure
    // on that turn must name REPORT_GENERATION. While activeStage stayed
    // positional it named DIAGNOSTIC_EXECUTION (toolCallCount > 0), and an
    // ordinary provider timeout on the new headroom turn would strand the run.
    const { result, emitted } = await runThenFail(allDiagnosticsSpent());

    expect(result.status).toBe("failed");
    const failed = result as Extract<typeof result, { status: "failed" }>;
    expect(failed.failedStage).toBe("REPORT_GENERATION");
    expect(reportStartCount(emitted)).toBe(1);

    expect(
      reduce(
        emitted,
        { type: "RUN_FAILED", failureCode: failed.code, failedStage: failed.failedStage },
        "FAILED",
      ),
    ).toEqual({ ok: true });
  });

  it("the slack that makes these cases reachable is real", () => {
    // If a future change restores equality, cases 1-3 silently stop exercising
    // anything: the first exhausted-budget turn becomes the finalization turn
    // again and the positional rule is indistinguishable from the correct one.
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBeLessThan(MAX_PROVIDER_TURNS - 1);
  });
});
