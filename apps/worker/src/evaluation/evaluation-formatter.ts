import { resolveCheckReasonMessage } from "./check-reason-codes";
import type { EvaluationMetrics } from "./types";
import type { EvaluationCaseResultV1 } from "./v1-types";

function formatRatio(ratio: { readonly numerator: number; readonly denominator: number }): string {
  return `${ratio.numerator}/${ratio.denominator}`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Prints only the case id, PASS/FAIL, the fixed check name, and the fixed
// message resolved from the check's reasonCode. Operates on the wire-safe
// EvaluationCaseResultV1 shape — there is no expected/observed field to
// accidentally read here even in principle (see v1-types.ts, correction 3).
// EvaluationCheckV1 is a discriminated union: a failing check is
// type-guaranteed to carry a non-null reasonCode, so there is no
// "check failed" fallback to author here — that state is unrepresentable
// (see independent-review finding "EvaluationCheckV1 does not enforce the
// frozen reason-code invariant").
export function formatEvaluationReport(
  results: readonly EvaluationCaseResultV1[],
  metrics: EvaluationMetrics,
): string {
  const lines: string[] = ["OpsPilot Evaluation", ""];

  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.caseId}`);
    if (!result.passed) {
      for (const check of result.checks) {
        if (!check.passed) {
          lines.push(`  - ${check.name}: ${resolveCheckReasonMessage(check.reasonCode)}`);
        }
      }
    }
  }

  lines.push(
    "",
    "Summary",
    `Cases: ${metrics.totalCases}`,
    `Passed: ${metrics.passedCases}`,
    `Failed: ${metrics.failedCases}`,
    `Pass rate: ${formatPercent(metrics.passRate)}`,
    "",
    `Retrieval top-1: ${formatRatio(metrics.retrievalTop1)}`,
    `Retrieval hit@3: ${formatRatio(metrics.retrievalHitAt3)}`,
    `Schema handling: ${formatRatio(metrics.schemaHandlingCorrectness)}`,
    `Evidence grounding: ${formatRatio(metrics.evidenceGroundingCorrectness)}`,
    `Tool correctness: ${formatRatio(metrics.toolCorrectness)}`,
    `Expected status: ${formatRatio(metrics.expectedStatusCorrectness)}`,
  );

  return lines.join("\n");
}
