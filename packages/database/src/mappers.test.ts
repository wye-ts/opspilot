import { describe, expect, it } from "vitest";

import { PersistenceError } from "./errors";
import {
  buildApprovalView,
  buildOutcome,
  fromAgentJobRow,
  fromAgentRunApprovalRow,
  fromAgentRunRow,
  fromFailureCodeRead,
  fromInvestigationEventRows,
  fromReportRead,
  fromTicketContextRead,
  fromTraceEventRows,
  toFailureCodeWrite,
  toInvestigationEventCreateInput,
  toRecordApprovalDecisionWrite,
  toReportWrite,
  toTicketContextWrite,
} from "./mappers";

const RUN_ID = "8f14e45f-1234-4abc-8def-000000000099";
const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");

const VALID_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "Finding" }],
  suggestedActions: [],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint B: the new-write contract requires
  // recommendationDisposition. Zero suggested actions => ADVISORY.
  recommendationDisposition: "ADVISORY",
};

// A modern new-write report carrying the full #60 contract: an ACTIONABLE
// disposition and a suggested action whose groundedBy cites an evidence
// locator present in the same report (Issue #60 Checkpoint B §4).
const MODERN_ACTIONABLE_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Update the customer with the diagnostic outcome.",
  confidence: 0.8,
  evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "Finding" }],
  suggestedActions: [
    {
      type: "DRAFT_CUSTOMER_REPLY",
      payload: { subject: "Update", body: "A human will follow up." },
      groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
    },
  ],
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ACTIONABLE",
};

// A #58-era stored report: evidenceState present, recommendationDisposition
// ABSENT, and a suggested action WITHOUT groundedBy (Issue #60 Checkpoint B
// §4, G1). Reads must succeed with groundedBy normalized to [] and the
// disposition left undefined — never invented from prose.
const LEGACY_ACTIONS_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "Finding" }],
  evidenceState: "SUFFICIENT",
  suggestedActions: [
    { type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "A human will follow up." } },
  ],
};

// A pre-#58 stored report: no evidenceState, always non-null rootCause and
// >= 1 evidence entry. Must keep reading under the fail-closed legacy branch.
const LEGACY_REPORT = {
  category: "SERVICE_DEGRADATION",
  summary: "Summary",
  rootCause: "Root cause",
  customerImpact: "Impact",
  recommendedResolution: "Resolution",
  confidence: 0.8,
  evidence: [{ evidenceId: "chunk-1", sourceType: "RAG_CHUNK", finding: "Finding" }],
  suggestedActions: [],
};

