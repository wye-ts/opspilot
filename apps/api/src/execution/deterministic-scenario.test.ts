import {
  getServiceStatusTool,
  type AgentTurnInput,
  type FakeAgentScenario,
  type FakeProviderTurn,
  type FakeProviderTurnResolver,
  type RagContextEntry,
} from "@opspilot/agent-runtime";
import { AgentTraceEventSchema } from "@opspilot/contracts";
import type { AgentJobRecord } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { createDeterministicScenario } from "./deterministic-scenario";

function buildJob(overrides: Partial<AgentJobRecord> = {}): AgentJobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors on billing-service" },
    externalTicketId: "TICKET-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// The scenario's turns array is typed as the §12 union
// (FakeProviderTurn | FakeProviderTurnResolver)[] because the fake provider
// accepts either a literal turn or a deterministic function of the turn input.
// Issue #72 §2.4: createDeterministicScenario now ALWAYS emits resolver-form
// turns (both react to input.conversation's rag_context entry, if any), so
// these helpers resolve a resolver against a supplied (or default,
// no-rag-context) AgentTurnInput before narrowing the literal — this is what
// keeps every pre-#72 assertion below unchanged: it exercises the honest
// no-match branch, byte-identical to the old static turns.
type TurnEntry = FakeProviderTurn | FakeProviderTurnResolver;

const SAMPLE_RAG_CHUNK: RagContextEntry = {
  evidenceId: "runbook-billing-invoice-formatting-001",
  sourceType: "RAG_CHUNK",
  runbookId: "billing-invoice-formatting-runbook",
  title: "Billing Invoice Formatting Issues",
  content: "Describes a known billing invoice PDF formatting failure mode.",
};

function noRagContextInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    turnIndex: 0,
    phase: "INVESTIGATION",
    maxOutputTokens: 4096,
    conversation: [],
    diagnosticCallsRemaining: 1,
    ...overrides,
  };
}

function ragContextInput(entries: readonly RagContextEntry[] = [SAMPLE_RAG_CHUNK]): AgentTurnInput {
  return noRagContextInput({ conversation: [{ role: "rag_context", entries }] });
}

function resolveTurn(entry: TurnEntry | undefined, input: AgentTurnInput): FakeProviderTurn {
  if (entry === undefined) {
    throw new Error("expected a scripted turn entry");
  }
  return typeof entry === "function" ? entry(input) : entry;
}

function expectToolRequestTurn(
  turn: TurnEntry | undefined,
  input: AgentTurnInput = noRagContextInput(),
): Extract<FakeProviderTurn, { kind: "diagnostic_tool_requests" }> {
  const resolved = resolveTurn(turn, input);
  if (resolved.kind !== "diagnostic_tool_requests") {
    throw new Error("expected a diagnostic_tool_requests turn");
  }
  return resolved;
}

function expectReportSubmissionTurn(
  turn: TurnEntry | undefined,
  input: AgentTurnInput = noRagContextInput(),
): Extract<FakeProviderTurn, { kind: "report_submission" }> {
  const resolved = resolveTurn(turn, input);
  if (resolved.kind !== "report_submission") {
    throw new Error("expected a report_submission turn");
  }
  return resolved;
}

function resolveScenarioTurns(
  scenario: FakeAgentScenario,
  input: AgentTurnInput,
): readonly FakeProviderTurn[] {
  return scenario.turns.map((entry) => resolveTurn(entry, input));
}

