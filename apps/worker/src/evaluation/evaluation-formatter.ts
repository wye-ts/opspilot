import { resolveCheckReasonMessage } from "./check-reason-codes";
import type { EvaluationMetrics } from "./types";
import type { EvaluationCaseResultV2 } from "./v2-types";

function formatRatio(ratio: { readonly numerator: number; readonly denominator: number }): string {
  return `${ratio.numerator}/${ratio.denominator}`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Prints only the case id, PASS/FAIL, the fixed check name, and the fixed
// message resolved from the check's reasonCode. Operates on the wire-safe
// EvaluationCaseResultV2 shape — there is no expected/observed field to
// accidentally read here even in principle (see v2-types.ts, correction 3).
// EvaluationCheckV2 is a discriminated union: a FAIL check is
// type-guaranteed to carry a non-null CheckReasonCode, so there is no
// "check failed" fallback to author here — that state is unrepresentable.
// A NOT_APPLICABLE check never renders as a failure (it is not a FAIL), so
// the Checkpoint-A output — which emits PASS/FAIL only — is byte-identical
// to the v1 formatter.
export function formatEvaluationReport(
  results: readonly EvaluationCaseResultV2[],
  metrics: EvaluationMetrics,
): string {
  const lines: string[] = ["OpsPilot Evaluation", ""];

  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.caseId}`);
    if (!result.passed) {
      for (const check of result.checks) {
        if (check.status === "FAIL") {
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
