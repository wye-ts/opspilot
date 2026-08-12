import {
  INVESTIGATION_EXECUTION_STAGE_ORDER,
  type ExecutionStageProgress,
  type InvestigationEventRecord,
  type InvestigationEventRecordPayload,
} from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExecutionStageRows,
  findFailedExecutionStageLabel,
  groupEventsByStage,
  type ExecutionStageRowViewModel,
  type InvestigationEventViewModel,
} from "./execution-stage-rows";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function record(sequence: number, payload: InvestigationEventRecordPayload): InvestigationEventRecord {
  return { runId: RUN_ID, sequence, recordedAt: "2026-01-01T00:00:00.000Z", payload };
}

function stage(
  key: ExecutionStageProgress["key"],
  status: ExecutionStageProgress["status"],
): ExecutionStageProgress {
  const timestamped = status === "active" || status === "completed" || status === "failed";
  return {
    key,
    status,
    startedAt: timestamped ? "2026-01-01T00:00:00.000Z" : null,
    completedAt: status === "completed" || status === "failed" ? "2026-01-01T00:01:00.000Z" : null,
    elapsedMs: timestamped ? 60_000 : null,
    failureCode: status === "failed" ? "TOOL_EXECUTION_FAILED" : undefined,
  };
}

function fourStages(): readonly ExecutionStageProgress[] {
  return INVESTIGATION_EXECUTION_STAGE_ORDER.map((key) => stage(key, "completed"));
}

