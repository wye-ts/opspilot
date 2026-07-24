import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
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
