import { describe, expect, it } from "vitest";

import { AgentTraceEventSchema } from "./agent-trace-event";
import type {
  InvestigationEventRecord,
  InvestigationEventRecordPayload,
} from "./investigation-event";
import {
  hasCanonicalInvestigationLifecycleMarker,
  projectToLegacyAgentTraceEvent,
} from "./investigation-lifecycle-compatibility";
import {
  InvestigationEventContractError,
  deriveExecutionStageProgress,
} from "./investigation-stage-progress-reducer";

const RUN_ID = "44444444-4444-4444-8444-444444444444";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function at(offsetSeconds: number): string {
  return new Date(T0 + offsetSeconds * 1000).toISOString();
}

function stream(
  payloads: readonly InvestigationEventRecordPayload[],
): InvestigationEventRecord[] {
  return payloads.map((payload, index) => ({
    runId: RUN_ID,
    sequence: index + 1,
    recordedAt: at(index),
    payload,
  }));
}

function record(payload: InvestigationEventRecordPayload): InvestigationEventRecord {
  return { runId: RUN_ID, sequence: 1, recordedAt: at(0), payload };
}

/** Asserts the exact typed contract-error code from the reducer. */
function expectReducerCode(
  events: readonly InvestigationEventRecord[],
  runStatus: "RUNNING" | "COMPLETED" | "FAILED",
  expected: string,
) {
  let caught: unknown;
  try {
    deriveExecutionStageProgress({ events, runStatus, now: at(20) });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvestigationEventContractError);
  expect((caught as InvestigationEventContractError).code).toBe(expected);
}

describe("hasCanonicalInvestigationLifecycleMarker is origin-only", () => {
  it("returns true for any stream beginning with RUN_CREATED at sequence 1", () => {
    expect(
      hasCanonicalInvestigationLifecycleMarker(stream([{ type: "RUN_CREATED" }, { type: "AGENT_STARTED" }])),
    ).toBe(true);
    expect(
      hasCanonicalInvestigationLifecycleMarker(stream([{ type: "RUN_CREATED" }, { type: "RUN_COMPLETED" }])),
    ).toBe(true);
  });

  it("returns false for an empty stream — there is no origin evidence", () => {
    expect(hasCanonicalInvestigationLifecycleMarker([])).toBe(false);
  });

  it("returns false for a historical four-type legacy trace", () => {
    const legacy = stream([
      { type: "RETRIEVAL_COMPLETED", chunks: [] },
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" },
      { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "check_status" },
      { type: "REPORT_GENERATED" },
    ]);
    expect(hasCanonicalInvestigationLifecycleMarker(legacy)).toBe(false);
  });

  it("returns false when RUN_CREATED is present but not at sequence 1", () => {
    const shifted = stream([{ type: "AGENT_STARTED" }, { type: "RUN_CREATED" }]);
    expect(hasCanonicalInvestigationLifecycleMarker(shifted)).toBe(false);
  });

  // The load-bearing property: corruption must not be mistaken for legacy
  // origin, or genuinely broken canonical data would be silently routed into
  // the frontend's legacy inference instead of raising an error.
  it("still returns true for a canonical stream missing its terminal event, which the reducer then rejects", () => {
    const malformed = stream([{ type: "RUN_CREATED" }, { type: "AGENT_STARTED" }]);
    expect(hasCanonicalInvestigationLifecycleMarker(malformed)).toBe(true);
    expectReducerCode(malformed, "COMPLETED", "RUN_STATUS_MISMATCH");
  });

  it("still returns true on a runStatus/terminal mismatch, which the reducer then rejects", () => {
    const mismatched = stream([
      { type: "RUN_CREATED" },
      { type: "AGENT_STARTED" },
      { type: "REPORT_SUBMITTED" },
      { type: "REPORT_VALIDATED" },
      { type: "RUN_COMPLETED" },
    ]);
    expect(hasCanonicalInvestigationLifecycleMarker(mismatched)).toBe(true);
    expectReducerCode(mismatched, "FAILED", "RUN_STATUS_MISMATCH");
  });

  it("still returns true when an event follows a terminal event, which the reducer then rejects", () => {
    const afterTerminal = stream([
      { type: "RUN_CREATED" },
      { type: "AGENT_STARTED" },
      { type: "REPORT_SUBMITTED" },
      { type: "REPORT_VALIDATED" },
      { type: "RUN_COMPLETED" },
      { type: "RETRIEVAL_COMPLETED", chunks: [] },
    ]);
    expect(hasCanonicalInvestigationLifecycleMarker(afterTerminal)).toBe(true);
    expectReducerCode(afterTerminal, "COMPLETED", "EVENT_AFTER_TERMINAL");
  });

  it("still returns true on a duplicated lifecycle fact, which the reducer then rejects", () => {
    const duplicated = stream([{ type: "RUN_CREATED" }, { type: "RUN_CREATED" }]);
    expect(hasCanonicalInvestigationLifecycleMarker(duplicated)).toBe(true);
    expectReducerCode(duplicated, "RUNNING", "DUPLICATE_LIFECYCLE_FACT");
  });

  it("is only a marker: a structurally invalid completion still passes it", () => {
    const malformed = stream([{ type: "RUN_CREATED" }, { type: "RUN_COMPLETED" }]);
    expect(hasCanonicalInvestigationLifecycleMarker(malformed)).toBe(true);
    expectReducerCode(malformed, "COMPLETED", "MISSING_LIFECYCLE_FACT");
  });
});

