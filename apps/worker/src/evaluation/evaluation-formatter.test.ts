import { describe, expect, it } from "vitest";

import { formatEvaluationReport } from "./evaluation-formatter";
import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationCaseResult, EvaluationCheckResult } from "./types";

function passingCheck(name: string): EvaluationCheckResult {
  return { name, passed: true, expected: null, observed: null };
}

function failingCheck(name: string, reason: string, expected: unknown = null, observed: unknown = null): EvaluationCheckResult {
  return { name, passed: false, expected, observed, reason };
}

function makeResult(caseId: string, checks: readonly EvaluationCheckResult[]): EvaluationCaseResult {
  return {
    caseId,
    passed: checks.every((check) => check.passed),
    checks,
    observed: {
      runStatus: checks.every((check) => check.passed) ? "completed" : "failed",
      retrievalCompletedObserved: false,
      retrievedChunkIds: [],
      requestedTools: [],
      executedTools: [],
      completedToolCallIds: [],
      evidenceIds: [],
    },
  };
}

describe("formatEvaluationReport", () => {
  it("prints one PASS line per passing case and the summary/metrics blocks", () => {
    const results = [makeResult("case-a", [passingCheck("status")]), makeResult("case-b", [passingCheck("status")])];
    const metrics = aggregateMetrics(results);

    const output = formatEvaluationReport(results, metrics);

    expect(output).toContain("PASS case-a");
    expect(output).toContain("PASS case-b");
    expect(output).toContain("Summary");
    expect(output).toContain("Cases: 2");
    expect(output).toContain("Passed: 2");
    expect(output).toContain("Failed: 0");
    expect(output).toContain("Pass rate: 100.0%");
  });

  it("prints a FAIL line and each failed check's fixed reason for a failing case", () => {
    const results = [
      makeResult("case-c", [
        passingCheck("status"),
        failingCheck("retrieval-top1", 'expected top-ranked chunk "x", observed "y"'),
      ]),
    ];
    const metrics = aggregateMetrics(results);

    const output = formatEvaluationReport(results, metrics);

    expect(output).toContain("FAIL case-c");
    expect(output).toContain("retrieval-top1: expected top-ranked chunk \"x\", observed \"y\"");
    expect(output).not.toContain("  - status:");
  });

  it("formats zero-denominator metrics deterministically without NaN", () => {
    const metrics = aggregateMetrics([]);
    const output = formatEvaluationReport([], metrics);

    expect(output).toContain("Cases: 0");
    expect(output).toContain("Pass rate: 0.0%");
    expect(output).toContain("Retrieval top-1: 0/0");
    expect(output).not.toContain("NaN");
  });

  describe("sanitization", () => {
    const ABSOLUTE_PATH_SENTINEL = "/private/tmp/eval-sentinel-path/should-not-appear";
    const RAW_PROMPT_SENTINEL = "RAW_PROMPT_SENTINEL_TEXT";
    const RAW_ERROR_SENTINEL = "RAW_ERROR_SENTINEL_MESSAGE";

    function buildSentinelResults(): readonly EvaluationCaseResult[] {
      return [
        makeResult("sentinel-case", [
          failingCheck(
            "evidence-ids",
            "required evidence ids missing: [e1]; forbidden evidence ids present: []",
            { requiredIds: [ABSOLUTE_PATH_SENTINEL], forbiddenIds: [] },
            { rawPrompt: RAW_PROMPT_SENTINEL, rawError: RAW_ERROR_SENTINEL, path: ABSOLUTE_PATH_SENTINEL },
          ),
        ]),
      ];
    }

    it("never surfaces a planted absolute-path sentinel embedded only in expected/observed", () => {
      const results = buildSentinelResults();
      const output = formatEvaluationReport(results, aggregateMetrics(results));
      expect(output).not.toContain(ABSOLUTE_PATH_SENTINEL);
    });

    it("never surfaces a planted raw-prompt sentinel embedded only in observed", () => {
      const results = buildSentinelResults();
      const output = formatEvaluationReport(results, aggregateMetrics(results));
      expect(output).not.toContain(RAW_PROMPT_SENTINEL);
    });

    it("never surfaces a planted raw-error-message sentinel embedded only in observed", () => {
      const results = buildSentinelResults();
      const output = formatEvaluationReport(results, aggregateMetrics(results));
      expect(output).not.toContain(RAW_ERROR_SENTINEL);
    });

    it("never contains a stack-trace-shaped line, node_modules, or a file:// URL", () => {
      const results = buildSentinelResults();
      const output = formatEvaluationReport(results, aggregateMetrics(results));

      expect(output).not.toMatch(/\n\s+at\s+/);
      expect(output).not.toContain("node_modules");
      expect(output).not.toContain("file://");
    });

    it("still permits the harness's own fixed reason text containing the substring 'at '", () => {
      const results = [
        makeResult("case-d", [
          passingCheck("status"),
          failingCheck("failure-code", 'run terminated at TOOL_NOT_FOUND'),
        ]),
      ];
      const output = formatEvaluationReport(results, aggregateMetrics(results));
      expect(output).toContain("run terminated at TOOL_NOT_FOUND");
    });
  });
});