describe("createDeterministicScenario", () => {
  // Issue #72 §2.4: both turns are now resolver functions, so two calls'
  // `turns` arrays hold distinct function instances (never structurally
  // equal via toEqual) even though they resolve identically for the same
  // job. "Deterministic/repeatable" now means: resolving both scenarios
  // against the SAME AgentTurnInput yields identical turn literals — checked
  // for both the no-rag-context and rag-context cases, so the resolvers'
  // own determinism (not just the closed-over `report`/`toolCallId`/
  // `serviceSlug` values) is what's actually under test.
  it("is deterministic/repeatable for the same job", () => {
    const job = buildJob();
    const scenarioA = createDeterministicScenario(job);
    const scenarioB = createDeterministicScenario(job);
    expect(scenarioA.id).toBe(scenarioB.id);
    expect(resolveScenarioTurns(scenarioA, noRagContextInput())).toEqual(
      resolveScenarioTurns(scenarioB, noRagContextInput()),
    );
    expect(resolveScenarioTurns(scenarioA, ragContextInput())).toEqual(
      resolveScenarioTurns(scenarioB, ragContextInput()),
    );
  });

  it("derives billing-service from a summary mentioning billing", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-1", summary: "billing outage reported" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    expect(firstTurn.requests[0]?.input).toEqual({ serviceSlug: "billing-service" });
  });

  it("derives notification-service from a summary mentioning notification", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-2", summary: "notification delivery delayed" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    expect(firstTurn.requests[0]?.input).toEqual({ serviceSlug: "notification-service" });
  });

  it("derives auth-service from a summary mentioning auth", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-3", summary: "auth failures spiking" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    expect(firstTurn.requests[0]?.input).toEqual({ serviceSlug: "auth-service" });
  });

  it("falls back to unspecified-service when no keyword matches", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-4", summary: "customer cannot log a support ticket" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    expect(firstTurn.requests[0]?.input).toEqual({ serviceSlug: "unspecified-service" });
  });

  it("truncates an overlong summary before interpolating it into report fields", () => {
    const longSummary = "billing " + "x".repeat(5000);
    const job = buildJob({ ticketContext: { ticketId: "T-5", summary: longSummary } });
    const scenario = createDeterministicScenario(job);
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1]);
    const report = secondTurn.rawInput as { summary: string };
    expect(report.summary.length).toBeLessThan(300);
  });

  it("never contaminates job B's scenario with job A's ticket data", () => {
    const jobA = buildJob({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ticketContext: { ticketId: "A-1", summary: "auth outage" } });
    const jobB = buildJob({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", ticketContext: { ticketId: "B-1", summary: "billing outage" } });

    const scenarioA = createDeterministicScenario(jobA);
    const scenarioB = createDeterministicScenario(jobB);

    expect(JSON.stringify(scenarioA)).not.toContain("B-1");
    expect(JSON.stringify(scenarioA)).not.toContain("billing");
    expect(JSON.stringify(scenarioB)).not.toContain("A-1");
    expect(JSON.stringify(scenarioB)).not.toContain("auth-service");
  });

  it("derives toolCallId from the job's own id, and evidence cites the same id", () => {
    const job = buildJob({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc" });
    const scenario = createDeterministicScenario(job);

    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    const toolCallId = firstTurn.requests[0]?.toolCallId;
    expect(toolCallId).toBe(`${job.id}-call-1`);

    const secondTurn = expectReportSubmissionTurn(scenario.turns[1]);
    const report = secondTurn.rawInput as { evidence: Array<{ evidenceId: string }> };
    expect(report.evidence[0]?.evidenceId).toBe(toolCallId);
  });

  it("produces the exact same job-scoped toolCallId across repeated calls for the same job (multi-run reuse is acceptable)", () => {
    const job = buildJob();
    const scenario1 = createDeterministicScenario(job);
    const scenario2 = createDeterministicScenario(job);
    const toolCallId1 = expectToolRequestTurn(scenario1.turns[0]).requests[0]?.toolCallId;
    const toolCallId2 = expectToolRequestTurn(scenario2.turns[0]).requests[0]?.toolCallId;
    expect(toolCallId1).toBe(toolCallId2);
  });
});

interface DeterministicReportShape {
  readonly category: string;
  readonly summary: string;
  readonly rootCause: string | null;
  readonly customerImpact: string;
  readonly recommendedResolution: string;
  readonly evidenceState: string;
  readonly recommendationDisposition: string;
  readonly evidence: ReadonlyArray<{ readonly evidenceId: string; readonly sourceType: string; readonly finding: string }>;
}

function extractReport(job: AgentJobRecord): DeterministicReportShape {
  const scenario = createDeterministicScenario(job);
  const secondTurn = expectReportSubmissionTurn(scenario.turns[1]);
  return secondTurn.rawInput as DeterministicReportShape;
}

// The two turns in this scenario are scripted entirely upfront (§ comment
// on createDeterministicScenario) — before the orchestrator has actually
// invoked get_service_status — so the report content must never assert a
// specific status/finding it cannot actually know. This describe block
// proves that holds even for a service the tool genuinely reports as
// healthy, without duplicating get-service-status.ts's seeded status table
// in apps/api itself: it asks the real tool what it returns and checks the
// report against that real answer.
describe("report content is status-agnostic", () => {
  it("does not claim a specific incident category or a non-operational finding for any service", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-6", summary: "billing errors reported" } });
    const report = extractReport(job);

    expect(report.category).toBe("UNKNOWN");
    const reportText = [report.summary, report.rootCause, report.customerImpact, report.recommendedResolution]
      .join(" ")
      .toLowerCase();
    expect(reportText).not.toContain("service_degradation");
    expect(reportText).not.toContain("degraded");
    expect(reportText).not.toContain("outage");
    expect(reportText).not.toContain("did not report an operational status");
  });

  it("never contradicts auth-service's real seeded OPERATIONAL status", async () => {
    // Confirmed against the real get_service_status tool (packages/
    // agent-runtime) — auth-service is seeded OPERATIONAL there. This
    // assertion is what would fail if apps/api's report ever regressed
    // back to unconditionally claiming a degraded/non-operational finding.
    const realStatus = await getServiceStatusTool.execute({ serviceSlug: "auth-service" });
    expect(realStatus).toEqual({ serviceSlug: "auth-service", status: "OPERATIONAL" });

    const job = buildJob({ ticketContext: { ticketId: "T-7", summary: "a customer reported an auth issue" } });
    const report = extractReport(job);
    const reportText = [report.category, report.summary, report.rootCause, report.customerImpact, report.recommendedResolution]
      .join(" ")
      .toLowerCase();

    expect(reportText).not.toContain("service_degradation");
    expect(reportText).not.toContain("degraded");
    expect(reportText).not.toContain("outage");
    expect(reportText).not.toContain("did not report an operational status");
  });
});

// TOOL_COMPLETED (AgentTraceEventSchema, packages/contracts) persists only
// `type`, `toolCallId`, and `toolName` — never the tool's return value. The
// report must not claim otherwise (e.g. "see this run's trace for the exact
// value"), since no reader could ever actually find that value there.
describe("report content does not overclaim what the persisted trace/evidence contains", () => {
  it("TOOL_COMPLETED's contract schema has no field capable of carrying the tool's returned status value", () => {
    const persistedShape = { type: "TOOL_COMPLETED" as const, toolCallId: "call-1", toolName: "get_service_status" };
    expect(AgentTraceEventSchema.safeParse(persistedShape).success).toBe(true);

    // .strict() rejects any additional property — proving a status/output
    // field could not be smuggled through TOOL_COMPLETED even if the
    // report's wording implied one was recorded there.
    const withStatus = { ...persistedShape, status: "OPERATIONAL" };
    expect(AgentTraceEventSchema.safeParse(withStatus).success).toBe(false);
  });

  it("does not claim the tool's exact returned status/value is recorded in or recoverable from the trace or evidence", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-8", summary: "billing errors reported" } });
    const report = extractReport(job);
    const reportText = [
      report.summary,
      report.rootCause,
      report.customerImpact,
      report.recommendedResolution,
      ...report.evidence.map((entry) => entry.finding),
    ]
      .join(" ")
      .toLowerCase();

    expect(reportText).not.toContain("exact value");
    expect(reportText).not.toContain("see this run's trace");
    expect(reportText).not.toContain("its reported status is captured");
    expect(reportText).not.toContain("captured in this run's trace");
  });

  it("declares INSUFFICIENT evidence with a null rootCause, states that no customer impact was established, that the returned status is not persisted, and that further action needs a diagnostic workflow", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-9", summary: "billing errors reported" } });
    const report = extractReport(job);

    // Issue #58 (P1-1): this scenario never evaluates the tool's returned
    // status, so its evidence is truthfully INSUFFICIENT and the report carries
    // no root cause — conveyed structurally (rootCause null + evidenceState),
    // not by the old sentinel prose.
    expect(report.evidenceState).toBe("INSUFFICIENT");
    expect(report.rootCause).toBeNull();
    expect(report.customerImpact.toLowerCase()).toContain("no customer impact could be established");

    const notPersistedText = [report.customerImpact, report.recommendedResolution, ...report.evidence.map((e) => e.finding)]
      .join(" ")
      .toLowerCase();
    expect(notPersistedText).toContain("not persisted");

    expect(report.recommendedResolution.toLowerCase()).toContain("diagnostic workflow");
    expect(report.recommendedResolution.toLowerCase()).toContain("records and evaluates the returned status");
  });

  it("keeps the required unchanged shape: category UNKNOWN, confidence 0.5, one TOOL_EXECUTION evidence entry citing the tool-call id, no suggested actions, and an ADVISORY disposition", () => {
    const job = buildJob({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", ticketContext: { ticketId: "T-10", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1]);
    const report = secondTurn.rawInput as DeterministicReportShape & { confidence: number; suggestedActions: unknown[] };
    const toolCallId = firstTurn.requests[0]?.toolCallId;

    expect(report.category).toBe("UNKNOWN");
    expect(report.confidence).toBe(0.5);
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]?.evidenceId).toBe(toolCallId);
    expect(report.evidence[0]?.sourceType).toBe("TOOL_EXECUTION");
    expect(report.suggestedActions).toEqual([]);
    // Issue #60 Checkpoint B: an ordinary deterministic ticket stays
    // ADVISORY with no suggested actions — INSUFFICIENT does not imply a
    // concrete approvable operation.
    expect(report.recommendationDisposition).toBe("ADVISORY");
  });
});

