import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
import {
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  type EvidenceLocator,
} from "@opspilot/contracts";
import {
  CASE_ID_PATTERN,
  MAX_CASE_ID_LENGTH,
  resolveCorpus,
  validateEvaluationDataset,
} from "./dataset-validation";
import type { CorpusProfile, EvaluationCase, ToolProfile } from "./types";

const FIXTURE_CORPUS: readonly StoredRunbookChunk[] = [
  { chunkId: "fixture-chunk-1", runbookId: "fixture-runbook", title: "Fixture One", content: "fixture content one" },
  { chunkId: "fixture-chunk-2", runbookId: "fixture-runbook", title: "Fixture Two", content: "fixture content two" },
];

const FIXTURE_INJECTION_PROBE_CHUNK: StoredRunbookChunk = {
  chunkId: "fixture-injection-probe",
  runbookId: "fixture-runbook",
  title: "Fixture Injection Probe",
  content: "fixture probe content",
};

function baseCase(overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  return {
    id: "base-case",
    description: "base fixture case",
    ticketContext: { ticketId: "T-1", summary: "summary" },
    retrievalQuery: "fixture",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: { id: "base-case", turns: [] },
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "fixture-chunk-1" },
    },
    ...overrides,
  };
}

function validate(cases: readonly EvaluationCase[]): readonly string[] {
  return validateEvaluationDataset({
    cases,
    defaultCorpus: FIXTURE_CORPUS,
    injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
  });
}

describe("resolveCorpus", () => {
  it("resolves the default profile to the default corpus", () => {
    expect(resolveCorpus("default", FIXTURE_CORPUS, FIXTURE_INJECTION_PROBE_CHUNK)).toBe(FIXTURE_CORPUS);
  });

  it("resolves the injection-probe profile to exactly the probe chunk", () => {
    expect(resolveCorpus("injection-probe", FIXTURE_CORPUS, FIXTURE_INJECTION_PROBE_CHUNK)).toEqual([
      FIXTURE_INJECTION_PROBE_CHUNK,
    ]);
  });
});

