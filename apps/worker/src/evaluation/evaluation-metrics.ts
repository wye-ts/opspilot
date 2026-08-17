import type { EvaluationMetrics } from "./types";
import type { EvaluationCaseResultV2 } from "./v2-types";

const TOOL_CHECK_NAMES = [
  "tool-requested",
  "tool-executed",
  "tool-completed",
  "tool-forbidden-executed",
  "tool-forbidden-completed",
] as const;

// A check counts as passing iff its status is exactly "PASS" — a
// NOT_APPLICABLE check does not count toward a ratio's numerator.
function checkPassed(result: EvaluationCaseResultV2, name: string): boolean {
  return result.checks.find((check) => check.name === name)?.status === "PASS";
}

// A case is in a metric's denominator iff it emitted a PASS or FAIL outcome
// for that check — a NOT_APPLICABLE outcome is excluded from BOTH numerator
// and denominator (spec §11: denominator = PASS + FAIL, with the N/A count
// reported separately by the formatter). The six v1 ratios never see
// NOT_APPLICABLE (the three N/A codes are used only by the nine #59 metric
// checks), so this exclusion is a no-op for them; for the nine #59 metrics
// it is the required semantics — a case where a metric was inapplicable
// cannot lower the ratio.
function isApplicable(result: EvaluationCaseResultV2, name: string): boolean {
  const check = result.checks.find((check) => check.name === name);
  return check !== undefined && check.status !== "NOT_APPLICABLE";
}

function simpleRatio(
  results: readonly EvaluationCaseResultV2[],
  checkName: string,
): { readonly numerator: number; readonly denominator: number } {
  const applicable = results.filter((result) => isApplicable(result, checkName));
  const passing = applicable.filter((result) => checkPassed(result, checkName));
  return { numerator: passing.length, denominator: applicable.length };
}

function toolCorrectnessRatio(
  results: readonly EvaluationCaseResultV2[],
): { readonly numerator: number; readonly denominator: number } {
  const declaring = results.filter((result) =>
    result.checks.some((check) => (TOOL_CHECK_NAMES as readonly string[]).includes(check.name)),
  );
  const passing = declaring.filter((result) =>
    result.checks
      .filter((check) => (TOOL_CHECK_NAMES as readonly string[]).includes(check.name))
      .every((check) => check.status === "PASS"),
  );
  return { numerator: passing.length, denominator: declaring.length };
}

export function aggregateMetrics(results: readonly EvaluationCaseResultV2[]): EvaluationMetrics {
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
    // Issue #59 Checkpoint B — the nine #59 metric ratios (spec §5/§11).
    // N/A checks are excluded from BOTH numerator and denominator by
    // simpleRatio (only PASS counts toward the numerator, only PASS+FAIL
    // declaring cases form the denominator).
    rootCauseDiscipline: simpleRatio(results, "root-cause-discipline"),
    evidenceSupport: simpleRatio(results, "evidence-support"),
    unknownHandling: simpleRatio(results, "unknown-telemetry-handling"),
    diagnosticJustification: simpleRatio(results, "diagnostic-justification"),
    confidenceCalibration: simpleRatio(results, "confidence-calibration"),
    actionGrounding: simpleRatio(results, "action-grounding"),
    approvalGate: simpleRatio(results, "approval-gate"),
    boundsRespected: simpleRatio(results, "bounds-respected"),
    deterministicRecovery: simpleRatio(results, "deterministic-recovery"),
  };
}