describe("opt-in TICKET-APPROVAL-DEMO suggested action (docs/13-approval-workflow.md §14)", () => {
  it("returns suggestedActions: [] with an ADVISORY disposition for an ordinary ticketId — unchanged from today's shipped behavior", () => {
    const job = buildJob({ ticketContext: { ticketId: "TICKET-2001", summary: "billing errors reported" } });
    const report = extractReport(job) as unknown as { suggestedActions: unknown[]; recommendationDisposition: string };
    expect(report.suggestedActions).toEqual([]);
    // Issue #60 Checkpoint B: an ordinary ticket carries no Suggested Action,
    // so its recommendation stays ADVISORY — it must not read like a concrete
    // approvable operation.
    expect(report.recommendationDisposition).toBe("ADVISORY");
  });

  it("returns exactly one grounded DRAFT_CUSTOMER_REPLY suggested action with an ACTIONABLE disposition when ticketId is exactly TICKET-APPROVAL-DEMO", () => {
    const job = buildJob({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", ticketContext: { ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval workflow demo" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0]);
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1]);
    const toolCallId = firstTurn.requests[0]?.toolCallId;
    const report = secondTurn.rawInput as DeterministicReportShape & {
      suggestedActions: Array<{
        type: string;
        payload: { subject: string; body: string };
        groundedBy: Array<{ evidenceId: string; sourceType: string }>;
      }>;
    };

    // Issue #60 Checkpoint B: the demo is intentionally the positive Human
    // Approval path — INSUFFICIENT evidence does not imply ADVISORY / no
    // action. A grounded customer communication is ACTIONABLE.
    expect(report.recommendationDisposition).toBe("ACTIONABLE");
    expect(report.suggestedActions).toHaveLength(1);
    expect(report.suggestedActions[0]?.type).toBe("DRAFT_CUSTOMER_REPLY");
    expect(report.suggestedActions[0]?.payload.subject).toBeTruthy();
    expect(report.suggestedActions[0]?.payload.body).toBeTruthy();
    // The action's grounding is the already-completed deterministic tool call,
    // and that same locator is present in this report's evidence.
    expect(report.suggestedActions[0]?.groundedBy).toEqual([
      { evidenceId: toolCallId, sourceType: "TOOL_EXECUTION" },
    ]);
    const evidenceLocators = report.evidence.map((e) => ({ evidenceId: e.evidenceId, sourceType: e.sourceType }));
    expect(evidenceLocators).toContainEqual({ evidenceId: toolCallId, sourceType: "TOOL_EXECUTION" });
  });

  it("TICKET-APPROVAL-DEMO recommendation prose semantically aligns with the DRAFT_CUSTOMER_REPLY action / human follow-up, staying status-agnostic", () => {
    const job = buildJob({ ticketContext: { ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval workflow demo" } });
    const report = extractReport(job);

    const prose = report.recommendedResolution.toLowerCase();
    expect(prose).toContain("customer-facing reply");
    expect(prose).toContain("draft");
    expect(prose).toContain("human");
    // The demo recommendation stays status-agnostic: it never claims a
    // specific tool-returned status/finding this scripted scenario cannot know.
    expect(prose).not.toContain("service_degradation");
    expect(prose).not.toContain("operational");
  });

  it("treats the opt-in ticketId as an exact, case-sensitive match — a substring or case mismatch does not activate it", () => {
    const substringJob = buildJob({
      ticketContext: { ticketId: "PREFIX-TICKET-APPROVAL-DEMO-SUFFIX", summary: "s" },
    });
    const caseMismatchJob = buildJob({ ticketContext: { ticketId: "ticket-approval-demo", summary: "s" } });

    const substringReport = extractReport(substringJob) as unknown as { suggestedActions: unknown[] };
    const caseMismatchReport = extractReport(caseMismatchJob) as unknown as { suggestedActions: unknown[] };

    expect(substringReport.suggestedActions).toEqual([]);
    expect(caseMismatchReport.suggestedActions).toEqual([]);
  });
});

// Issue #72 §2.4: both turns are resolver functions that independently derive
// whatever RAG-dependent content they need from their own AgentTurnInput at
// call time — the first turn's tool-request assessment and the second turn's
// report evidence must each truthfully reflect whether a rag_context entry is
// present in the conversation passed to THAT turn, without either resolver
// reading or mutating state the other wrote.
describe("issue #72: rag_context-aware resolvers", () => {
  it("first turn claims NO_EVIDENCE_YET with an empty supportedBy when no rag_context is present — unchanged from today", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-11", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0], noRagContextInput());
    expect(firstTurn.requests[0]?.rawAssessment).toEqual({
      evidenceState: "INSUFFICIENT",
      continuationReason: "NO_EVIDENCE_YET",
      supportedBy: [],
    });
  });

  it("first turn cites the retrieved chunk with a truthful STATUS_UNRESOLVED continuationReason when a rag_context entry is present", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-12", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    const firstTurn = expectToolRequestTurn(scenario.turns[0], ragContextInput());
    expect(firstTurn.requests[0]?.rawAssessment).toEqual({
      evidenceState: "INSUFFICIENT",
      continuationReason: "STATUS_UNRESOLVED",
      supportedBy: [{ evidenceId: SAMPLE_RAG_CHUNK.evidenceId, sourceType: "RAG_CHUNK" }],
    });
  });

  it("second turn's report keeps exactly today's single TOOL_EXECUTION evidence entry when no rag_context is present", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-13", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1], noRagContextInput());
    const report = secondTurn.rawInput as DeterministicReportShape;
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]?.sourceType).toBe("TOOL_EXECUTION");
  });

  it("second turn's report adds a RAG_CHUNK evidence entry citing the retrieved chunk id when a rag_context entry is present", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-14", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1], ragContextInput());
    const report = secondTurn.rawInput as DeterministicReportShape;
    expect(report.evidence).toHaveLength(2);
    const ragEntry = report.evidence.find((entry) => entry.sourceType === "RAG_CHUNK");
    expect(ragEntry?.evidenceId).toBe(SAMPLE_RAG_CHUNK.evidenceId);
    // The RAG finding must never attribute a returned status value to the
    // runbook (that belongs to the separate TOOL_EXECUTION entry, and a
    // runbook document never returns one) — Codex review round-3 finding on
    // issue #72: the original wording said "its returned status value is not
    // persisted," which misattributes the tool's limitation to the runbook.
    expect(ragEntry?.finding).not.toMatch(/status value/i);
    expect(ragEntry?.finding).toMatch(/does not establish/i);
    // The original TOOL_EXECUTION entry is preserved unchanged alongside it.
    expect(report.evidence.some((entry) => entry.sourceType === "TOOL_EXECUTION")).toBe(true);
    // rootCause stays null in this deterministic scenario (§2.2a): the added
    // entry must not declare ROOT_CAUSE support for a root cause that doesn't
    // exist.
    expect(report.rootCause).toBeNull();
  });

  it("both resolvers see the rag_context entry independently — one turn's input carrying it does not leak into the other turn's default (no-rag-context) resolution", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-15", summary: "billing errors reported" } });
    const scenario = createDeterministicScenario(job);
    // Resolve the report-submission turn WITH rag_context, and the
    // tool-request turn WITHOUT it — proving neither resolver holds shared
    // mutable state the other wrote.
    const firstTurn = expectToolRequestTurn(scenario.turns[0], noRagContextInput());
    const secondTurn = expectReportSubmissionTurn(scenario.turns[1], ragContextInput());
    const assessment = firstTurn.requests[0]?.rawAssessment as { continuationReason: string } | undefined;
    expect(assessment?.continuationReason).toBe("NO_EVIDENCE_YET");
    const report = secondTurn.rawInput as DeterministicReportShape;
    expect(report.evidence.some((entry) => entry.sourceType === "RAG_CHUNK")).toBe(true);
  });
});

// The former "createDeterministicProviderFactory" suite is gone. It asserted
// that AGENT_RUN_PROVIDER_MODE=LIVE threw LiveProviderModeNotSupportedError at
// DI time, which was correct while the API could only ever run deterministically.
//
// PR 6B1 replaced that single rejection with three separate decisions, each
// tested where it now lives:
//   - the mode is a per-request value ....... agent-runs.controller.test.ts
//   - live capability is optional/fail-closed  run-execution-config.test.ts
//   - the factory builds either provider ....  api-provider-factory.test.ts
//
// This file keeps its original subject: the deterministic scenario itself,
// which PR 6B1 did not change.
