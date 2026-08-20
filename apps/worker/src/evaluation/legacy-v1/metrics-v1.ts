// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): the historical
// v1 aggregate metrics, preserved so the offline v1 regression oracle can
// reproduce the frozen ts-parity-v1.json fixture's expectedMetrics. The
// active metrics (../evaluation-metrics.ts) operate on the v2 status model —
// this module is unwired from the active runtime and must never change.
import type { EvaluationMetricsV1, EvaluationCaseResultV1 } from "./v1-types";

const TOOL_CHECK_NAMES = [
  "tool-requested",
  "tool-executed",
  "tool-completed",
  "tool-forbidden-executed",
  "tool-forbidden-completed",
] as const;

function hasCheck(result: EvaluationCaseResultV1, name: string): boolean {
  return result.checks.some((check) => check.name === name);
}

function checkPassed(result: EvaluationCaseResultV1, name: string): boolean {
  return result.checks.find((check) => check.name === name)?.passed === true;
}

function simpleRatio(
  results: readonly EvaluationCaseResultV1[],
  checkName: string,
): { readonly numerator: number; readonly denominator: number } {
  const declaring = results.filter((result) => hasCheck(result, checkName));
  const passing = declaring.filter((result) => checkPassed(result, checkName));
  return { numerator: passing.length, denominator: declaring.length };
}

function toolCorrectnessRatio(
  results: readonly EvaluationCaseResultV1[],
): { readonly numerator: number; readonly denominator: number } {
  const declaring = results.filter((result) =>
    result.checks.some((check) => (TOOL_CHECK_NAMES as readonly string[]).includes(check.name)),
  );
  const passing = declaring.filter((result) =>
    result.checks
      .filter((check) => (TOOL_CHECK_NAMES as readonly string[]).includes(check.name))
      .every((check) => check.passed),
  );
  return { numerator: passing.length, denominator: declaring.length };
}

export function aggregateMetricsV1(results: readonly EvaluationCaseResultV1[]): EvaluationMetricsV1 {
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const failedCases = totalCases - passedCases;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;

  return {
    totalCases,
    passedCases,
    failedCases,
    passRate,
    retrievalTop1: simpleRatio(results, "retrieval-top1"),
    retrievalHitAt3: simpleRatio(results, "retrieval-hit3"),
    schemaHandlingCorrectness: simpleRatio(results, "schema-handling"),
    evidenceGroundingCorrectness: simpleRatio(results, "evidence-grounding"),
    toolCorrectness: toolCorrectnessRatio(results),
    expectedStatusCorrectness: simpleRatio(results, "status"),
  };
}
