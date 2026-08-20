import { resolveCheckReasonMessage } from "./check-reason-codes";
import { resolveNotApplicableMessage } from "./not-applicable-codes";
import type { EvaluationMetrics } from "./types";
import type { EvaluationCaseResultV2 } from "./v2-types";

function formatRatio(ratio: { readonly numerator: number; readonly denominator: number }): string {
  return `${ratio.numerator}/${ratio.denominator}`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Issue #59 Checkpoint B §11: a new metric's summary line is
// `numerator/denominator (n/a_count n/a)`. The N/A count is derived from the
// case results array (counting NOT_APPLICABLE checks per metric check name) —
// never carried on the ratio itself (the DB evaluation_metrics table has no
// na_count column; see the Checkpoint B design decision).
function formatMetricRatio(
  ratio: { readonly numerator: number; readonly denominator: number },
  results: readonly EvaluationCaseResultV2[],
  checkName: string,
): string {
  const naCount = results.filter((result) =>
    result.checks.some((check) => check.name === checkName && check.status === "NOT_APPLICABLE"),
  ).length;
  return `${formatRatio(ratio)} (${naCount} n/a)`;
}

// Prints only the case id, PASS/FAIL, the fixed check name, and the fixed
// message resolved from the check's reasonCode. Operates on the wire-safe
// EvaluationCaseResultV2 shape — there is no expected/observed field to
// accidentally read here even in principle (see v2-types.ts, correction 3).
// EvaluationCheckV2 is a discriminated union: a FAIL check is
// type-guaranteed to carry a non-null CheckReasonCode, so there is no
// "check failed" fallback to author here — that state is unrepresentable.
//
// Issue #59 Checkpoint B §11: N/A metric outcomes render visibly using the
// fixed application-authored NOT_APPLICABLE message, prefixed `~` (distinct
// from the `-` of a FAIL check). N/A never fails a case, so the case line
// stays PASS/FAIL derived purely from FAIL checks.
export function formatEvaluationReport(
  results: readonly EvaluationCaseResultV2[],
  metrics: EvaluationMetrics,
): string {
  const lines: string[] = ["OpsPilot Evaluation", ""];

  for (const result of results) {
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.caseId}`);
    for (const check of result.checks) {
      if (check.status === "FAIL") {
        lines.push(`  - ${check.name}: ${resolveCheckReasonMessage(check.reasonCode)}`);
      } else if (check.status === "NOT_APPLICABLE") {
        lines.push(`  ~ ${check.name}: ${resolveNotApplicableMessage(check.reasonCode)}`);
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
    `Root-cause discipline: ${formatMetricRatio(metrics.rootCauseDiscipline, results, "root-cause-discipline")}`,
    `Evidence support: ${formatMetricRatio(metrics.evidenceSupport, results, "evidence-support")}`,
    `Unknown handling: ${formatMetricRatio(metrics.unknownHandling, results, "unknown-telemetry-handling")}`,
    `Diagnostic justification: ${formatMetricRatio(metrics.diagnosticJustification, results, "diagnostic-justification")}`,
    `Confidence calibration: ${formatMetricRatio(metrics.confidenceCalibration, results, "confidence-calibration")}`,
    `Action grounding: ${formatMetricRatio(metrics.actionGrounding, results, "action-grounding")}`,
    `Approval gate: ${formatMetricRatio(metrics.approvalGate, results, "approval-gate")}`,
    `Bounds respected: ${formatMetricRatio(metrics.boundsRespected, results, "bounds-respected")}`,
    `Deterministic recovery: ${formatMetricRatio(metrics.deterministicRecovery, results, "deterministic-recovery")}`,
  );

  return lines.join("\n");
}