describe("validateEvaluationDataset", () => {
  it("accepts a single well-formed case with zero errors", () => {
    expect(validate([baseCase()])).toEqual([]);
  });

  it("rejects an empty dataset", () => {
    expect(validate([])).toEqual(["Evaluation dataset must contain at least one case."]);
  });

  describe("case-id format", () => {
    it("accepts a bounded lowercase-hyphen slug matching CASE_ID_PATTERN", () => {
      expect(CASE_ID_PATTERN.test("notification-service-degradation")).toBe(true);
      expect(validate([baseCase({ id: "a-valid-slug-id" })])).toEqual([]);
    });

    it("rejects a whitespace-only id with a fixed message that does not echo the value", () => {
      const messages = validate([baseCase({ id: "   " })]);
      expect(messages).toEqual(["Case 1: id is not a valid identifier."]);
    });

    it("rejects an id containing uppercase letters, without echoing the raw value", () => {
      const messages = validate([baseCase({ id: "Invalid-Case-Id" })]);
      expect(messages).toEqual(["Case 1: id is not a valid identifier."]);
      expect(messages.join(" ")).not.toContain("Invalid-Case-Id");
    });

    it("rejects an id containing invalid characters (e.g. underscores or spaces)", () => {
      expect(validate([baseCase({ id: "invalid_case id" })])).toEqual(["Case 1: id is not a valid identifier."]);
    });

    it("rejects an id exceeding MAX_CASE_ID_LENGTH, without echoing the raw value", () => {
      const overlong = "a".repeat(MAX_CASE_ID_LENGTH + 1);
      const messages = validate([baseCase({ id: overlong })]);
      expect(messages).toEqual(["Case 1: id is not a valid identifier."]);
      expect(messages.join(" ")).not.toContain(overlong);
    });

    it("accepts an id at exactly MAX_CASE_ID_LENGTH", () => {
      const exact = "a".repeat(MAX_CASE_ID_LENGTH);
      expect(validate([baseCase({ id: exact })])).toEqual([]);
    });
  });

  it("rejects duplicate case ids with a fixed message that does not echo the id", () => {
    const messages = validate([baseCase({ id: "dup" }), baseCase({ id: "dup" })]);
    expect(messages).toEqual(["Case 2: id duplicates an earlier case."]);
  });

  it("rejects a case declaring no behavioral expectation beyond runStatus", () => {
    const messages = validate([baseCase({ expectations: { runStatus: "completed" } })]);
    expect(messages.some((m) => m.includes("at least one behavioral expectation"))).toBe(true);
  });

  it("rejects runStatus 'failed' without a failure.expectedCode", () => {
    const messages = validate([
      baseCase({ expectations: { runStatus: "failed", retrieval: { expectedTop1: "fixture-chunk-1" } } }),
    ]);
    expect(messages.some((m) => m.includes("requires failure.expectedCode"))).toBe(true);
  });

  it("rejects runStatus 'completed' paired with a failure expectation", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          retrieval: { expectedTop1: "fixture-chunk-1" },
          failure: { expectedCode: "TOOL_NOT_FOUND" },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must not declare a failure expectation"))).toBe(true);
  });

  it("rejects a report payload expectation declared on a case whose runStatus is 'failed'", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "failed",
          failure: { expectedCode: "TOOL_NOT_FOUND" },
          report: { requiredEvidenceTypes: ["TOOL_EXECUTION"] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes('require runStatus "completed"'))).toBe(true);
  });

  it("does not reject a fabricated required evidence id merely because it is absent from the corpus/tool-execution set", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          report: { requiredEvidenceIds: ["totally-fabricated-id"] },
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  describe("stage-expectation / failure-code consistency guard", () => {
    it("rejects schemaExpectation 'INVALID' not paired with REPORT_SCHEMA_INVALID", () => {
      const messages = validate([
        baseCase({
          expectations: {
            runStatus: "failed",
            failure: { expectedCode: "TOOL_NOT_FOUND" },
            report: { schemaExpectation: "INVALID" },
          },
        }),
      ]);
      expect(messages.some((m) => m.includes('requires failure.expectedCode "REPORT_SCHEMA_INVALID"'))).toBe(
        true,
      );
    });

    it("rejects schemaExpectation 'VALID' paired with REPORT_SCHEMA_INVALID", () => {
      const messages = validate([
        baseCase({
          expectations: {
            runStatus: "failed",
            failure: { expectedCode: "REPORT_SCHEMA_INVALID" },
            report: { schemaExpectation: "VALID" },
          },
        }),
      ]);
      expect(
        messages.some((m) => m.includes('must not be paired with failure.expectedCode "REPORT_SCHEMA_INVALID"')),
      ).toBe(true);
    });

    it("rejects groundingExpectation 'INVALID' not paired with REPORT_EVIDENCE_INVALID", () => {
      const messages = validate([
        baseCase({
          expectations: {
            runStatus: "failed",
            failure: { expectedCode: "TOOL_NOT_FOUND" },
            report: { groundingExpectation: "INVALID" },
          },
        }),
      ]);
      expect(
        messages.some((m) => m.includes('requires failure.expectedCode "REPORT_EVIDENCE_INVALID"')),
      ).toBe(true);
    });

    it("rejects groundingExpectation 'VALID' paired with REPORT_EVIDENCE_INVALID", () => {
      const messages = validate([
        baseCase({
          expectations: {
            runStatus: "failed",
            failure: { expectedCode: "REPORT_EVIDENCE_INVALID" },
            report: { groundingExpectation: "VALID" },
          },
        }),
      ]);
      expect(
        messages.some((m) =>
          m.includes('must not be paired with failure.expectedCode "REPORT_EVIDENCE_INVALID"'),
        ),
      ).toBe(true);
    });
  });

  it("rejects expectedNoResults combined with expectedTop1", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          retrieval: { expectedNoResults: true, expectedTop1: "fixture-chunk-1" },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must not be combined with expectedTop1"))).toBe(true);
  });

  it("rejects an empty expectedInTopK array", () => {
    const messages = validate([
      baseCase({ expectations: { runStatus: "completed", retrieval: { expectedInTopK: [] } } }),
    ]);
    expect(messages.some((m) => m.includes("must be non-empty when present"))).toBe(true);
  });

  it("rejects a retrieval expectation referencing a chunkId outside the effective corpus, without echoing the id", () => {
    const messages = validate([
      baseCase({
        expectations: { runStatus: "completed", retrieval: { expectedTop1: "SENTINEL-nonexistent-chunk" } },
      }),
    ]);
    expect(messages.some((m) => m.includes("not present in the effective corpus"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL-nonexistent-chunk");
  });

  it("rejects forbiddenChunkIds overlapping an expected chunkId, without echoing the id", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          retrieval: { expectedTop1: "fixture-chunk-1", forbiddenChunkIds: ["fixture-chunk-1"] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("forbiddenChunkIds overlaps"))).toBe(true);
  });

  it("rejects a toolName appearing in both expectedExecuted and forbiddenExecutedToolNames, without echoing the name", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          tool: {
            expectedExecuted: [{ toolName: "SENTINEL_tool_name", input: {} }],
            forbiddenExecutedToolNames: ["SENTINEL_tool_name"],
          },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("reference the same tool name"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL_tool_name");
  });

  it("rejects a toolCallId appearing in both expectedCompleted and forbiddenCompletedToolCallIds, without echoing the id", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          tool: {
            expectedCompleted: [{ toolName: "get_service_status", toolCallId: "SENTINEL-call-id" }],
            forbiddenCompletedToolCallIds: ["SENTINEL-call-id"],
          },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("reference the same toolCallId"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL-call-id");
  });

  it("rejects an evidenceId appearing in both requiredEvidenceIds and forbiddenEvidenceIds, without echoing the id", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "completed",
          report: { requiredEvidenceIds: ["SENTINEL-evidence-id"], forbiddenEvidenceIds: ["SENTINEL-evidence-id"] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("reference the same evidence id"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL-evidence-id");
  });

  it("rejects an invalid corpusProfile literal, without echoing the raw value", () => {
    const messages = validate([baseCase({ corpusProfile: "SENTINEL-bogus-profile" as unknown as CorpusProfile })]);
    expect(messages.some((m) => m.includes("corpusProfile must be"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL-bogus-profile");
  });

  it("rejects an invalid toolProfile literal, without echoing the raw value", () => {
    const messages = validate([baseCase({ toolProfile: "SENTINEL-bogus-profile" as unknown as ToolProfile })]);
    expect(messages.some((m) => m.includes("toolProfile must be"))).toBe(true);
    expect(messages.join(" ")).not.toContain("SENTINEL-bogus-profile");
  });

  it("collects messages across every case rather than stopping at the first failure", () => {
    const messages = validate([
      baseCase({ id: "case-a", expectations: { runStatus: "completed" } }),
      baseCase({ id: "case-b", expectations: { runStatus: "failed" } }),
    ]);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Issue #59 Checkpoint B semantic expectation rules (§6)", () => {
  const TOOL_A: EvidenceLocator = { sourceType: "TOOL_EXECUTION", evidenceId: "tool-call-1" };
  const TOOL_B: EvidenceLocator = { sourceType: "TOOL_EXECUTION", evidenceId: "tool-call-2" };

  const completedWithRetrieval = {
    runStatus: "completed" as const,
    retrieval: { expectedTop1: "fixture-chunk-1" },
  };

  // Rule 1: 0 <= confidence.min <= confidence.max <= 1.
  it("rejects a confidence band where min > max", () => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedConfidence: { min: 0.9, max: 0.5 } },
      }),
    ]);
    expect(messages.some((m) => m.includes("must satisfy 0 <= min <= max <= 1"))).toBe(true);
  });

  it("rejects a confidence band outside [0, 1]", () => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedConfidence: { min: -0.1, max: 0.5 } },
      }),
    ]);
    expect(messages.some((m) => m.includes("must satisfy 0 <= min <= max <= 1"))).toBe(true);
  });

  it("accepts a well-formed confidence band", () => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedConfidence: { min: 0.3, max: 0.7 } },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 1 strictness: min/max must be finite numbers before any relational
  // comparison — JS coercion must never turn a boolean, numeric string, or
  // non-finite value into a valid band.
  it.each([
    ["min", false],
    ["min", true],
    ["min", "0.5"],
    ["max", false],
    ["max", true],
    ["max", "0.5"],
  ] as const)("rejects a non-number confidence %s of %s", (field, coercible) => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedConfidence: {
            ...(field === "min" ? { min: coercible as unknown as number, max: 0.5 } : { min: 0.5, max: coercible as unknown as number }),
          },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must be finite numbers"))).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects a non-finite confidence bound of %s",
    (nonFinite) => {
      const messages = validate([
        baseCase({
          expectations: {
            ...completedWithRetrieval,
            expectedConfidence: { min: nonFinite, max: 0.5 },
          },
        }),
      ]);
      expect(messages.some((m) => m.includes("must be finite numbers"))).toBe(true);
    },
  );

  it("rejects a confidence bound above 1", () => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedConfidence: { min: 0.5, max: 1.1 } },
      }),
    ]);
    expect(messages.some((m) => m.includes("must satisfy 0 <= min <= max <= 1"))).toBe(true);
  });

  // Confidence stays a continuous/fractional quantity: valid JSON integers
  // (0, 1) and fractions (0.25, 0.75) are all accepted.
  it.each([
    [0, 1],
    [1, 1],
    [0.25, 0.75],
    [0, 0],
    [0.75, 0.75],
  ] as const)("accepts confidence band min=%s max=%s", (min, max) => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedConfidence: { min, max } },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 2: expectedRootCause PRESENT → expectedEvidence.state SUFFICIENT.
  it("rejects expectedRootCause PRESENT paired with INSUFFICIENT evidence", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedRootCause: "PRESENT",
          expectedEvidence: { state: "INSUFFICIENT", requiredLocators: [] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("requires expectedEvidence with state SUFFICIENT"))).toBe(true);
  });

  it("accepts expectedRootCause PRESENT paired with SUFFICIENT evidence", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedRootCause: "PRESENT",
          expectedEvidence: { state: "SUFFICIENT", requiredLocators: [] },
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 3: every expectedAction.requiredGrounding is non-empty.
  it("rejects an expectedAction with empty requiredGrounding", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedActions: [{ type: "UPDATE_TICKET_STATUS", requiredGrounding: [], allowedGrounding: [TOOL_A] }],
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must declare a non-empty requiredGrounding"))).toBe(true);
  });

  // Rule 4: requiredGrounding ⊆ allowedGrounding.
  it("rejects requiredGrounding referencing a locator outside allowedGrounding", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedActions: [
            { type: "UPDATE_TICKET_STATUS", requiredGrounding: [TOOL_A], allowedGrounding: [TOOL_B] },
          ],
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must be a subset of its allowedGrounding"))).toBe(true);
  });

  it("accepts requiredGrounding fully contained in allowedGrounding", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedTelemetryEvidence: { probative: [TOOL_A, TOOL_B], nonProbative: [] },
          expectedActions: [
            { type: "UPDATE_TICKET_STATUS", requiredGrounding: [TOOL_A], allowedGrounding: [TOOL_A, TOOL_B] },
          ],
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 5: expectedApproval ELIGIBLE → completed run + non-empty expectedActions.
  it("rejects expectedApproval ELIGIBLE on a failed run", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "failed",
          failure: { expectedCode: "TOOL_NOT_FOUND" },
          expectedRecovery: { failedStage: "DIAGNOSTIC_EXECUTION", reportProduced: false },
          expectedApproval: "ELIGIBLE",
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("requires a completed run"))).toBe(true);
  });

  it("rejects expectedApproval ELIGIBLE with no expectedActions declared", () => {
    const messages = validate([
      baseCase({ expectations: { ...completedWithRetrieval, expectedApproval: "ELIGIBLE" } }),
    ]);
    expect(messages.some((m) => m.includes("requires at least one expectedActions entry"))).toBe(true);
  });

  it("accepts expectedApproval NOT_ELIGIBLE on a failed run", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "failed",
          failure: { expectedCode: "TOOL_NOT_FOUND" },
          expectedRecovery: { failedStage: "DIAGNOSTIC_EXECUTION", reportProduced: false },
          expectedApproval: "NOT_ELIGIBLE",
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 6: expectedTelemetryEvidence disjoint / internally distinct /
  // TOOL_EXECUTION-only.
  it("rejects a locator appearing in both probative and nonProbative", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedTelemetryEvidence: { probative: [TOOL_A], nonProbative: [TOOL_A] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must be disjoint, internally distinct, TOOL_EXECUTION-only"))).toBe(
      true,
    );
  });

  it("rejects a non-TOOL_EXECUTION locator in expectedTelemetryEvidence", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedTelemetryEvidence: {
            probative: [{ sourceType: "RAG_CHUNK", evidenceId: "fixture-chunk-1" }],
            nonProbative: [],
          },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("TOOL_EXECUTION-only"))).toBe(true);
  });

  // Rule 7: probative classification complete for referenced TOOL_EXECUTION locators.
  it("rejects a TOOL_EXECUTION locator referenced by action grounding that is not classified in expectedTelemetryEvidence", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedActions: [
            { type: "UPDATE_TICKET_STATUS", requiredGrounding: [TOOL_A], allowedGrounding: [TOOL_A] },
          ],
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must be classified in expectedTelemetryEvidence"))).toBe(true);
  });

  it("rejects a TOOL_EXECUTION locator referenced by expectedEvidence.requiredLocators that is not classified", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedEvidence: { state: "SUFFICIENT", requiredLocators: [TOOL_A] },
          expectedTelemetryEvidence: { probative: [], nonProbative: [] },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must be classified in expectedTelemetryEvidence"))).toBe(true);
  });

  it("accepts a referenced TOOL_EXECUTION locator that is classified as probative", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedEvidence: { state: "SUFFICIENT", requiredLocators: [TOOL_A] },
          expectedTelemetryEvidence: { probative: [TOOL_A], nonProbative: [] },
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 8: no nonProbative locator in action.requiredGrounding.
  it("rejects a nonProbative locator in an action's requiredGrounding", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedTelemetryEvidence: { probative: [TOOL_A], nonProbative: [TOOL_B] },
          expectedActions: [
            { type: "UPDATE_TICKET_STATUS", requiredGrounding: [TOOL_B], allowedGrounding: [TOOL_A, TOOL_B] },
          ],
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must not reference a nonProbative locator"))).toBe(true);
  });

  // Rule 9: report-requiring expectations require a completed run.
  it("rejects expectedConfidence declared on a failed run", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "failed",
          failure: { expectedCode: "TOOL_NOT_FOUND" },
          expectedRecovery: { failedStage: "DIAGNOSTIC_EXECUTION", reportProduced: false },
          expectedConfidence: { min: 0.3, max: 0.7 },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes('require runStatus "completed"'))).toBe(true);
  });

  // Rule 11 + Rule 12: expectedRecovery ⇔ runStatus "failed".
  it("rejects expectedRecovery declared on a completed run", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedRecovery: { failedStage: "DIAGNOSTIC_EXECUTION", reportProduced: false },
        },
      }),
    ]);
    expect(messages.some((m) => m.includes('requires runStatus "failed"'))).toBe(true);
  });

  it("rejects a failed run that omits expectedRecovery", () => {
    const messages = validate([
      baseCase({ expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } } }),
    ]);
    expect(messages.some((m) => m.includes('requires expectedRecovery'))).toBe(true);
  });

  it("accepts a failed run that declares expectedRecovery", () => {
    const messages = validate([
      baseCase({
        expectations: {
          runStatus: "failed",
          failure: { expectedCode: "TOOL_NOT_FOUND" },
          expectedRecovery: { failedStage: "DIAGNOSTIC_EXECUTION", reportProduced: false },
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 13: expectedDiagnostics.length <= MAX_DIAGNOSTIC_TOOL_CALLS.
  it("rejects expectedDiagnostics exceeding the maximum diagnostic tool call bound", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedDiagnostics: Array.from({ length: MAX_DIAGNOSTIC_TOOL_CALLS + 1 }, () => ({
            evidenceState: "INSUFFICIENT" as const,
            continuationReason: "STATUS_UNRESOLVED" as const,
          })),
        },
      }),
    ]);
    expect(messages.some((m) => m.includes("must not exceed the maximum diagnostic tool call bound"))).toBe(true);
  });

  it("accepts expectedDiagnostics at exactly the maximum diagnostic tool call bound", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedDiagnostics: Array.from({ length: MAX_DIAGNOSTIC_TOOL_CALLS }, () => ({
            evidenceState: "INSUFFICIENT" as const,
            continuationReason: "STATUS_UNRESOLVED" as const,
          })),
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 14: scripted provider turns <= MAX_PROVIDER_TURNS.
  it("rejects a scenario with more scripted provider turns than the maximum provider turn bound", () => {
    const turn = {
      kind: "report_submission" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      rawInput: {},
    };
    const messages = validate([
      baseCase({
        scenario: { id: "base-case", turns: Array.from({ length: MAX_PROVIDER_TURNS + 1 }, () => turn) },
      }),
    ]);
    expect(messages.some((m) => m.includes("must not exceed the maximum provider turn bound"))).toBe(true);
  });

  // Rule 15 (Checkpoint B numeric-domain alignment): count/token expectation
  // fields are non-negative integers. Fractional and negative values are
  // rejected here so the local scorer and the Python service reject the same
  // thresholds; zero is accepted where the semantics allow it.
  it.each([-1, -0.5, 1.5])(
    "rejects expectedEvidence.minDistinctLocators = %s as non-integer or negative",
    (minDistinctLocators) => {
      const messages = validate([
        baseCase({
          expectations: {
            ...completedWithRetrieval,
            expectedEvidence: { state: "SUFFICIENT", requiredLocators: [], minDistinctLocators },
          },
        }),
      ]);
      expect(messages.some((m) => m.includes("minDistinctLocators must be a non-negative integer"))).toBe(true);
    },
  );

  it.each([0, 1, 2])("accepts expectedEvidence.minDistinctLocators = %s", (minDistinctLocators) => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedEvidence: { state: "SUFFICIENT", requiredLocators: [], minDistinctLocators },
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  it.each([-1, -0.5, 1.5])(
    "rejects expectedBounds.maxTotalTokens = %s as non-integer or negative",
    (maxTotalTokens) => {
      const messages = validate([
        baseCase({
          expectations: { ...completedWithRetrieval, expectedBounds: { maxTotalTokens } },
        }),
      ]);
      expect(messages.some((m) => m.includes("maxTotalTokens must be a non-negative integer"))).toBe(true);
    },
  );

  it.each([0, 1, 2])("accepts expectedBounds.maxTotalTokens = %s", (maxTotalTokens) => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedBounds: { maxTotalTokens } },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  // Rule 16: expectedStopReason requires expectedDiagnostics. A stop reason
  // declared without the diagnostics would never be inspected (Metric 4 is
  // NOT_APPLICABLE before the stop-reason comparison), silently skipping the
  // expectation — so the orphan shape is a dataset-authoring error.
  it("rejects expectedStopReason declared without expectedDiagnostics", () => {
    const messages = validate([
      baseCase({
        expectations: { ...completedWithRetrieval, expectedStopReason: "SUFFICIENT_EVIDENCE" },
      }),
    ]);
    expect(messages.some((m) => m.includes("expectedStopReason requires expectedDiagnostics"))).toBe(true);
  });

  it("accepts expectedStopReason declared together with expectedDiagnostics", () => {
    const messages = validate([
      baseCase({
        expectations: {
          ...completedWithRetrieval,
          expectedDiagnostics: [
            { evidenceState: "SUFFICIENT" as const, continuationReason: "STATUS_UNRESOLVED" as const },
          ],
          expectedStopReason: "SUFFICIENT_EVIDENCE",
        },
      }),
    ]);
    expect(messages).toEqual([]);
  });
});
