import {
  INVESTIGATION_EXECUTION_STAGE_ORDER,
  type InvestigationEventRecord,
} from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import { applyAcceptedSnapshotDerivation, type ExecutionStageIdentity } from "./execution-stage-derivation";
import { buildExecutionStageRows, groupEventsByStage } from "./execution-stage-rows";

// Issue #57 Checkpoint C — web compatibility proof (test-only, no #56
// presentation work). The existing investigation-progress logic must consume
// a VALID repeated-tool canonical stream — the shape the bounded orchestrator
// now produces — without collapsing repeated TOOL_* events, without throwing,
// and without inventing any synthetic UI event.

const RUN_ID = "834cb857-2832-410e-ba3e-a10574a42a6d";
const JOB_ID = "job-57";
const NOW = "2026-01-01T00:02:00.000Z";

function makeEvent(sequence: number, payload: InvestigationEventRecord["payload"]): InvestigationEventRecord {
  return { runId: RUN_ID, sequence, recordedAt: NOW, payload };
}

function toolRequest(sequence: number, callId: string): InvestigationEventRecord {
  return makeEvent(sequence, { type: "TOOL_REQUESTED", toolCallId: callId, toolName: "get_service_status" });
}

function toolCompleted(sequence: number, callId: string): InvestigationEventRecord {
  return makeEvent(sequence, { type: "TOOL_COMPLETED", toolCallId: callId, toolName: "get_service_status" });
}

/**
 * The max-bound stream: three serial diagnostic pairs, then the FORCED
 * finalization turn, so REPORT_GENERATION_STARTED is present at sequence 9.
 */
function makeForcedFinalizationStream(): readonly InvestigationEventRecord[] {
  return [
    makeEvent(1, { type: "RUN_CREATED" }),
    makeEvent(2, { type: "AGENT_STARTED" }),
    toolRequest(3, "call-1"),
    toolCompleted(4, "call-1"),
    toolRequest(5, "call-2"),
    toolCompleted(6, "call-2"),
    toolRequest(7, "call-3"),
    toolCompleted(8, "call-3"),
    makeEvent(9, { type: "REPORT_GENERATION_STARTED" }),
    makeEvent(10, { type: "REPORT_SUBMITTED" }),
    makeEvent(11, { type: "REPORT_VALIDATED" }),
    makeEvent(12, { type: "RUN_COMPLETED" }),
  ];
}

/**
 * The voluntary-early-report stream: two diagnostic pairs, then the provider
 * submits on a still-available investigation turn, so REPORT_GENERATION_STARTED
 * is correctly absent.
 */
function makeVoluntaryEarlyReportStream(): readonly InvestigationEventRecord[] {
  return [
    makeEvent(1, { type: "RUN_CREATED" }),
    makeEvent(2, { type: "AGENT_STARTED" }),
    toolRequest(3, "call-1"),
    toolCompleted(4, "call-1"),
    toolRequest(5, "call-2"),
    toolCompleted(6, "call-2"),
    makeEvent(7, { type: "REPORT_SUBMITTED" }),
    makeEvent(8, { type: "REPORT_VALIDATED" }),
    makeEvent(9, { type: "RUN_COMPLETED" }),
  ];
}

const IDENTITY: ExecutionStageIdentity = { jobId: JOB_ID, runId: RUN_ID, attemptNumber: 1 };