describe("the marker never throws on malformed JavaScript input", () => {
  // #38 will call this on data that just crossed an HTTP boundary, so a
  // JavaScript caller can supply objects the TypeScript signature forbids.
  // Returning false lets the caller fall through to its legacy/empty path;
  // throwing would remove its ability to route at all.
  it("returns false for a record with no payload", () => {
    expect(hasCanonicalInvestigationLifecycleMarker([{ sequence: 1 } as never])).toBe(false);
  });

  it("returns false for a null payload", () => {
    expect(hasCanonicalInvestigationLifecycleMarker([{ sequence: 1, payload: null } as never])).toBe(false);
  });

  it("returns true for a minimal origin record", () => {
    expect(
      hasCanonicalInvestigationLifecycleMarker([
        { sequence: 1, payload: { type: "RUN_CREATED" } } as never,
      ]),
    ).toBe(true);
  });

  it("returns false for other malformed shapes without throwing", () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      "RUN_CREATED",
      42,
      {},
      { sequence: "1", payload: { type: "RUN_CREATED" } },
      { sequence: 2, payload: { type: "RUN_CREATED" } },
      { sequence: 1, payload: {} },
      { sequence: 1, payload: { type: null } },
      { sequence: 1, payload: [] },
    ];
    for (const first of malformed) {
      expect(
        hasCanonicalInvestigationLifecycleMarker([first as never]),
        `input ${JSON.stringify(first) ?? String(first)}`,
      ).toBe(false);
    }
  });

  it("the reducer still rejects the minimal marker record as an invalid event record", () => {
    let caught: unknown;
    try {
      deriveExecutionStageProgress({
        events: [{ sequence: 1, payload: { type: "RUN_CREATED" } } as never],
        runStatus: "RUNNING",
        now: at(1),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvestigationEventContractError);
    expect((caught as InvestigationEventContractError).code).toBe("INVALID_EVENT_RECORD");
  });
});