describe("toTicketContextWrite / fromTicketContextRead", () => {
  it("round-trips a valid ticket context and derives externalTicketId", () => {
    const { ticketContext, externalTicketId } = toTicketContextWrite({
      ticketId: "TKT-1",
      summary: "Summary of the reported problem",
    });
    expect(ticketContext).toEqual({ ticketId: "TKT-1", summary: "Summary of the reported problem" });
    expect(externalTicketId).toBe("TKT-1");
    expect(fromTicketContextRead(ticketContext)).toEqual(ticketContext);
  });

  it("normalizes on write: the stored value is the trimmed one", () => {
    const { ticketContext, externalTicketId } = toTicketContextWrite({
      ticketId: "  TKT-1  ",
      summary: "  Summary of the reported problem  ",
    });

    expect(ticketContext).toEqual({ ticketId: "TKT-1", summary: "Summary of the reported problem" });
    // externalTicketId is derived from the NORMALIZED ticketId, so the
    // generated column and the JSONB snapshot cannot disagree.
    expect(externalTicketId).toBe("TKT-1");
  });

  it("rejects a write whose trimmed summary is shorter than 15 characters", () => {
    expect(() => toTicketContextWrite({ ticketId: "TKT-1", summary: "too short" })).toThrow(
      PersistenceError,
    );
  });

  // The read path is looser than the write path on purpose: a row persisted
  // before the 15-character floor existed must stay readable rather than
  // becoming a 500. See StoredTicketContextSchema in @opspilot/contracts.
  it("reads back a stored row that the write path would now reject", () => {
    const legacyRow = { ticketId: "TKT-legacy", summary: "s" };

    expect(fromTicketContextRead(legacyRow)).toEqual(legacyRow);
    expect(() => toTicketContextWrite(legacyRow)).toThrow(PersistenceError);
  });

  it("returns a stored row verbatim rather than re-normalizing it on read", () => {
    const untrimmedRow = { ticketId: " TKT-1 ", summary: " padded stored summary " };

    expect(fromTicketContextRead(untrimmedRow)).toEqual(untrimmedRow);
  });

  it("throws PERSISTENCE_VALIDATION_FAILED with a fixed message for an invalid ticket context", () => {
    let caught: unknown;
    try {
      toTicketContextWrite({ summary: "no ticketId" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_VALIDATION_FAILED");
    expect((caught as PersistenceError).message).toBe("Ticket context failed contract validation.");
  });

  it("never leaks the raw invalid value or Zod issue text into the thrown message", () => {
    let caught: unknown;
    try {
      toTicketContextWrite({ ticketId: "leaked-secret-value", extra: "unexpected" });
    } catch (error) {
      caught = error;
    }
    expect((caught as PersistenceError).message).not.toContain("leaked-secret-value");
    expect((caught as PersistenceError).message).not.toContain("unexpected");
  });
});

describe("fromAgentJobRow", () => {
  it("maps a Prisma row into an AgentJobRecord", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const record = fromAgentJobRow({
      id: "job-1",
      ticketContext: { ticketId: "TKT-1", summary: "Summary" },
      externalTicketId: "TKT-1",
      createdAt,
    });
    expect(record).toEqual({
      id: "job-1",
      ticketContext: { ticketId: "TKT-1", summary: "Summary" },
      externalTicketId: "TKT-1",
      createdAt: createdAt.toISOString(),
    });
  });
});

describe("fromAgentRunRow", () => {
  it("maps a Prisma row into an AgentRunRecord", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const record = fromAgentRunRow({
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt,
      finishedAt: null,
      createdAt: startedAt,
    });
    expect(record.status).toBe("RUNNING");
    expect(record.startedAt).toBe(startedAt.toISOString());
    expect(record.finishedAt).toBeNull();
  });

  /**
   * The uncertainty flag has to reach the read model, or the API's DTO mapper has
   * no way to tell a complete cost from a lower bound and will publish both.
   */
  describe("possibleUnobservedCost", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
      startedAt,
      finishedAt: startedAt,
      createdAt: startedAt,
      estimatedCostNanoUsd: 17_956_000n,
      possibleUnobservedCost: false,
      ...overrides,
    });

    it("carries a false flag through unchanged", () => {
      expect(fromAgentRunRow(row()).possibleUnobservedCost).toBe(false);
    });

    it("carries a true flag through unchanged, alongside the observed lower bound", () => {
      const record = fromAgentRunRow(row({ possibleUnobservedCost: true }));

      expect(record.possibleUnobservedCost).toBe(true);
      // The bound is still returned — it is kept for audit, not discarded.
      expect(record.estimatedCostNanoUsd).toBe(17_956_000n);
    });

    it.each([
      ["a NULL column", { possibleUnobservedCost: null }],
      ["an absent property", {}],
    ])("fails closed for %s", (_label, overrides) => {
      // No recorded usage means no basis for vouching for a figure. Both of these
      // rows also have a null cost, so nothing is displayed either way — but the
      // reading that cannot mislead is the one to encode.
      const base = row({ estimatedCostNanoUsd: null });
      if (!("possibleUnobservedCost" in overrides)) delete (base as Record<string, unknown>).possibleUnobservedCost;

      expect(fromAgentRunRow({ ...base, ...overrides }).possibleUnobservedCost).toBe(true);
    });
  });
});