describe("issue #57 Checkpoint C — repeated-tool canonical stream compatibility", () => {
  it("derives canonical (not canonical-invalid) four-stage progress from the forced-finalization stream", () => {
    const { derivation } = applyAcceptedSnapshotDerivation(IDENTITY, makeForcedFinalizationStream(), "COMPLETED", NOW, null);
    expect(derivation.kind).toBe("canonical");
    if (derivation.kind !== "canonical") throw new Error("unreachable");

    expect(derivation.stages.map((stage) => stage.key)).toEqual(INVESTIGATION_EXECUTION_STAGE_ORDER);
    expect(derivation.stages).toHaveLength(4);
    const byKey = Object.fromEntries(derivation.stages.map((stage) => [stage.key, stage.status]));
    expect(byKey).toMatchObject({
      INVESTIGATION_CREATED: "completed",
      AGENT_ANALYSIS: "completed",
      DIAGNOSTIC_EXECUTION: "completed",
      REPORT_GENERATION: "completed",
    });
  });

  it("groups all six repeated tool events in sequence under DIAGNOSTIC_EXECUTION — none dropped, none reordered", () => {
    const eventsByStage = groupEventsByStage(makeForcedFinalizationStream());
    const diagnosticEvents = eventsByStage.get("DIAGNOSTIC_EXECUTION");
    expect(diagnosticEvents).toBeDefined();
    expect(diagnosticEvents?.map((event) => event.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(diagnosticEvents?.map((event) => event.label)).toEqual([
      "Tool requested: Get service status",
      "Tool completed: Get service status",
      "Tool requested: Get service status",
      "Tool completed: Get service status",
      "Tool requested: Get service status",
      "Tool completed: Get service status",
    ]);

    const reportEvents = eventsByStage.get("REPORT_GENERATION");
    expect(reportEvents?.map((event) => event.sequence)).toEqual([9, 10, 11]);
  });

  it("keeps the four macro execution-stage rows valid with the full repeated-event payload attached", () => {
    const { derivation } = applyAcceptedSnapshotDerivation(IDENTITY, makeForcedFinalizationStream(), "COMPLETED", NOW, null);
    if (derivation.kind !== "canonical") throw new Error("unreachable");

    const rows = buildExecutionStageRows(derivation.stages, groupEventsByStage(makeForcedFinalizationStream()));
    expect(rows.map((row) => row.key)).toEqual(INVESTIGATION_EXECUTION_STAGE_ORDER);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === "completed")).toBe(true);

    const diagnosticRow = rows.find((row) => row.key === "DIAGNOSTIC_EXECUTION");
    expect(diagnosticRow?.events?.map((event) => event.sequence)).toEqual([3, 4, 5, 6, 7, 8]);

    // No synthetic UI event: the sum of grouped events equals the count of
    // observed NON-terminal events (RUN_COMPLETED is intentionally excluded
    // from stage rows). Nothing was fabricated or dropped.
    const groupedTotal = rows.reduce((total, row) => total + (row.events?.length ?? 0), 0);
    const nonTerminalObserved = makeForcedFinalizationStream().filter(
      (event) => event.payload.type !== "RUN_COMPLETED",
    ).length;
    expect(groupedTotal).toBe(nonTerminalObserved);
    expect(groupedTotal).toBe(11);
  });

  it("renders the voluntary early-report stream without an exception or a synthesized REPORT_GENERATION_STARTED", () => {
    const stream = makeVoluntaryEarlyReportStream();
    const { derivation } = applyAcceptedSnapshotDerivation(IDENTITY, stream, "COMPLETED", NOW, null);
    expect(derivation.kind).toBe("canonical");
    if (derivation.kind !== "canonical") throw new Error("unreachable");

    const byKey = Object.fromEntries(derivation.stages.map((stage) => [stage.key, stage.status]));
    expect(byKey.DIAGNOSTIC_EXECUTION).toBe("completed");
    expect(byKey.REPORT_GENERATION).toBe("completed");

    const eventsByStage = groupEventsByStage(stream);
    expect(eventsByStage.get("DIAGNOSTIC_EXECUTION")?.map((event) => event.sequence)).toEqual([3, 4, 5, 6]);
    // The absence of REPORT_GENERATION_STARTED is preserved — nothing is
    // injected to paper over the voluntary early report.
    expect(
      stream.some((event) => event.payload.type === "REPORT_GENERATION_STARTED"),
    ).toBe(false);
  });
});
