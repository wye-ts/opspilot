import { describe, expect, it } from "vitest";
import type { InvestigationEventRecord } from "@opspilot/contracts";
import {
  applyAcceptedSnapshotDerivation,
  deriveExecutionStageDerivation,
  type ExecutionStageIdentity,
} from "./execution-stage-derivation";

const RUN_ID = "834cb857-2832-410e-ba3e-a10574a42a6d";
const NOW = "2026-01-01T00:02:00.000Z";

function makeEvent(sequence: number, payload: InvestigationEventRecord["payload"]): InvestigationEventRecord {
  return { runId: RUN_ID, sequence, recordedAt: NOW, payload };
}

function makeLegacyEvents(): readonly InvestigationEventRecord[] {
  // No RUN_CREATED at sequence 1 — this is a legacy stream
  return [
    makeEvent(1, { type: "TOOL_REQUESTED" as any, toolCallId: "call-1", toolName: "get_service_status" }),
    makeEvent(2, { type: "TOOL_COMPLETED" as any, toolCallId: "call-1", toolName: "get_service_status" }),
  ];
}

function makeRunningPrefix(): readonly InvestigationEventRecord[] {
  return [
    makeEvent(1, { type: "RUN_CREATED" }),
    makeEvent(2, { type: "AGENT_STARTED" }),
    makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
  ];
}

function makeCompletedStream(): readonly InvestigationEventRecord[] {
  return [
    makeEvent(1, { type: "RUN_CREATED" }),
    makeEvent(2, { type: "AGENT_STARTED" }),
    makeEvent(3, { type: "REPORT_SUBMITTED" }),
    makeEvent(4, { type: "REPORT_VALIDATED" }),
    makeEvent(5, { type: "RUN_COMPLETED" }),
  ];
}

describe("deriveExecutionStageDerivation", () => {
  it("returns legacy when marker is false", () => {
    const result = deriveExecutionStageDerivation(makeLegacyEvents(), "COMPLETED", NOW, { kind: "legacy" });
    expect(result).toEqual({ kind: "legacy" });
  });

  it("returns canonical when marker is true and stream is valid", () => {
    const result = deriveExecutionStageDerivation(makeCompletedStream(), "COMPLETED", NOW, { kind: "legacy" });
    expect(result.kind).toBe("canonical");
    if (result.kind === "canonical") {
      expect(result.stages).toHaveLength(4);
    }
  });

  it("returns canonical with partial RUNNING prefix (reducer accepts these)", () => {
    const result = deriveExecutionStageDerivation(makeRunningPrefix(), "RUNNING", NOW, { kind: "legacy" });
    expect(result.kind).toBe("canonical");
  });

  it("returns canonical-invalid with null lastGoodStages on first-snapshot corruption", () => {
    // A corrupt stream: RUN_CREATED at sequence 1 but no AGENT_STARTED before RUN_COMPLETED
    const corrupt = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "RUN_COMPLETED" }),
    ];
    const result = deriveExecutionStageDerivation(corrupt, "COMPLETED", NOW, { kind: "legacy" });
    expect(result).toEqual({ kind: "canonical-invalid", lastGoodStages: null });
  });

  it("returns canonical-invalid preserving last good stages after a valid snapshot", () => {
    // First: a valid completed stream
    const first = deriveExecutionStageDerivation(makeCompletedStream(), "COMPLETED", NOW, { kind: "legacy" });
    expect(first.kind).toBe("canonical");

    // Then: a corrupt stream — should preserve previous stages
    const corrupt = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "RUN_COMPLETED" }),
    ];
    const second = deriveExecutionStageDerivation(corrupt, "COMPLETED", NOW, first);
    expect(second.kind).toBe("canonical-invalid");
    if (second.kind === "canonical-invalid") {
      expect(second.lastGoodStages).not.toBeNull();
    }
  });

  it("carries forward lastGoodStages from a prior canonical-invalid state", () => {
    const prior: ReturnType<typeof deriveExecutionStageDerivation> = {
      kind: "canonical-invalid",
      lastGoodStages: [],
    };
    const corrupt = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "RUN_COMPLETED" }),
    ];
    const result = deriveExecutionStageDerivation(corrupt, "COMPLETED", NOW, prior);
    expect(result).toEqual({ kind: "canonical-invalid", lastGoodStages: [] });
  });
});

describe("applyAcceptedSnapshotDerivation (Findings 5/6 — identity-scoped, centralized)", () => {
  const attempt1: ExecutionStageIdentity = { jobId: "job-1", runId: "run-1", attemptNumber: 1 };
  const attempt2: ExecutionStageIdentity = { jobId: "job-1", runId: "run-2", attemptNumber: 2 };
  const corruptStream = [makeEvent(1, { type: "RUN_CREATED" }), makeEvent(2, { type: "RUN_COMPLETED" })];

  it("a first canonical-invalid snapshot for a NEW attempt never inherits a DIFFERENT attempt's last-good stages", () => {
    const attempt1Valid = applyAcceptedSnapshotDerivation(attempt1, makeCompletedStream(), "COMPLETED", NOW, null);
    expect(attempt1Valid.derivation.kind).toBe("canonical");

    // Attempt 2's FIRST snapshot is corrupt — must not see attempt 1's stages.
    const attempt2Invalid = applyAcceptedSnapshotDerivation(attempt2, corruptStream, "COMPLETED", NOW, attempt1Valid);
    expect(attempt2Invalid.derivation).toEqual({ kind: "canonical-invalid", lastGoodStages: null });
    expect(attempt2Invalid.identity).toEqual(attempt2);
  });

  it("same-run corruption after valid data still preserves that SAME run's last-good stages", () => {
    const valid = applyAcceptedSnapshotDerivation(attempt1, makeCompletedStream(), "COMPLETED", NOW, null);
    const stillInvalid = applyAcceptedSnapshotDerivation(attempt1, corruptStream, "COMPLETED", NOW, valid);
    expect(stillInvalid.derivation.kind).toBe("canonical-invalid");
    if (stillInvalid.derivation.kind === "canonical-invalid") {
      expect(stillInvalid.derivation.lastGoodStages).not.toBeNull();
    }
  });

  it("a different jobId also resets — not only attemptNumber", () => {
    const valid = applyAcceptedSnapshotDerivation(attempt1, makeCompletedStream(), "COMPLETED", NOW, null);
    const otherJob: ExecutionStageIdentity = { ...attempt1, jobId: "job-2" };
    const result = applyAcceptedSnapshotDerivation(otherJob, corruptStream, "COMPLETED", NOW, valid);
    expect(result.derivation).toEqual({ kind: "canonical-invalid", lastGoodStages: null });
  });

  it("null previous state (fresh workflow) never throws and starts from legacy", () => {
    const result = applyAcceptedSnapshotDerivation(attempt1, corruptStream, "COMPLETED", NOW, null);
    expect(result.derivation).toEqual({ kind: "canonical-invalid", lastGoodStages: null });
  });
});