describe("fromTraceEventRows — legacy read path", () => {
  const trace = [
    { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" },
    { type: "TOOL_COMPLETED" as const, toolCallId: "call-1", toolName: "get_service_status" },
    { type: "REPORT_GENERATED" as const },
  ];

  it("revalidates and preserves order when reading rows back", () => {
    const rows = trace.map((payload, i) => ({ sequenceNumber: i + 1, payload, createdAt: RECORDED_AT }));
    expect(fromTraceEventRows(RUN_ID, rows)).toEqual(trace);
  });
});

describe("toInvestigationEventCreateInput", () => {
  it("accepts a canonical write-eligible payload and derives eventType from it", () => {
    const input = toInvestigationEventCreateInput(RUN_ID, 1, { type: "RUN_CREATED" });
    expect(input).toEqual({
      runId: RUN_ID,
      sequenceNumber: 1,
      eventType: "RUN_CREATED",
      payload: { type: "RUN_CREATED" },
    });
  });

  it("accepts every one of the 12 canonical write-eligible types", () => {
    const payloads: unknown[] = [
      { type: "RUN_CREATED" },
      { type: "AGENT_STARTED" },
      { type: "RETRIEVAL_COMPLETED", chunks: [] },
      // Issue #58 Checkpoint B (§4): a fresh canonical TOOL_REQUESTED write
      // must carry a validated assessment (NO_EVIDENCE_YET — no evidence has
      // run before this run's first diagnostic request).
      {
        type: "TOOL_REQUESTED",
        toolCallId: "call-1",
        toolName: "get_service_status",
        assessment: { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET", supportedBy: [] },
      },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_FAILED", toolCallId: "call-1", toolName: "get_service_status", failureCode: "TOOL_NOT_FOUND" },
      { type: "REPORT_GENERATION_STARTED" },
      { type: "REPORT_SUBMITTED" },
      { type: "REPORT_VALIDATED" },
      { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" },
      { type: "RUN_COMPLETED" },
      { type: "RUN_FAILED", failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" },
    ];
    for (const [index, payload] of payloads.entries()) {
      expect(() => toInvestigationEventCreateInput(RUN_ID, index + 1, payload)).not.toThrow();
    }
  });

  // The legacy read-only type must never be constructible as a fresh
  // canonical write — InvestigationEventPayloadSchema structurally excludes
  // it, and this is the boundary that enforces that exclusion for writers.
  it("rejects the legacy REPORT_GENERATED type", () => {
    expect(() => toInvestigationEventCreateInput(RUN_ID, 1, { type: "REPORT_GENERATED" })).toThrow(
      PersistenceError,
    );
  });

  it("rejects unknown fields on an otherwise-valid payload", () => {
    expect(() =>
      toInvestigationEventCreateInput(RUN_ID, 1, { type: "RUN_CREATED", extra: "unexpected" }),
    ).toThrow(PersistenceError);
  });

  it("rejects an unrecognized type", () => {
    expect(() => toInvestigationEventCreateInput(RUN_ID, 1, { type: "NOT_A_REAL_EVENT" })).toThrow(
      PersistenceError,
    );
  });

  // No field on the create-input shape can carry an application-generated
  // recordedAt or a clientRequestId — asserted structurally rather than by
  // omission, so a future field addition would have to break this test.
  it("produces a create input with exactly runId/sequenceNumber/eventType/payload keys", () => {
    const input = toInvestigationEventCreateInput(RUN_ID, 1, { type: "AGENT_STARTED" });
    expect(Object.keys(input).sort()).toEqual(["eventType", "payload", "runId", "sequenceNumber"]);
  });
});

describe("fromInvestigationEventRows", () => {
  it("sources recordedAt from the row's own createdAt, never a fresh clock read", () => {
    const [record] = fromInvestigationEventRows(RUN_ID, [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
    ]);
    expect(record?.recordedAt).toBe(RECORDED_AT.toISOString());
    expect(record?.runId).toBe(RUN_ID);
    expect(record?.sequence).toBe(1);
  });

  it("preserves order across a multi-event canonical prefix", () => {
    const rows = [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
    ];
    const records = fromInvestigationEventRows(RUN_ID, rows);
    expect(records.map((r) => r.payload.type)).toEqual(["RUN_CREATED", "AGENT_STARTED"]);
  });

  it("rejects a sequence starting anywhere other than 1", () => {
    expect(() =>
      fromInvestigationEventRows(RUN_ID, [
        { sequenceNumber: 2, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      ]),
    ).toThrow(PersistenceError);
  });

  it("rejects a gap in the sequence", () => {
    expect(() =>
      fromInvestigationEventRows(RUN_ID, [
        { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
        { sequenceNumber: 3, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
      ]),
    ).toThrow(PersistenceError);
  });

  it("rejects a duplicated sequence number", () => {
    expect(() =>
      fromInvestigationEventRows(RUN_ID, [
        { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
        { sequenceNumber: 1, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
      ]),
    ).toThrow(PersistenceError);
  });

  it("rejects an out-of-order (descending) sequence", () => {
    expect(() =>
      fromInvestigationEventRows(RUN_ID, [
        { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
        { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      ]),
    ).toThrow(PersistenceError);
  });

  it("rejects a malformed row whose payload fails schema validation", () => {
    expect(() =>
      fromInvestigationEventRows(RUN_ID, [
        { sequenceNumber: 1, payload: { type: "TOOL_REQUESTED" }, createdAt: RECORDED_AT }, // missing toolCallId/toolName
      ]),
    ).toThrow(PersistenceError);
  });
});

describe("fromTraceEventRows — dual read mode", () => {
  const legacyRows = [
    { sequenceNumber: 1, payload: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }, createdAt: RECORDED_AT },
    { sequenceNumber: 2, payload: { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" }, createdAt: RECORDED_AT },
    { sequenceNumber: 3, payload: { type: "REPORT_GENERATED" }, createdAt: RECORDED_AT },
  ];

  it("historical legacy rows (no RUN_CREATED-at-1 marker) return unchanged", () => {
    expect(fromTraceEventRows(RUN_ID, legacyRows)).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  it("an empty row set returns an empty trace", () => {
    expect(fromTraceEventRows(RUN_ID, [])).toEqual([]);
  });

  it("a canonical direct no-tool success path projects REPORT_VALIDATED as REPORT_GENERATED", () => {
    const rows = [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 3, payload: { type: "REPORT_SUBMITTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 4, payload: { type: "REPORT_VALIDATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 5, payload: { type: "RUN_COMPLETED" }, createdAt: RECORDED_AT },
    ];
    expect(fromTraceEventRows(RUN_ID, rows)).toEqual([{ type: "REPORT_GENERATED" }]);
  });

  it("a canonical one-tool success path projects the legacy-compatible subset, in sequence", () => {
    const rows = [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 3, payload: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }, createdAt: RECORDED_AT },
      { sequenceNumber: 4, payload: { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" }, createdAt: RECORDED_AT },
      { sequenceNumber: 5, payload: { type: "REPORT_GENERATION_STARTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 6, payload: { type: "REPORT_SUBMITTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 7, payload: { type: "REPORT_VALIDATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 8, payload: { type: "RUN_COMPLETED" }, createdAt: RECORDED_AT },
    ];
    expect(fromTraceEventRows(RUN_ID, rows)).toEqual([
      { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ]);
  });

  // The one deliberate content divergence from pre-#37 behavior
  // (docs/reviews/21-...md §7): canonical persistence records TOOL_REQUESTED
  // before registry lookup/input validation, so the projected legacy trace
  // for these two failure codes now truthfully includes it — while
  // TOOL_FAILED itself stays hidden (projects to null), matching
  // TraceTimeline's existing exhaustive switch.
  it.each(["TOOL_NOT_FOUND", "TOOL_INPUT_INVALID"] as const)(
    "a canonical %s stream projects TOOL_REQUESTED but not TOOL_FAILED",
    (failureCode) => {
      const rows = [
        { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
        { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
        { sequenceNumber: 3, payload: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "unknown_tool" }, createdAt: RECORDED_AT },
        { sequenceNumber: 4, payload: { type: "TOOL_FAILED", toolCallId: "call-1", toolName: "unknown_tool", failureCode }, createdAt: RECORDED_AT },
        { sequenceNumber: 5, payload: { type: "RUN_FAILED", failureCode, failedStage: "DIAGNOSTIC_EXECUTION" }, createdAt: RECORDED_AT },
      ];
      const projected = fromTraceEventRows(RUN_ID, rows);
      expect(projected).toEqual([{ type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "unknown_tool" }]);
      expect(projected.some((event) => (event as { type: string }).type === "TOOL_FAILED")).toBe(false);
    },
  );

  it("every projected output remains a valid AgentTraceEvent[] (no lifecycle-only event leaks through)", () => {
    const rows = [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 2, payload: { type: "AGENT_STARTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 3, payload: { type: "REPORT_SUBMITTED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 4, payload: { type: "REPORT_VALIDATED" }, createdAt: RECORDED_AT },
      { sequenceNumber: 5, payload: { type: "RUN_COMPLETED" }, createdAt: RECORDED_AT },
    ];
    const projected = fromTraceEventRows(RUN_ID, rows);
    const allowedTypes = new Set(["RETRIEVAL_COMPLETED", "TOOL_REQUESTED", "TOOL_COMPLETED", "REPORT_GENERATED"]);
    for (const event of projected) {
      expect(allowedTypes.has(event.type)).toBe(true);
    }
  });

  // Raw sequence contiguity is checked on the STORED rows before any
  // projection runs, so a corrupt canonical stream cannot be masked by
  // lifecycle-only events happening to be the ones missing.
  it("checks raw canonical sequence contiguity before dropping any null-projected events", () => {
    const rows = [
      { sequenceNumber: 1, payload: { type: "RUN_CREATED" }, createdAt: RECORDED_AT },
      // gap at 2 — AGENT_STARTED (a lifecycle-only event that projects to
      // null anyway) is simply missing; contiguity must still be enforced.
      { sequenceNumber: 3, payload: { type: "REPORT_SUBMITTED" }, createdAt: RECORDED_AT },
    ];
    expect(() => fromTraceEventRows(RUN_ID, rows)).toThrow(PersistenceError);
  });
});

describe("toReportWrite / fromReportRead", () => {
  it("round-trips a valid report", () => {
    const report = toReportWrite(VALID_REPORT);
    expect(fromReportRead(report)).toEqual(report);
  });

  it("rejects an invalid report", () => {
    expect(() => toReportWrite({ summary: "missing required fields" })).toThrow(PersistenceError);
  });

  it("fromReportRead keeps reading a pre-#58 legacy report (no evidenceState)", () => {
    expect(fromReportRead(LEGACY_REPORT)).toEqual(LEGACY_REPORT);
  });

  it("fromReportRead fails closed on a corrupt legacy report (rootCause null)", () => {
    expect(() => fromReportRead({ ...LEGACY_REPORT, rootCause: null })).toThrow(PersistenceError);
  });

  it("fromReportRead fails closed on a corrupt legacy report (empty evidence)", () => {
    expect(() => fromReportRead({ ...LEGACY_REPORT, evidence: [] })).toThrow(PersistenceError);
  });

  // Issue #60 Checkpoint B (§4): a valid modern report carrying the full #60
  // contract survives toReportWrite -> stored JSON -> fromReportRead without
  // loss or invention.
  it("round-trips a modern report carrying recommendationDisposition and a grounded action, preserving every field exactly", () => {
    const written = toReportWrite(MODERN_ACTIONABLE_REPORT);
    // Simulate the jsonb round trip: plain JSON, then read back.
    const storedJson = JSON.parse(JSON.stringify(written)) as unknown;
    const read = fromReportRead(storedJson);

    expect(read).toEqual(written);
    expect(read.recommendationDisposition).toBe("ACTIONABLE");
    expect(read.suggestedActions).toHaveLength(1);
    expect(read.suggestedActions[0]?.type).toBe("DRAFT_CUSTOMER_REPLY");
    expect(read.suggestedActions[0]?.payload).toEqual({ subject: "Update", body: "A human will follow up." });
    expect(read.suggestedActions[0]?.groundedBy).toEqual([
      { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
    ]);
  });

  // G1 — #58-era legacy compatibility: no recommendationDisposition marker and
  // an action without groundedBy must read back successfully, normalizing
  // groundedBy to [] and leaving the disposition undefined (never invented
  // from prose).
  it("G1 — a #58-era report with an action lacking groundedBy reads back normalized (groundedBy [], disposition undefined)", () => {
    const read = fromReportRead(LEGACY_ACTIONS_REPORT);

    expect(read.recommendationDisposition).toBeUndefined();
    expect(read.suggestedActions[0]?.type).toBe("DRAFT_CUSTOMER_REPLY");
    expect(read.suggestedActions[0]?.groundedBy).toEqual([]);
  });

  // G1b — a #58-era row (marker absent) with EXPLICIT non-empty corrupt
  // grounding must still fail closed: duplicate/subset checks run for every
  // parsed action regardless of the #60 marker.
  it.each([
    [
      "a duplicate locator",
      [
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
      ],
    ],
    ["a locator absent from report.evidence", [{ evidenceId: "call-999", sourceType: "TOOL_EXECUTION" }]],
  ])("G1b — a #58-era report with explicit non-empty corrupt grounding (%s) rejects on fromReportRead", (_label, groundedBy) => {
    const corrupt = {
      ...LEGACY_ACTIONS_REPORT,
      suggestedActions: [
        { type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "A human will follow up." }, groundedBy },
      ],
    };
    expect(() => fromReportRead(corrupt)).toThrow(PersistenceError);
  });

  // G2 — #60-era corrupt modern row: recommendationDisposition present,
  // evidenceState present, action groundedBy absent/[] — structural
  // normalization to [] must NOT let it pass; the report-level non-empty
  // grounding rule rejects.
  it("G2 — a #60-era report with an ungrounded action rejects on fromReportRead", () => {
    const corrupt = {
      ...LEGACY_ACTIONS_REPORT,
      recommendationDisposition: "ACTIONABLE",
    };
    expect(() => fromReportRead(corrupt)).toThrow(PersistenceError);
  });

  // G3 — impossible hybrid: recommendationDisposition present + evidenceState
  // absent must reject UNCONDITIONALLY. The strong fixture is ADVISORY + []
  // with otherwise legacy-valid rootCause/evidence — every other #60/#58 rule
  // is satisfied, so the marker-combination invariant alone causes rejection.
  it("G3 — a report with recommendationDisposition present but evidenceState absent rejects unconditionally on fromReportRead", () => {
    const hybrid = {
      ...LEGACY_REPORT,
      recommendationDisposition: "ADVISORY",
    };
    expect(() => fromReportRead(hybrid)).toThrow(PersistenceError);
  });
});

describe("toFailureCodeWrite / fromFailureCodeRead", () => {
  it("round-trips a valid failure code", () => {
    expect(toFailureCodeWrite("TOOL_NOT_FOUND")).toBe("TOOL_NOT_FOUND");
    expect(fromFailureCodeRead("TOOL_NOT_FOUND")).toBe("TOOL_NOT_FOUND");
  });

  it("rejects an unknown failure code", () => {
    expect(() => toFailureCodeWrite("NOT_A_REAL_CODE")).toThrow(PersistenceError);
  });
});

describe("buildOutcome", () => {
  it("builds a RUNNING outcome", () => {
    expect(buildOutcome({ status: "RUNNING", report: null, failureCode: null })).toEqual({ type: "RUNNING" });
  });

  it("builds a COMPLETED outcome with the report", () => {
    expect(buildOutcome({ status: "COMPLETED", report: VALID_REPORT, failureCode: null })).toEqual({
      type: "COMPLETED",
      report: VALID_REPORT,
    });
  });

  it("builds a FAILED outcome with the fixed display message for the code", () => {
    const outcome = buildOutcome({ status: "FAILED", report: null, failureCode: "TOOL_NOT_FOUND" });
    expect(outcome).toEqual({
      type: "FAILED",
      code: "TOOL_NOT_FOUND",
      message: "The requested diagnostic tool is not registered.",
    });
  });
});

describe("toRecordApprovalDecisionWrite", () => {
  it("parses a well-formed input and returns a matching AgentRunApprovalWrite", () => {
    const write = toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky" });
    expect(write.decision).toBe("APPROVED");
    expect(write.reviewerName).toBe("jacky");
  });

  it("rejects an unknown key", () => {
    expect(() =>
      toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky", extra: 1 }),
    ).toThrow(PersistenceError);
  });

  it("converts an absent note (undefined) to null — the one normalization point in this design", () => {
    const write = toRecordApprovalDecisionWrite({ decision: "APPROVED", reviewerName: "jacky" });
    expect(write.note).toBeNull();
  });

  it("preserves a present, already-trimmed note unchanged", () => {
    const write = toRecordApprovalDecisionWrite({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "Looks correct.",
    });
    expect(write.note).toBe("Looks correct.");
  });

  it("trims a present note with surrounding whitespace", () => {
    const write = toRecordApprovalDecisionWrite({
      decision: "APPROVED",
      reviewerName: "jacky",
      note: "  Looks correct.  ",
    });
    expect(write.note).toBe("Looks correct.");
  });

  it("throws PersistenceError for a non-object input", () => {
    expect(() => toRecordApprovalDecisionWrite(null)).toThrow(PersistenceError);
    expect(() => toRecordApprovalDecisionWrite("not an object")).toThrow(PersistenceError);
    expect(() => toRecordApprovalDecisionWrite([])).toThrow(PersistenceError);
  });

  it("throws PERSISTENCE_VALIDATION_FAILED with a fixed message, never leaking raw input", () => {
    let caught: unknown;
    try {
      toRecordApprovalDecisionWrite({ decision: "MAYBE", reviewerName: "leaked-secret-value" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe("PERSISTENCE_VALIDATION_FAILED");
    expect((caught as PersistenceError).message).not.toContain("leaked-secret-value");
  });
});

describe("fromAgentRunApprovalRow", () => {
  const decidedAt = new Date("2026-01-01T00:00:00.000Z");
  const validRow = {
    id: "8f14e45f-1234-4abc-8def-000000000000",
    runId: "8f14e45f-1234-4abc-8def-000000000001",
    decision: "APPROVED",
    reviewerName: "jacky",
    note: "Looks correct.",
    decidedAt,
  };

  it("maps a well-formed stored row to AgentRunApprovalRecord", () => {
    expect(fromAgentRunApprovalRow(validRow)).toEqual(validRow);
  });

  it("accepts a null note", () => {
    expect(fromAgentRunApprovalRow({ ...validRow, note: null }).note).toBeNull();
  });

  it("throws for an invalid id (not a UUID)", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, id: "not-a-uuid" })).toThrow(PersistenceError);
  });

  it("throws for an invalid runId (not a UUID)", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, runId: "not-a-uuid" })).toThrow(PersistenceError);
  });

  it("throws for an invalid decision", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, decision: "MAYBE" })).toThrow(PersistenceError);
  });

  it("throws for a blank reviewerName", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: "" })).toThrow(PersistenceError);
  });

  it("throws for reviewerName exceeding 100 characters", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: "a".repeat(101) })).toThrow(
      PersistenceError,
    );
  });

  it("throws for reviewerName with leading/trailing whitespace — must reject, not silently trim", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, reviewerName: " jacky " })).toThrow(PersistenceError);
  });

  it("does NOT throw for internal (non-leading/trailing) whitespace in reviewerName", () => {
    expect(fromAgentRunApprovalRow({ ...validRow, reviewerName: "jacky smith" }).reviewerName).toBe(
      "jacky smith",
    );
  });

  it("throws for a blank non-null note", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: "" })).toThrow(PersistenceError);
  });

  it("throws for note exceeding 1000 characters", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: "a".repeat(1001) })).toThrow(PersistenceError);
  });

  it("throws for note with leading/trailing whitespace", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, note: " note " })).toThrow(PersistenceError);
  });

  it("throws for a non-Date decidedAt", () => {
    expect(() =>
      fromAgentRunApprovalRow({ ...validRow, decidedAt: "2026-01-01T00:00:00.000Z" as unknown as Date }),
    ).toThrow(PersistenceError);
  });

  it("throws for an unknown stored key", () => {
    expect(() => fromAgentRunApprovalRow({ ...validRow, extra: "unexpected" } as never)).toThrow(
      PersistenceError,
    );
  });
});

describe("buildApprovalView", () => {
  const record = {
    id: "8f14e45f-1234-4abc-8def-000000000000",
    runId: "8f14e45f-1234-4abc-8def-000000000001",
    decision: "APPROVED" as const,
    reviewerName: "jacky",
    note: null,
    decidedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("returns PENDING when eligible and no record exists", () => {
    expect(buildApprovalView("run-1", true, null)).toEqual({
      runId: "run-1",
      status: "PENDING",
      reviewerName: null,
      note: null,
      decidedAt: null,
    });
  });

  it("returns NOT_ELIGIBLE when not eligible and no record exists", () => {
    expect(buildApprovalView("run-1", false, null)).toEqual({
      runId: "run-1",
      status: "NOT_ELIGIBLE",
      reviewerName: null,
      note: null,
      decidedAt: null,
    });
  });

  it("returns the record's decision as status when a record is present", () => {
    expect(buildApprovalView("run-1", true, record)).toEqual({
      runId: "run-1",
      status: "APPROVED",
      reviewerName: "jacky",
      note: null,
      decidedAt: record.decidedAt,
    });
  });
});