describe("legacy data is never assigned fabricated stage precision", () => {
  it("the reducer refuses a legacy stream instead of inventing a failed stage", () => {
    const legacy = stream([
      { type: "RETRIEVAL_COMPLETED", chunks: [] },
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" },
    ]);

    let caught: unknown;
    try {
      deriveExecutionStageProgress({ events: legacy, runStatus: "FAILED", now: at(5) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvestigationEventContractError);
    expect((caught as InvestigationEventContractError).code).toBe("RUN_CREATED_NOT_FIRST");
  });
});

describe("projectToLegacyAgentTraceEvent", () => {
  it("projects the four legacy activity types as themselves", () => {
    expect(projectToLegacyAgentTraceEvent(record({ type: "RETRIEVAL_COMPLETED", chunks: [] }))).toEqual({
      type: "RETRIEVAL_COMPLETED",
      chunks: [],
    });
    expect(
      projectToLegacyAgentTraceEvent(record({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" })),
    ).toEqual({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" });
    expect(
      projectToLegacyAgentTraceEvent(record({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" })),
    ).toEqual({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" });
    expect(projectToLegacyAgentTraceEvent(record({ type: "REPORT_GENERATED" }))).toEqual({
      type: "REPORT_GENERATED",
    });
  });

  it("projects an assessment-carrying TOOL_REQUESTED to the narrow legacy shape, dropping the assessment", () => {
    // Issue #58 Checkpoint B (§5.3): NEW canonical TOOL_REQUESTED appends carry
    // a validated `assessment`, but the legacy in-memory trace object is
    // deliberately assessment-free. The projection must therefore DROP the
    // extra field — the read-side record schema keeps it optional (so every
    // #57-and-earlier row stays readable), and the legacy projection is the
    // narrow {type, toolCallId, toolName} shape regardless.
    const withAssessment = record({
      type: "TOOL_REQUESTED",
      toolCallId: "c1",
      toolName: "t",
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "NO_EVIDENCE_YET",
        supportedBy: [],
      },
    });
    expect(projectToLegacyAgentTraceEvent(withAssessment)).toEqual({
      type: "TOOL_REQUESTED",
      toolCallId: "c1",
      toolName: "t",
    });
    // And the projection is a valid AgentTraceEvent — no lingering assessment.
    const projected = projectToLegacyAgentTraceEvent(withAssessment);
    expect(AgentTraceEventSchema.safeParse(projected).success).toBe(true);
  });

  it("remaps REPORT_VALIDATED to the legacy REPORT_GENERATED meaning", () => {
    expect(projectToLegacyAgentTraceEvent(record({ type: "REPORT_VALIDATED" }))).toEqual({
      type: "REPORT_GENERATED",
    });
  });

  it("excludes every lifecycle-only event", () => {
    const lifecycleOnly: readonly InvestigationEventRecordPayload[] = [
      { type: "RUN_CREATED" },
      { type: "AGENT_STARTED" },
      { type: "REPORT_GENERATION_STARTED" },
      { type: "REPORT_SUBMITTED" },
      { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
      { type: "RUN_COMPLETED" },
      { type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" },
    ];
    for (const payload of lifecycleOnly) {
      expect(projectToLegacyAgentTraceEvent(record(payload)), `${payload.type} should project to null`).toBeNull();
    }
  });

  it("excludes TOOL_FAILED by deliberate current choice", () => {
    expect(
      projectToLegacyAgentTraceEvent(
        record({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" }),
      ),
    ).toBeNull();
  });

  it("covers every payload type at runtime, and every projected value is a valid AgentTraceEvent", () => {
    const allPayloads: readonly InvestigationEventRecordPayload[] = [
      { type: "RUN_CREATED" },
      { type: "AGENT_STARTED" },
      { type: "RETRIEVAL_COMPLETED", chunks: [] },
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" },
      { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" },
      { type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" },
      { type: "REPORT_GENERATION_STARTED" },
      { type: "REPORT_SUBMITTED" },
      { type: "REPORT_VALIDATED" },
      { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
      { type: "RUN_COMPLETED" },
      { type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" },
      { type: "REPORT_GENERATED" },
    ];

    // All 13 record payload types are exercised — the switch has no default
    // fall-through, so this also proves no type throws at runtime.
    expect(allPayloads).toHaveLength(13);

    for (const payload of allPayloads) {
      const projected = projectToLegacyAgentTraceEvent(record(payload));
      if (projected !== null) {
        expect(
          AgentTraceEventSchema.safeParse(projected).success,
          `projection of ${payload.type} must be a valid AgentTraceEvent`,
        ).toBe(true);
      }
    }
  });
});
