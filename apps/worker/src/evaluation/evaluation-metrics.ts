import type { EvaluationCaseResult, EvaluationMetrics } from "./types";

const TOOL_CHECK_NAMES = [
  "tool-requested",
  "tool-executed",
  "tool-completed",
  "tool-forbidden-executed",
  "tool-forbidden-completed",
] as const;

function hasCheck(result: EvaluationCaseResult, name: string): boolean {
  return result.checks.some((check) => check.name === name);
}

function checkPassed(result: EvaluationCaseResult, name: string): boolean {
  return result.checks.find((check) => check.name === name)?.passed === true;
}

function simpleRatio(
  results: readonly EvaluationCaseResult[],
  checkName: string,
): { readonly numerator: number; readonly denominator: number } {
  const declaring = results.filter((result) => hasCheck(result, checkName));
  const passing = declaring.filter((result) => checkPassed(result, checkName));
  return { numerator: passing.length, denominator: declaring.length };
}

function toolCorrectnessRatio(
  results: readonly EvaluationCaseResult[],
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

export function aggregateMetrics(results: readonly EvaluationCaseResult[]): EvaluationMetrics {
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
