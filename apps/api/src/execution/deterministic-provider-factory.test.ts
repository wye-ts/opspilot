import { getServiceStatusTool, type FakeProviderTurn } from "@opspilot/agent-runtime";
import { AgentTraceEventSchema } from "@opspilot/contracts";
import type { AgentJobRecord } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import {
  createDeterministicProviderFactory,
  createDeterministicScenario,
  LiveProviderModeNotSupportedError,
} from "./deterministic-provider-factory";

function buildJob(overrides: Partial<AgentJobRecord> = {}): AgentJobRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ticketContext: { ticketId: "TICKET-1", summary: "Elevated errors on billing-service" },
    externalTicketId: "TICKET-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function expectToolRequestTurn(
  turn: FakeProviderTurn | undefined,
): Extract<FakeProviderTurn, { kind: "diagnostic_tool_requests" }> {
  if (!turn || turn.kind !== "diagnostic_tool_requests") {
    throw new Error("expected a diagnostic_tool_requests turn");
  }
  return turn;
}

function expectReportSubmissionTurn(
  turn: FakeProviderTurn | undefined,
): Extract<FakeProviderTurn, { kind: "report_submission" }> {
  if (!turn || turn.kind !== "report_submission") {
    throw new Error("expected a report_submission turn");
  }
  return turn;
}

describe("createDeterministicScenario", () => {
  it("is deterministic/repeatable for the same job", () => {
    const job = buildJob();
    expect(createDeterministicScenario(job)).toEqual(createDeterministicScenario(job));
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
  readonly rootCause: string;
  readonly customerImpact: string;
  readonly recommendedResolution: string;
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

  it("states the tool completed successfully, that no root cause or customer impact was established, that the returned status is not persisted, and that further action needs a diagnostic workflow", () => {
    const job = buildJob({ ticketContext: { ticketId: "T-9", summary: "billing errors reported" } });
    const report = extractReport(job);

    expect(report.rootCause.toLowerCase()).toContain("completed successfully");
    expect(report.rootCause.toLowerCase()).toContain("no root cause could be established");
    expect(report.customerImpact.toLowerCase()).toContain("no customer impact could be established");

    const notPersistedText = [report.rootCause, report.customerImpact, report.recommendedResolution, ...report.evidence.map((e) => e.finding)]
      .join(" ")
      .toLowerCase();
    expect(notPersistedText).toContain("not persisted");

    expect(report.recommendedResolution.toLowerCase()).toContain("diagnostic workflow");
    expect(report.recommendedResolution.toLowerCase()).toContain("records and evaluates the returned status");
  });

  it("keeps the required unchanged shape: category UNKNOWN, confidence 0.5, one TOOL_EXECUTION evidence entry citing the tool-call id, and no suggested actions", () => {
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
  });
});

describe("createDeterministicProviderFactory", () => {
  it("defaults to FAKE mode when AGENT_RUN_PROVIDER_MODE is undefined", () => {
    expect(() => createDeterministicProviderFactory(undefined)).not.toThrow();
  });

  it("accepts an explicit FAKE mode", () => {
    expect(() => createDeterministicProviderFactory("FAKE")).not.toThrow();
  });

  it("rejects LIVE mode synchronously, without any network-capable object being constructed", () => {
    expect(() => createDeterministicProviderFactory("LIVE")).toThrow(LiveProviderModeNotSupportedError);
  });

  it("rejects any other unrecognized mode value", () => {
    expect(() => createDeterministicProviderFactory("BOGUS")).toThrow(LiveProviderModeNotSupportedError);
  });

  it("createProvider builds a FakeLlmProvider that runs the deterministic scenario end to end", async () => {
    const factory = createDeterministicProviderFactory("FAKE");
    const job = buildJob();
    const provider = factory.createProvider(job);

    const toolTurn = await provider.runAgentTurn({
      turnIndex: 0,
      phase: "INVESTIGATION",
      maxOutputTokens: 4096,
      conversation: [],
    });
    expect(toolTurn.type).toBe("diagnostic_tool_request");

    const reportTurn = await provider.runAgentTurn({
      turnIndex: 1,
      phase: "FINALIZATION",
      maxOutputTokens: 4096,
      conversation: [],
    });
    expect(reportTurn.type).toBe("report_submission");
  });
});
