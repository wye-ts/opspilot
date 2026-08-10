import { describe, expect, it } from "vitest";
import type { InvestigationEventRecord } from "@opspilot/contracts";

import { deriveExecutionStageDerivation } from "./execution-stage-derivation";
import { deriveInvestigationProgressStages, presentInvestigationProgressStage } from "./investigation-progress-stages";

const BASE = {
  providerMode: "FAKE" as const,
  activeStageKey: null,
  failedStage: null,
  jobCreated: false,
  runOutcomeType: null,
  approvalLoadStatus: "idle" as const,
  executionStageDerivation: { kind: "legacy" as const },
  events: [],
};

function stagesFrom(input: Parameters<typeof deriveInvestigationProgressStages>[0]) {
  return deriveInvestigationProgressStages(input).stages;
}

describe("deriveInvestigationProgressStages", () => {
  it("FAKE mode never includes the availability stage", () => {
    const stages = stagesFrom(BASE);
    expect(stages.map((s) => s.key)).toEqual(["job", "run", "approval"]);
  });

  it("LIVE mode includes the availability stage first", () => {
    const stages = stagesFrom({ ...BASE, providerMode: "LIVE" });
    expect(stages.map((s) => s.key)).toEqual(["availability", "job", "run", "approval"]);
  });

  it("everything is pending before anything starts", () => {
    const stages = stagesFrom(BASE);
    expect(stages.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks the active stage, leaving later stages pending", () => {
    const stages = stagesFrom({ ...BASE, activeStageKey: "job" });
    expect(stages.find((s) => s.key === "job")?.status).toBe("active");
    expect(stages.find((s) => s.key === "run")?.status).toBe("pending");
    expect(stages.find((s) => s.key === "approval")?.status).toBe("pending");
  });

  it("marks job completed and run active once the job exists and run is in flight", () => {
    const stages = stagesFrom({ ...BASE, activeStageKey: "run", jobCreated: true });
    expect(stages.find((s) => s.key === "job")?.status).toBe("completed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("active");
  });

  it("a failed job stage blocks run at pending and drops approval entirely, even though phase is idle (activeStageKey null)", () => {
    const stages = stagesFrom({ ...BASE, failedStage: "job" });
    expect(stages.find((s) => s.key === "job")?.status).toBe("failed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("pending");
    expect(stages.map((s) => s.key)).toEqual(["job", "run"]);
  });

  it("a failed run stage marks job completed and run failed", () => {
    const stages = stagesFrom({ ...BASE, failedStage: "run", jobCreated: true });
    expect(stages.find((s) => s.key === "job")?.status).toBe("completed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("failed");
  });

  it("LIVE availability is inferred completed once the job exists, even with no activeStageKey", () => {
    const stages = stagesFrom({
      ...BASE,
      providerMode: "LIVE",
      jobCreated: true,
      failedStage: "run",
    });
    expect(stages.find((s) => s.key === "availability")?.status).toBe("completed");
  });

  describe("run stage is outcome-aware, not run!==null-aware", () => {
    it("RUNNING outcome reads Active, not Completed — approval stays Pending", () => {
      const stages = stagesFrom({ ...BASE, jobCreated: true, runOutcomeType: "RUNNING" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("active");
      expect(stages.find((s) => s.key === "run")?.label).toBe("Agent investigation in progress…");
      expect(stages.find((s) => s.key === "approval")?.status).toBe("pending");
    });

    it("COMPLETED outcome reads Completed", () => {
      const stages = stagesFrom({ ...BASE, jobCreated: true, runOutcomeType: "COMPLETED" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("completed");
    });

    it("FAILED outcome reads Failed even with no failedStage set — and approval is omitted, not left Pending", () => {
      const stages = stagesFrom({ ...BASE, jobCreated: true, runOutcomeType: "FAILED" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("failed");
      expect(stages.map((s) => s.key)).toEqual(["job", "run"]);
      expect(stages.some((s) => s.label === "Loading approval state…")).toBe(false);
    });

    it("keeps the approval stage for an approval-load failure, which does not stop the workflow", () => {
      const stages = stagesFrom({
        ...BASE,
        jobCreated: true,
        runOutcomeType: "COMPLETED",
        approvalLoadStatus: "failed",
      });
      expect(stages.find((s) => s.key === "approval")?.status).toBe("failed");
    });

    it("availability reads completed once a run exists with ANY outcome, including RUNNING", () => {
      const stages = stagesFrom({
        ...BASE,
        providerMode: "LIVE",
        jobCreated: true,
        runOutcomeType: "RUNNING",
      });
      expect(stages.find((s) => s.key === "availability")?.status).toBe("completed");
    });

    it("an in-flight run request (activeStageKey) takes priority over a stale runOutcomeType", () => {
      const stages = stagesFrom({
        ...BASE,
        jobCreated: true,
        activeStageKey: "run",
        runOutcomeType: null,
      });
      expect(stages.find((s) => s.key === "run")?.status).toBe("active");
    });
  });

  it("a failed availability stage leaves job/run/approval pending", () => {
    const stages = stagesFrom({ ...BASE, providerMode: "LIVE", failedStage: "availability" });
    expect(stages.find((s) => s.key === "availability")?.status).toBe("failed");
    expect(stages.find((s) => s.key === "job")?.status).toBe("pending");
  });

  it("approval status is driven only by approvalLoadStatus, independent of activeStageKey", () => {
    const idle = stagesFrom({ ...BASE, activeStageKey: null, approvalLoadStatus: "idle" });
    const loading = stagesFrom({ ...BASE, activeStageKey: null, approvalLoadStatus: "loading" });
    const loaded = stagesFrom({ ...BASE, activeStageKey: null, approvalLoadStatus: "loaded" });
    const failed = stagesFrom({ ...BASE, activeStageKey: null, approvalLoadStatus: "failed" });
    expect(idle.find((s) => s.key === "approval")?.status).toBe("pending");
    expect(loading.find((s) => s.key === "approval")?.status).toBe("active");
    expect(loaded.find((s) => s.key === "approval")?.status).toBe("completed");
    expect(failed.find((s) => s.key === "approval")?.status).toBe("failed");
  });

  it("uses the completed label only once completed, and the active label otherwise", () => {
    const pending = stagesFrom(BASE).find((s) => s.key === "job");
    const active = stagesFrom({ ...BASE, activeStageKey: "job" }).find((s) => s.key === "job");
    const completed = stagesFrom({ ...BASE, jobCreated: true, activeStageKey: "run" }).find(
      (s) => s.key === "job",
    );
    const failed = stagesFrom({ ...BASE, failedStage: "job" }).find((s) => s.key === "job");
    expect(pending?.label).toBe("Creating investigation…");
    expect(active?.label).toBe("Creating investigation…");
    expect(failed?.label).toBe("Creating investigation…");
    expect(completed?.label).toBe("Investigation created");
  });

  describe("nested events ride along as a view of the run row children", () => {
    // Four completed canonical stages — a run whose execution detail is
    // available (kind "canonical"), independent of what events are shown.
    const canonicalStages = [
      { key: "INVESTIGATION_CREATED" as const, status: "completed" as const, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", elapsedMs: 1000 },
      { key: "AGENT_ANALYSIS" as const, status: "completed" as const, startedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:31.000Z", elapsedMs: 30_000 },
      { key: "DIAGNOSTIC_EXECUTION" as const, status: "completed" as const, startedAt: "2026-01-01T00:00:31.000Z", completedAt: "2026-01-01T00:01:01.000Z", elapsedMs: 30_000 },
      { key: "REPORT_GENERATION" as const, status: "completed" as const, startedAt: "2026-01-01T00:01:01.000Z", completedAt: "2026-01-01T00:01:31.000Z", elapsedMs: 30_000 },
    ];
    const canonicalDerivation = { kind: "canonical" as const, stages: canonicalStages };

    it("populates run-row children with events grouped under the correct stages", () => {
      const stages = stagesFrom({
        ...BASE,
        jobCreated: true,
        runOutcomeType: "COMPLETED",
        executionStageDerivation: canonicalDerivation,
        events: [
          { runId: "11111111-1111-4111-8111-111111111111", sequence: 1, recordedAt: "2026-01-01T00:00:00.000Z", payload: { type: "RUN_CREATED" } },
          { runId: "11111111-1111-4111-8111-111111111111", sequence: 2, recordedAt: "2026-01-01T00:00:00.100Z", payload: { type: "AGENT_STARTED" } },
          { runId: "11111111-1111-4111-8111-111111111111", sequence: 3, recordedAt: "2026-01-01T00:00:00.200Z", payload: { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" } },
        ],
      });
      const children = stages.find((s) => s.key === "run")?.children;
      expect(children).not.toBeNull();
      expect(children?.find((c) => c.key === "INVESTIGATION_CREATED")?.events).toEqual([
        { sequence: 1, label: "Run created" },
      ]);
      expect(children?.find((c) => c.key === "AGENT_ANALYSIS")?.events).toEqual([
        { sequence: 2, label: "Agent started" },
      ]);
      expect(children?.find((c) => c.key === "DIAGNOSTIC_EXECUTION")?.events).toEqual([
        { sequence: 3, label: "Tool requested" },
      ]);
      expect(children?.find((c) => c.key === "REPORT_GENERATION")?.events).toBeUndefined();
    });

    it("carries no nested events when the events list is empty", () => {
      const stages = stagesFrom({
        ...BASE,
        jobCreated: true,
        runOutcomeType: "COMPLETED",
        executionStageDerivation: canonicalDerivation,
        events: [],
      });
      const children = stages.find((s) => s.key === "run")?.children;
      expect(children).not.toBeNull();
      expect(children?.every((c) => c.events === undefined)).toBe(true);
    });

    it("requires the events field on the input (compile-time)", () => {
      // `events` is a required input field — omitting it is a compile error,
      // so no call site can silently drop the event view.
      // @ts-expect-error — `events` is required
      stagesFrom({ ...BASE, events: undefined });
    });
  });

  describe("#40 fail-closed: canonical-invalid last-good rows never nest events from the invalid stream", () => {
    const FAIL_CLOSED_RUN_ID = "11111111-1111-4111-8111-111111111111";
    const NOW = "2026-01-01T00:01:00.000Z";
    const makeEvent = (sequence: number, payload: InvestigationEventRecord["payload"]): InvestigationEventRecord => ({
      runId: FAIL_CLOSED_RUN_ID,
      sequence,
      recordedAt: NOW,
      payload,
    });

    // Same-run trusted snapshot — the reducer accepts this partial RUNNING
    // prefix, so it establishes the run's last-good stages.
    const trustedEvents = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
    ];
    // Newer same-run snapshot that is reducer-INVALID: it adds a
    // canonical-looking TOOL_REQUESTED then an out-of-phase RETRIEVAL_COMPLETED
    // (retrieval belongs to analysis; the tool phase has already begun). The
    // reducer rejects the stream, so none of its events may be trusted.
    const corruptEvents = [
      ...trustedEvents,
      makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
      makeEvent(4, { type: "RETRIEVAL_COMPLETED", chunks: [] }),
    ];

    it("keeps the frozen last-good stage statuses and renders NO nested events from the invalid stream", () => {
      // 1. The valid same-run snapshot establishes last-good canonical stages.
      const first = deriveExecutionStageDerivation(trustedEvents, "RUNNING", NOW, { kind: "legacy" });
      expect(first.kind).toBe("canonical");

      // 2+3. The newer same-run stream is reducer-invalid → the derivation is
      // canonical-invalid while still carrying the run's last-good stages.
      const second = deriveExecutionStageDerivation(corruptEvents, "RUNNING", NOW, first);
      expect(second.kind).toBe("canonical-invalid");
      if (second.kind === "canonical-invalid") {
        expect(second.lastGoodStages).not.toBeNull();
      }

      const stages = stagesFrom({
        ...BASE,
        jobCreated: true,
        runOutcomeType: "RUNNING",
        executionStageDerivation: second,
        events: corruptEvents,
      });
      const children = stages.find((s) => s.key === "run")?.children;
      expect(children).not.toBeNull();

      // 4. The Timeline keeps the frozen last-good statuses — the invalid
      // stream's TOOL_REQUESTED must not advance AGENT_ANALYSIS or
      // DIAGNOSTIC_EXECUTION.
      expect(children?.find((c) => c.key === "INVESTIGATION_CREATED")?.status).toBe("completed");
      expect(children?.find((c) => c.key === "AGENT_ANALYSIS")?.status).toBe("active");
      expect(children?.find((c) => c.key === "DIAGNOSTIC_EXECUTION")?.status).toBe("pending");
      expect(children?.find((c) => c.key === "REPORT_GENERATION")?.status).toBe("pending");

      // 5. Fail-closed: the last-good rows carry NO nested events at all —
      // not even RUN_CREATED/AGENT_STARTED from the invalid snapshot, and
      // certainly not its new TOOL_REQUESTED. This is the explicit rule,
      // not just "this one event is gone".
      expect(children?.every((c) => c.events === undefined)).toBe(true);
    });
  });
});

describe("presentInvestigationProgressStage", () => {
  it("never uses color as the only signal — every status has a distinct glyph and label", () => {
    const presentations = (["pending", "active", "completed", "failed", "omitted"] as const).map((status) =>
      presentInvestigationProgressStage(status),
    );
    const labels = presentations.map((p) => p.badgeLabel);
    // "pending" and "omitted" share the same glyph ("—") — they are
    // distinguished by label ("Pending" vs "Not applicable").
    expect(new Set(labels).size).toBe(5);
  });

  it("omitted is neutral-toned with 'Not applicable' label", () => {
    const presentation = presentInvestigationProgressStage("omitted");
    expect(presentation.tone).toBe("neutral");
    expect(presentation.badgeLabel).toBe("Not applicable");
  });

  it("failed is danger-toned and completed is success-toned", () => {
    expect(presentInvestigationProgressStage("failed").tone).toBe("danger");
    expect(presentInvestigationProgressStage("completed").tone).toBe("success");
  });
});
