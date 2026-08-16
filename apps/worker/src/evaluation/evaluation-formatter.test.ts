import { describe, expect, it } from "vitest";

import { CHECK_REASON_MESSAGES, type CheckReasonCode } from "./check-reason-codes";
import { formatEvaluationReport } from "./evaluation-formatter";
import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationCaseResultV2, EvaluationCheckV2 } from "./v2-types";

function passingCheck(name: string): EvaluationCheckV2 {
  return { name, status: "PASS", reasonCode: null };
}

function failingCheck(name: string, reasonCode: CheckReasonCode): EvaluationCheckV2 {
  return { name, status: "FAIL", reasonCode };
}

function makeResult(caseId: string, checks: readonly EvaluationCheckV2[]): EvaluationCaseResultV2 {
  return { caseId, passed: checks.every((check) => check.status !== "FAIL"), checks };
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
        failingCheck("retrieval-top1", "RETRIEVAL_TOP1_MISMATCH"),
      ]),
    ];
    const metrics = aggregateMetrics(results);

    const output = formatEvaluationReport(results, metrics);

    expect(output).toContain("FAIL case-c");
    expect(output).toContain("retrieval-top1: The expected top-ranked chunk was not observed.");
    expect(output).not.toContain("  - status:");
  });

  it("a failing check with a null reasonCode is a compile-time error — there is no 'check failed' fallback to test", () => {
    // @ts-expect-error — EvaluationCheckV2 is a discriminated union; a
    // failing check (status: "FAIL") must carry a real CheckReasonCode.
    // This exact shape is the one the independent review found the
    // formatter silently rendering as the generic "check failed" fallback.
    const invalid: EvaluationCheckV2 = { name: "status", status: "FAIL", reasonCode: null };
    expect(invalid.status).toBe("FAIL");
  });

  it("a passing check with a non-null reasonCode is also a compile-time error", () => {
    // @ts-expect-error — a passing check must carry reasonCode: null.
    const invalid: EvaluationCheckV2 = { name: "status", status: "PASS", reasonCode: "STATUS_MISMATCH" };
    expect(invalid.status).toBe("PASS");
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
    // EvaluationCaseResultV2/EvaluationCheckV2 have no expected/observed
    // fields at all (see v2-types.ts, correction 3) — formatEvaluationReport
    // therefore cannot leak them even in principle; there is no way to even
    // construct a fixture that plants a sentinel there. What remains
    // checkable at this layer is that every fixed reason-code message is
    // itself free of stack-trace-shaped content, checked exhaustively below.
    // The "no expected/observed keys survive serialization" proof lives in
    // v2-types.test.ts, at the actual internal→wire conversion boundary.
    it("every fixed reason-code message renders verbatim, none of them stack-trace-shaped", () => {
      for (const [code, message] of Object.entries(CHECK_REASON_MESSAGES) as [CheckReasonCode, string][]) {
        const results = [makeResult("case-d", [failingCheck("some-check", code)])];
        const output = formatEvaluationReport(results, aggregateMetrics(results));

        expect(output).toContain(`some-check: ${message}`);
        expect(output).not.toMatch(/\n\s+at\s+/);
        expect(output).not.toContain("node_modules");
        expect(output).not.toContain("file://");
      }
    });
  });
});
