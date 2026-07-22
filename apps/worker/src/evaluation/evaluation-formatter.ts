import type { EvaluationCaseResult, EvaluationMetrics } from "./types";

function formatRatio(ratio: { readonly numerator: number; readonly denominator: number }): string {
  return `${ratio.numerator}/${ratio.denominator}`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Prints only the case id, PASS/FAIL, the fixed check name, and the check's
// own already-sanitized reason string — never EvaluationCheckResult.expected
// or .observed, which may carry arbitrary internal values not meant for
// display (see docs/07-evaluation-plan.md).
export function formatEvaluationReport(
  results: readonly EvaluationCaseResult[],
  metrics: EvaluationMetrics,
): string {
  const lines: string[] = ["OpsPilot Evaluation", ""];

  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.caseId}`);
    if (!result.passed) {
      for (const check of result.checks) {
        if (!check.passed) {
          lines.push(`  - ${check.name}: ${check.reason ?? "check failed"}`);
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
