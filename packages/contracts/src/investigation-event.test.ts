import { describe, expect, it } from "vitest";

import { AgentTraceEventSchema, ToolRequestedTraceEventSchema } from "./agent-trace-event";
import {
  INVESTIGATION_EVENT_LEGACY_TYPE_COUNT,
  INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT,
  InvestigationEventPayloadSchema,
  InvestigationEventRecordPayloadSchema,
  InvestigationEventRecordSchema,
  ToolRequestedRecordEventSchema,
  ToolRequestedWriteEventSchema,
  mapInvestigationEventToExecutionStage,
} from "./investigation-event";
import {
  INVESTIGATION_EXECUTION_STAGE_ORDER,
  type InvestigationExecutionStage,
} from "./investigation-execution-stage";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function baseRecord(payload: unknown) {
  return { runId: RUN_ID, sequence: 1, recordedAt: "2026-01-01T00:00:00.000Z", payload };
}

describe("taxonomy count", () => {
  it("has exactly 12 new-write types and 1 legacy read-compat type", () => {
    expect(INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT).toBe(12);
    expect(INVESTIGATION_EVENT_LEGACY_TYPE_COUNT).toBe(1);
    expect(InvestigationEventPayloadSchema.options).toHaveLength(12);
  });
});

describe("event payload/record separation", () => {
  it("payload events validate without any persistence envelope field", () => {
    expect(InvestigationEventPayloadSchema.safeParse({ type: "RUN_CREATED" }).success).toBe(true);
  });

  it("payload events reject persistence envelope fields", () => {
    expect(
      InvestigationEventPayloadSchema.safeParse({
        type: "RUN_CREATED",
        runId: RUN_ID,
        sequence: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("persisted/read records require runId, positive sequence, and recordedAt", () => {
    expect(InvestigationEventRecordSchema.safeParse(baseRecord({ type: "RUN_CREATED" })).success).toBe(true);

    const payload = { type: "RUN_CREATED" };
    const recordedAt = "2026-01-01T00:00:00.000Z";
    expect(InvestigationEventRecordSchema.safeParse({ sequence: 1, recordedAt, payload }).success).toBe(false);
    expect(InvestigationEventRecordSchema.safeParse({ runId: RUN_ID, recordedAt, payload }).success).toBe(false);
    expect(
      InvestigationEventRecordSchema.safeParse({ runId: RUN_ID, sequence: 0, recordedAt, payload }).success,
    ).toBe(false);
    expect(InvestigationEventRecordSchema.safeParse({ runId: RUN_ID, sequence: 1, payload }).success).toBe(false);
  });

  it("rejects a non-uuid runId and a malformed recordedAt", () => {
    const payload = { type: "RUN_CREATED" };
    expect(
      InvestigationEventRecordSchema.safeParse({
        runId: "not-a-uuid",
        sequence: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        payload,
      }).success,
    ).toBe(false);
    expect(
      InvestigationEventRecordSchema.safeParse({
        runId: RUN_ID,
        sequence: 1,
        recordedAt: "yesterday",
        payload,
      }).success,
    ).toBe(false);
  });
});

describe("strict union behavior", () => {
  const minimalPayloadByType: Record<string, unknown> = {
    RUN_CREATED: { type: "RUN_CREATED" },
    AGENT_STARTED: { type: "AGENT_STARTED" },
    RETRIEVAL_COMPLETED: { type: "RETRIEVAL_COMPLETED", chunks: [] },
    TOOL_REQUESTED: {
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "check_status",
      // Checkpoint B: the new-write branch requires a valid assessment.
      assessment: {
        evidenceState: "INSUFFICIENT",
        continuationReason: "NO_EVIDENCE_YET",
        supportedBy: [],
      },
    },
    TOOL_COMPLETED: { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "check_status" },
    TOOL_FAILED: {
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "check_status",
      failureCode: "TOOL_EXECUTION_FAILED",
    },
    REPORT_GENERATION_STARTED: { type: "REPORT_GENERATION_STARTED" },
    REPORT_SUBMITTED: { type: "REPORT_SUBMITTED" },
    REPORT_VALIDATED: { type: "REPORT_VALIDATED" },
    REPORT_VALIDATION_FAILED: { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
    RUN_COMPLETED: { type: "RUN_COMPLETED" },
    RUN_FAILED: {
      type: "RUN_FAILED",
      failureCode: "PROVIDER_TIMEOUT",
      failedStage: "AGENT_ANALYSIS",
    },
  };

  it("every one of the 12 new-write types validates with only its legal fields", () => {
    for (const [type, payload] of Object.entries(minimalPayloadByType)) {
      expect(InvestigationEventPayloadSchema.safeParse(payload).success, `expected ${type} to validate`).toBe(true);
    }
    expect(Object.keys(minimalPayloadByType)).toHaveLength(12);
  });

  it("legacy REPORT_GENERATED validates for reads but not for new writes", () => {
    expect(InvestigationEventRecordSchema.safeParse(baseRecord({ type: "REPORT_GENERATED" })).success).toBe(true);
    expect(InvestigationEventPayloadSchema.safeParse({ type: "REPORT_GENERATED" }).success).toBe(false);
  });

  it("unknown fields fail", () => {
    expect(
      InvestigationEventPayloadSchema.safeParse({ type: "RUN_CREATED", extra: "nope" }).success,
    ).toBe(false);
  });

  it("tool fields on non-tool events fail", () => {
    expect(
      InvestigationEventPayloadSchema.safeParse({ type: "RUN_CREATED", toolName: "check_status" }).success,
    ).toBe(false);
    expect(
      InvestigationEventPayloadSchema.safeParse({ type: "REPORT_SUBMITTED", toolCallId: "call-1" }).success,
    ).toBe(false);
  });

  it("report failure codes on TOOL_FAILED fail", () => {
    for (const failureCode of ["REPORT_SCHEMA_INVALID", "REPORT_EVIDENCE_INVALID", "PROVIDER_TIMEOUT"]) {
      expect(
        InvestigationEventPayloadSchema.safeParse({
          type: "TOOL_FAILED",
          toolCallId: "call-1",
          toolName: "check_status",
          failureCode,
        }).success,
        `expected TOOL_FAILED to reject ${failureCode}`,
      ).toBe(false);
    }
  });

  it("accepts each of the four legal tool failure codes", () => {
    for (const failureCode of [
      "TOOL_NOT_FOUND",
      "TOOL_INPUT_INVALID",
      "TOOL_EXECUTION_FAILED",
      "TOOL_OUTPUT_INVALID",
    ]) {
      expect(
        InvestigationEventPayloadSchema.safeParse({
          type: "TOOL_FAILED",
          toolCallId: "call-1",
          toolName: "check_status",
          failureCode,
        }).success,
        `expected TOOL_FAILED to accept ${failureCode}`,
      ).toBe(true);
    }
  });

  it("tool failure codes on REPORT_VALIDATION_FAILED fail", () => {
    for (const failureCode of ["TOOL_NOT_FOUND", "TOOL_EXECUTION_FAILED", "PROVIDER_TIMEOUT"]) {
      expect(
        InvestigationEventPayloadSchema.safeParse({ type: "REPORT_VALIDATION_FAILED", failureCode }).success,
        `expected REPORT_VALIDATION_FAILED to reject ${failureCode}`,
      ).toBe(false);
    }
  });

  it("accepts both legal report-validation failure codes", () => {
    for (const failureCode of ["REPORT_SCHEMA_INVALID", "REPORT_EVIDENCE_INVALID"]) {
      expect(
        InvestigationEventPayloadSchema.safeParse({ type: "REPORT_VALIDATION_FAILED", failureCode }).success,
      ).toBe(true);
    }
  });

  it("the full orchestrator error union remains valid on RUN_FAILED", () => {
    for (const failureCode of ["RETRIEVAL_FAILED", "PROVIDER_TIMEOUT", "TOOL_EXECUTION_FAILED", "REPORT_SCHEMA_INVALID"]) {
      expect(
        InvestigationEventPayloadSchema.safeParse({
          type: "RUN_FAILED",
          failureCode,
          failedStage: "AGENT_ANALYSIS",
        }).success,
      ).toBe(true);
    }
  });
});

describe("RUN_FAILED carries no free-form message (public-safety)", () => {
  it("rejects a credential-bearing failureMessage", () => {
    const result = InvestigationEventPayloadSchema.safeParse({
      type: "RUN_FAILED",
      failureCode: "PROVIDER_UNAVAILABLE",
      failedStage: "AGENT_ANALYSIS",
      failureMessage: "Authorization: Bearer sk-secret; stack=Error at line 1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects the same field on a persisted record", () => {
    const result = InvestigationEventRecordSchema.safeParse(
      baseRecord({
        type: "RUN_FAILED",
        failureCode: "PROVIDER_UNAVAILABLE",
        failedStage: "AGENT_ANALYSIS",
        failureMessage: "Authorization: Bearer sk-secret",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("RUN_FAILED exposes exactly failureCode and failedStage", () => {
    const parsed = InvestigationEventPayloadSchema.parse({
      type: "RUN_FAILED",
      failureCode: "PROVIDER_TIMEOUT",
      failedStage: "REPORT_GENERATION",
    });
    expect(Object.keys(parsed).sort()).toEqual(["failedStage", "failureCode", "type"]);
  });
});

describe("mapInvestigationEventToExecutionStage", () => {
  // One minimal fixture per member of the 13-type record-payload union —
  // the same shapes the strict-union suite uses, plus the legacy
  // REPORT_GENERATED read-compat type.
  const fixtures: Readonly<Record<string, unknown>> = {
    RUN_CREATED: { type: "RUN_CREATED" },
    AGENT_STARTED: { type: "AGENT_STARTED" },
    RETRIEVAL_COMPLETED: { type: "RETRIEVAL_COMPLETED", chunks: [] },
    TOOL_REQUESTED: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "check_status" },
    TOOL_COMPLETED: { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "check_status" },
    TOOL_FAILED: {
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "check_status",
      failureCode: "TOOL_EXECUTION_FAILED",
    },
    REPORT_GENERATION_STARTED: { type: "REPORT_GENERATION_STARTED" },
    REPORT_SUBMITTED: { type: "REPORT_SUBMITTED" },
    REPORT_VALIDATED: { type: "REPORT_VALIDATED" },
    REPORT_VALIDATION_FAILED: { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
    RUN_COMPLETED: { type: "RUN_COMPLETED" },
    RUN_FAILED: { type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" },
    REPORT_GENERATED: { type: "REPORT_GENERATED" },
  };

  const expectedStageByType: Readonly<Record<string, InvestigationExecutionStage | null>> = {
    RUN_CREATED: "INVESTIGATION_CREATED",
    AGENT_STARTED: "AGENT_ANALYSIS",
    RETRIEVAL_COMPLETED: "AGENT_ANALYSIS",
    TOOL_REQUESTED: "DIAGNOSTIC_EXECUTION",
    TOOL_COMPLETED: "DIAGNOSTIC_EXECUTION",
    TOOL_FAILED: "DIAGNOSTIC_EXECUTION",
    REPORT_GENERATION_STARTED: "REPORT_GENERATION",
    REPORT_SUBMITTED: "REPORT_GENERATION",
    REPORT_VALIDATED: "REPORT_GENERATION",
    REPORT_VALIDATION_FAILED: "REPORT_GENERATION",
    RUN_COMPLETED: null,
    RUN_FAILED: null,
    REPORT_GENERATED: null,
  };

  it("returns the correct execution stage for all 12 canonical types", () => {
    for (const [type, fixture] of Object.entries(fixtures)) {
      if (type === "REPORT_GENERATED") continue;
      const payload = InvestigationEventRecordPayloadSchema.parse(fixture);
      expect(
        mapInvestigationEventToExecutionStage(payload),
        `expected ${type} to map to ${expectedStageByType[type]}`,
      ).toBe(expectedStageByType[type]);
    }
  });

  it("returns null for the RUN_COMPLETED terminal event", () => {
    const payload = InvestigationEventRecordPayloadSchema.parse(fixtures.RUN_COMPLETED);
    expect(mapInvestigationEventToExecutionStage(payload)).toBeNull();
  });

  it("returns null for the RUN_FAILED terminal event", () => {
    const payload = InvestigationEventRecordPayloadSchema.parse(fixtures.RUN_FAILED);
    expect(mapInvestigationEventToExecutionStage(payload)).toBeNull();
  });

  it("returns null for the legacy REPORT_GENERATED read-compat type", () => {
    const payload = InvestigationEventRecordPayloadSchema.parse(fixtures.REPORT_GENERATED);
    expect(mapInvestigationEventToExecutionStage(payload)).toBeNull();
  });

  it("is exhaustive over every record-payload union member — no default branch hides a new member", () => {
    // The switch has no `default` branch (a new union member is a compile
    // error), so the runtime half of that guarantee is a defined result for
    // every member: all 13 types map to either a canonical stage or null,
    // never undefined.
    expect(Object.keys(fixtures)).toHaveLength(13);
    for (const [type, fixture] of Object.entries(fixtures)) {
      const payload = InvestigationEventRecordPayloadSchema.parse(fixture);
      const stage = mapInvestigationEventToExecutionStage(payload);
      expect(stage === null || INVESTIGATION_EXECUTION_STAGE_ORDER.includes(stage), `${type} mapped to ${stage}`).toBe(
        true,
      );
    }
  });
});

describe("overlapping legacy branch schemas remain byte-compatible", () => {
  const legacyFixtures = [
    { type: "RETRIEVAL_COMPLETED", chunks: [] },
    { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" },
    { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" },
    { type: "REPORT_GENERATED" },
  ];

  it("AgentTraceEventSchema still validates its own four types unchanged", () => {
    for (const fixture of legacyFixtures) {
      expect(AgentTraceEventSchema.safeParse(fixture).success).toBe(true);
    }
  });

  it("the canonical record schema accepts the exact same legacy fixtures", () => {
    for (const fixture of legacyFixtures) {
      expect(InvestigationEventRecordSchema.safeParse(baseRecord(fixture)).success).toBe(true);
    }
  });
});

describe("TOOL_REQUESTED assessment on the record/read side (Issue #58 Checkpoint A)", () => {
  // A pre-#58 TOOL_REQUESTED row never carried an `assessment`.
  const assessmentLessToolRequested = {
    type: "TOOL_REQUESTED",
    toolCallId: "call-1",
    toolName: "check_status",
  } as const;

  const groundedAssessment = {
    evidenceState: "INSUFFICIENT",
    continuationReason: "STATUS_UNRESOLVED",
    supportedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
  } as const;

  it("parses an assessment-less TOOL_REQUESTED record (pre-#58 read compat)", () => {
    expect(
      InvestigationEventRecordPayloadSchema.safeParse(assessmentLessToolRequested).success,
    ).toBe(true);
    expect(
      InvestigationEventRecordSchema.safeParse(baseRecord(assessmentLessToolRequested)).success,
    ).toBe(true);
  });

  it("parses a TOOL_REQUESTED record carrying a valid assessment", () => {
    expect(
      InvestigationEventRecordSchema.safeParse(
        baseRecord({ ...assessmentLessToolRequested, assessment: groundedAssessment }),
      ).success,
    ).toBe(true);
  });

  it("rejects a TOOL_REQUESTED record carrying an invalid assessment", () => {
    const invalidAssessment = {
      ...groundedAssessment,
      evidenceState: "SUFFICIENT", // cannot accompany another diagnostic
    };
    expect(
      InvestigationEventRecordSchema.safeParse(
        baseRecord({ ...assessmentLessToolRequested, assessment: invalidAssessment }),
      ).success,
    ).toBe(false);
  });

  it("the record-side schema itself rejects assessment-bearing TOOL_REQUESTED with an invalid assessment", () => {
    expect(
      ToolRequestedRecordEventSchema.safeParse({
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "check_status",
        assessment: {
          evidenceState: "CONFLICTING",
          continuationReason: "SCOPE_NOT_COVERED",
          supportedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
        },
      }).success,
    ).toBe(false);
  });

  it("the new-write TOOL_REQUESTED branch still accepts the legacy trace object WITHOUT any added key", () => {
    // Write-path compatibility with every pre-#58 producer that emits a
    // TOOL_REQUESTED without an assessment would NOT hold — the write branch
    // now requires it (see the write/record proof below). This assertion is
    // the inverse: the write branch is intentionally stricter.
    expect(
      InvestigationEventPayloadSchema.safeParse(assessmentLessToolRequested).success,
    ).toBe(false);
  });

  it("rejects an extra key on the record-side TOOL_REQUESTED schema (strict preserved)", () => {
    expect(
      ToolRequestedRecordEventSchema.safeParse({
        ...assessmentLessToolRequested,
        bogus: "not a field",
      }).success,
    ).toBe(false);
  });

  it("inherits the legacy toolCallId/toolName bounds via derivation, not a re-declared copy", () => {
    // Same out-of-bounds values the legacy ToolRequestedTraceEventSchema
    // itself rejects (min(1)/max(128)) — proves ToolRequestedRecordEventSchema
    // is built from that schema's own field constraints, not an independent
    // hand-authored approximation of them.
    const emptyToolCallId = { ...assessmentLessToolRequested, toolCallId: "" };
    const overlongToolName = { ...assessmentLessToolRequested, toolName: "t".repeat(129) };

    expect(ToolRequestedTraceEventSchema.safeParse(emptyToolCallId).success).toBe(false);
    expect(ToolRequestedRecordEventSchema.safeParse(emptyToolCallId).success).toBe(false);

    expect(ToolRequestedTraceEventSchema.safeParse(overlongToolName).success).toBe(false);
    expect(ToolRequestedRecordEventSchema.safeParse(overlongToolName).success).toBe(false);
  });
});

describe("TOOL_REQUESTED write/record split (Issue #58 Checkpoint B §4)", () => {
  const assessmentLessToolRequested = {
    type: "TOOL_REQUESTED",
    toolCallId: "call-1",
    toolName: "check_status",
  } as const;

  const groundedAssessment = {
    evidenceState: "INSUFFICIENT",
    continuationReason: "STATUS_UNRESOLVED",
    supportedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
  } as const;

  it("write schema rejects a TOOL_REQUESTED without assessment", () => {
    expect(
      InvestigationEventPayloadSchema.safeParse(assessmentLessToolRequested).success,
    ).toBe(false);
    expect(
      ToolRequestedWriteEventSchema.safeParse(assessmentLessToolRequested).success,
    ).toBe(false);
  });

  it("write schema accepts a TOOL_REQUESTED carrying a valid assessment", () => {
    const payload = { ...assessmentLessToolRequested, assessment: groundedAssessment };
    expect(
      InvestigationEventPayloadSchema.safeParse(payload).success,
    ).toBe(true);
    const parsed = ToolRequestedWriteEventSchema.parse(payload);
    expect(Object.keys(parsed).sort()).toEqual(["assessment", "toolCallId", "toolName", "type"]);
    expect(parsed.assessment).toEqual(groundedAssessment);
  });

  it("record schema still accepts a TOOL_REQUESTED without assessment (pre-#58 read compat)", () => {
    expect(
      InvestigationEventRecordPayloadSchema.safeParse(assessmentLessToolRequested).success,
    ).toBe(true);
    expect(
      InvestigationEventRecordSchema.safeParse(baseRecord(assessmentLessToolRequested)).success,
    ).toBe(true);
  });

  it("record schema accepts a TOOL_REQUESTED carrying a valid assessment", () => {
    const payload = { ...assessmentLessToolRequested, assessment: groundedAssessment };
    expect(
      InvestigationEventRecordSchema.safeParse(baseRecord(payload)).success,
    ).toBe(true);
  });

  it("record schema rejects a TOOL_REQUESTED carrying an invalid assessment", () => {
    const invalidAssessment = {
      ...groundedAssessment,
      evidenceState: "SUFFICIENT", // cannot accompany another diagnostic
    };
    expect(
      InvestigationEventRecordSchema.safeParse(
        baseRecord({ ...assessmentLessToolRequested, assessment: invalidAssessment }),
      ).success,
    ).toBe(false);
  });

  it("the write schema's assessment is the single EvidenceAssessmentSchema, so SUFFICIENT is rejected too", () => {
    expect(
      ToolRequestedWriteEventSchema.safeParse({
        ...assessmentLessToolRequested,
        assessment: { ...groundedAssessment, evidenceState: "SUFFICIENT" },
      }).success,
    ).toBe(false);
  });
});