describe("groupEventsByStage", () => {
  it("groups events under the stage each one maps to", () => {
    const map = groupEventsByStage([
      record(1, { type: "RUN_CREATED" }),
      record(2, { type: "AGENT_STARTED" }),
      record(3, { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" }),
      record(4, { type: "REPORT_GENERATION_STARTED" }),
      record(5, { type: "REPORT_SUBMITTED" }),
    ]);
    expect(map.size).toBe(4);
    expect(map.get("INVESTIGATION_CREATED")?.map((e) => e.sequence)).toEqual([1]);
    expect(map.get("AGENT_ANALYSIS")?.map((e) => e.sequence)).toEqual([2]);
    expect(map.get("DIAGNOSTIC_EXECUTION")?.map((e) => e.sequence)).toEqual([3]);
    expect(map.get("REPORT_GENERATION")?.map((e) => e.sequence)).toEqual([4, 5]);
  });

  it("preserves canonical sequence order within each stage", () => {
    // Input arrives in canonical order; interleaved types must stay ordered
    // under their own stage key.
    const map = groupEventsByStage([
      record(1, { type: "RUN_CREATED" }),
      record(2, { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" }),
      record(3, { type: "AGENT_STARTED" }),
      record(4, { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "check_status" }),
      record(5, { type: "RETRIEVAL_COMPLETED", chunks: [] }),
    ]);
    expect(map.get("DIAGNOSTIC_EXECUTION")?.map((e) => e.sequence)).toEqual([2, 4]);
    expect(map.get("AGENT_ANALYSIS")?.map((e) => e.sequence)).toEqual([3, 5]);
  });

  it("excludes terminal events (RUN_COMPLETED, RUN_FAILED) entirely", () => {
    const map = groupEventsByStage([
      record(1, { type: "RUN_CREATED" }),
      record(2, { type: "RUN_COMPLETED" }),
      record(3, { type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("INVESTIGATION_CREATED")?.map((e) => e.sequence)).toEqual([1]);
    expect([...map.values()].flat()).toHaveLength(1);
  });

  it("safely skips a legacy REPORT_GENERATED record — no Map entry, no undefined key, no fabricated event", () => {
    const map = groupEventsByStage([
      record(1, { type: "RUN_CREATED" }),
      record(2, { type: "REPORT_GENERATED" }),
      record(3, { type: "AGENT_STARTED" }),
    ]);
    expect(map.size).toBe(2);
    expect(map.has("REPORT_GENERATION")).toBe(false);
    expect(map.get("INVESTIGATION_CREATED")?.map((e) => e.sequence)).toEqual([1]);
    expect(map.get("AGENT_ANALYSIS")?.map((e) => e.sequence)).toEqual([3]);
    expect([...map.values()].flat()).toHaveLength(2);
  });

  it("returns an empty Map for empty input", () => {
    expect(groupEventsByStage([]).size).toBe(0);
  });
});

describe("buildExecutionStageRows", () => {
  it("attaches each stage's grouped events to the correct row", () => {
    const rows = buildExecutionStageRows(fourStages(), new Map([
      [
        "INVESTIGATION_CREATED",
        [{ sequence: 1, label: "Run created" } satisfies InvestigationEventViewModel],
      ],
      [
        "DIAGNOSTIC_EXECUTION",
        [
          { sequence: 3, label: "Tool requested" },
          { sequence: 4, label: "Tool completed" },
        ],
      ],
    ]));
    expect(rows.find((r) => r.key === "INVESTIGATION_CREATED")?.events).toEqual([
      { sequence: 1, label: "Run created" },
    ]);
    expect(rows.find((r) => r.key === "DIAGNOSTIC_EXECUTION")?.events?.map((e) => e.sequence)).toEqual([3, 4]);
    expect(rows.find((r) => r.key === "AGENT_ANALYSIS")?.events).toBeUndefined();
    expect(rows.find((r) => r.key === "REPORT_GENERATION")?.events).toBeUndefined();
  });

  it("produces rows with no events when the events map is empty", () => {
    const rows = buildExecutionStageRows(fourStages());
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.events).toBeUndefined();
    }
  });

  it("keeps the existing key/status/label contract intact", () => {
    const rows = buildExecutionStageRows(fourStages());
    expect(rows.map((r) => r.key)).toEqual(INVESTIGATION_EXECUTION_STAGE_ORDER);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.map((r) => r.label)).toEqual([
      "Investigation created",
      "Agent analysis",
      "Diagnostic execution",
      "Report generation",
    ]);
  });

  // Issue #41 HQ polish §1 — "Not reached" (an earlier stage failed) vs
  // "Not applicable" (this stage never applies to this kind of run) are
  // both backed by the same `omitted` status; `notReached` is the frontend-
  // only signal that tells them apart without touching the backend contract.
  describe("notReached", () => {
    it("marks an omitted stage that follows a failure", () => {
      const stages: readonly ExecutionStageProgress[] = [
        stage("INVESTIGATION_CREATED", "completed"),
        stage("AGENT_ANALYSIS", "failed"),
        stage("DIAGNOSTIC_EXECUTION", "omitted"),
        stage("REPORT_GENERATION", "omitted"),
      ];
      const rows = buildExecutionStageRows(stages);
      expect(rows.find((r) => r.key === "AGENT_ANALYSIS")?.notReached).toBeUndefined();
      expect(rows.find((r) => r.key === "DIAGNOSTIC_EXECUTION")?.notReached).toBe(true);
      expect(rows.find((r) => r.key === "REPORT_GENERATION")?.notReached).toBe(true);
    });

    it("leaves an omitted stage with no earlier failure unmarked (stays 'Not applicable')", () => {
      const stages: readonly ExecutionStageProgress[] = [
        stage("INVESTIGATION_CREATED", "completed"),
        stage("AGENT_ANALYSIS", "completed"),
        stage("DIAGNOSTIC_EXECUTION", "omitted"),
        stage("REPORT_GENERATION", "completed"),
      ];
      const rows = buildExecutionStageRows(stages);
      expect(rows.find((r) => r.key === "DIAGNOSTIC_EXECUTION")?.notReached).toBeUndefined();
    });

    it("never marks a completed/active/failed/pending row", () => {
      const rows = buildExecutionStageRows(fourStages());
      for (const row of rows) {
        expect(row.notReached).toBeUndefined();
      }
    });
  });
});

describe("findFailedExecutionStageLabel", () => {
  function row(overrides: Partial<ExecutionStageRowViewModel> = {}): ExecutionStageRowViewModel {
    return { key: "AGENT_ANALYSIS", status: "completed", label: "Agent analysis", ...overrides };
  }

  it("returns null when there are no children (legacy run)", () => {
    expect(findFailedExecutionStageLabel(undefined)).toBeNull();
  });

  it("returns null when no child failed", () => {
    const children = [row({ status: "completed" }), row({ key: "REPORT_GENERATION", status: "completed", label: "Report generation" })];
    expect(findFailedExecutionStageLabel(children)).toBeNull();
  });

  it("returns the lowercase-first-letter label of the failed stage", () => {
    const children = [
      row({ key: "INVESTIGATION_CREATED", status: "completed", label: "Investigation created" }),
      row({ key: "AGENT_ANALYSIS", status: "failed", label: "Agent analysis" }),
    ];
    expect(findFailedExecutionStageLabel(children)).toBe("agent analysis");
  });

  it("lowercases only the first letter, leaving the rest of the label untouched", () => {
    const children = [row({ key: "DIAGNOSTIC_EXECUTION", status: "failed", label: "Diagnostic execution" })];
    expect(findFailedExecutionStageLabel(children)).toBe("diagnostic execution");
  });
});
