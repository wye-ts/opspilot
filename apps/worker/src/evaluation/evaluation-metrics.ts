import { ZERO_RETRIEVAL_QUALITY_METRICS, type EvaluationMetrics } from "./types";
import type { EvaluationCaseResultV2, RetrievalQualityMetricsInput } from "./v2-types";

// ---------------------------------------------------------------------------
// Milestone 13 Issue B (#75) §3 — the explicit, hand-written mapping between
// EvaluationMetrics's NESTED wire shape and the FLAT per-metric-name rows the
// evaluation_metrics table stores. The exact mirror of api.py's
// MILESTONE_13_METRIC_PATHS: same seven flat names, same order, same nested
// paths, so a reviewer checking one side against the other finds them
// structurally identical rather than independently re-derived.
//
// Deliberately NOT generic getattr/setattr-style introspection: a typo or a
// schema-shape change must fail typecheck immediately, not at runtime.
// ---------------------------------------------------------------------------
export const MILESTONE_13_METRIC_PATHS = [
  ["recallAtKExact", ["recallAtK", "exact"]],
  ["recallAtKParaphrase", ["recallAtK", "paraphrase"]],
  ["recallAtKNearMiss", ["recallAtK", "nearMiss"]],
  ["meanReciprocalRankExact", ["meanReciprocalRank", "exact"]],
  ["meanReciprocalRankParaphrase", ["meanReciprocalRank", "paraphrase"]],
  ["meanReciprocalRankNearMiss", ["meanReciprocalRank", "nearMiss"]],
  // Not nested — a top-level MetricRatio, so the second path segment is null.
  ["falsePositiveRate", ["falsePositiveRate", null]],
] as const satisfies readonly (readonly [string, readonly [keyof EvaluationMetrics, string | null]])[];

export const MILESTONE_13_METRIC_NAMES: readonly string[] = MILESTONE_13_METRIC_PATHS.map(
  ([flatName]) => flatName,
);

// Nested -> flat, for a persistence/wire boundary that stores one row per
// metric name (the same resolution _persist_evaluation performs in Python).
export function toFlatMilestone13Metrics(
  metrics: EvaluationMetrics,
): Readonly<Record<string, { readonly numerator: number; readonly denominator: number }>> {
  const flat: Record<string, { readonly numerator: number; readonly denominator: number }> = {};
  for (const [flatName, [group, field]] of MILESTONE_13_METRIC_PATHS) {
    const groupValue = metrics[group];
    flat[flatName] =
      field === null
        ? (groupValue as { readonly numerator: number; readonly denominator: number })
        : (groupValue as Record<string, { readonly numerator: number; readonly denominator: number }>)[field]!;
  }
  return flat;
}

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

// Milestone 13 Issue B (#75): the four retrieval-quality fields are COPIED
// from the suite input, never recomputed here — aggregateMetrics operates only
// on case results, and a labeled query-set record is not an EvaluationCase and
// produces no check. When no input is supplied, the fields fall back to the
// zero-ratio default and provenance is null.
export function retrievalQualityFields(
  input: RetrievalQualityMetricsInput | undefined,
): Pick<
  EvaluationMetrics,
  "recallAtK" | "meanReciprocalRank" | "falsePositiveRate" | "retrievalQualityProvenance"
> {
  if (input === undefined) return ZERO_RETRIEVAL_QUALITY_METRICS;
  return {
    recallAtK: input.recallAtK,
    meanReciprocalRank: input.meanReciprocalRank,
    falsePositiveRate: input.falsePositiveRate,
    retrievalQualityProvenance: {
      retrieverName: input.retrieverName,
      corpusContentHash: input.corpusContentHash,
    },
  };
}

// `retrievalQuality` is pass-through data, not something this function derives
// (see retrievalQualityFields above and the plan's §0 decision gate).
export function aggregateMetrics(
  results: readonly EvaluationCaseResultV2[],
  retrievalQuality?: RetrievalQualityMetricsInput,
): EvaluationMetrics {
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
    ...retrievalQualityFields(retrievalQuality),
  };
}
