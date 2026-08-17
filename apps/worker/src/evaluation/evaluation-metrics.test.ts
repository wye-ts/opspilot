import { describe, expect, it } from "vitest";

import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationCaseResultV2, EvaluationCheckV2 } from "./v2-types";

function makeCheck(name: string, passed: boolean): EvaluationCheckV2 {
  return passed
    ? { name, status: "PASS", reasonCode: null }
    : { name, status: "FAIL", reasonCode: "STATUS_MISMATCH" };
}

function makeNaCheck(name: string): EvaluationCheckV2 {
  return { name, status: "NOT_APPLICABLE", reasonCode: "NA_EXPECTATION_NOT_DECLARED" };
}

function makeResult(
  caseId: string,
  checks: readonly EvaluationCheckV2[],
): EvaluationCaseResultV2 {
  return { caseId, passed: checks.every((check) => check.status !== "FAIL"), checks };
}

describe("aggregateMetrics", () => {
  it("computes totalCases/passedCases/failedCases/passRate", () => {
    const results = [
      makeResult("a", [makeCheck("status", true)]),
      makeResult("b", [makeCheck("status", true)]),
      makeResult("c", [makeCheck("status", false)]),
    ];

    const metrics = aggregateMetrics(results);

    expect(metrics.totalCases).toBe(3);
    expect(metrics.passedCases).toBe(2);
    expect(metrics.failedCases).toBe(1);
    expect(metrics.passRate).toBeCloseTo(2 / 3, 10);
  });

  it("scopes retrievalTop1 to cases declaring the retrieval-top1 check", () => {
    const results = [
      makeResult("a", [makeCheck("status", true), makeCheck("retrieval-top1", true)]),
      makeResult("b", [makeCheck("status", true), makeCheck("retrieval-top1", false)]),
      makeResult("c", [makeCheck("status", true)]),
    ];

    expect(aggregateMetrics(results).retrievalTop1).toEqual({ numerator: 1, denominator: 2 });
  });

  it("scopes retrievalHitAt3 to cases declaring the retrieval-hit3 check", () => {
    const results = [
      makeResult("a", [makeCheck("retrieval-hit3", true)]),
      makeResult("b", [makeCheck("retrieval-hit3", true)]),
      makeResult("c", []),
    ];

    expect(aggregateMetrics(results).retrievalHitAt3).toEqual({ numerator: 2, denominator: 2 });
  });

  it("scopes schemaHandlingCorrectness to cases declaring the schema-handling check", () => {
    const results = [
      makeResult("a", [makeCheck("schema-handling", true)]),
      makeResult("b", [makeCheck("schema-handling", false)]),
      makeResult("c", [makeCheck("schema-handling", true)]),
    ];

    expect(aggregateMetrics(results).schemaHandlingCorrectness).toEqual({ numerator: 2, denominator: 3 });
  });

  it("scopes evidenceGroundingCorrectness to cases declaring the evidence-grounding check", () => {
    const results = [
      makeResult("a", [makeCheck("evidence-grounding", true)]),
      makeResult("b", []),
    ];

    expect(aggregateMetrics(results).evidenceGroundingCorrectness).toEqual({ numerator: 1, denominator: 1 });
  });

  it("counts toolCorrectness only for cases declaring any of the five tool sub-checks, requiring all declared sub-checks to pass", () => {
    const allPassing = makeResult("all-passing", [
      makeCheck("tool-requested", true),
      makeCheck("tool-executed", true),
    ]);
    const onePassingOneFailing = makeResult("mixed", [
      makeCheck("tool-requested", true),
      makeCheck("tool-completed", false),
    ]);
    const noToolChecks = makeResult("no-tool-checks", [makeCheck("status", true)]);

    const metrics = aggregateMetrics([allPassing, onePassingOneFailing, noToolChecks]);

    expect(metrics.toolCorrectness).toEqual({ numerator: 1, denominator: 2 });
  });

  it("computes expectedStatusCorrectness over all cases, using the status check", () => {
    const results = [
      makeResult("a", [makeCheck("status", true)]),
      makeResult("b", [makeCheck("status", false)]),
    ];

    expect(aggregateMetrics(results).expectedStatusCorrectness).toEqual({ numerator: 1, denominator: 2 });
  });

  it("C: excludes NOT_APPLICABLE outcomes from BOTH numerator and denominator of the nine #59 metrics (spec §11: denominator = PASS + FAIL)", () => {
    const results = [
      makeResult("a", [makeCheck("root-cause-discipline", true)]), // PASS → in
      makeResult("b", [makeCheck("root-cause-discipline", false)]), // FAIL → in
      makeResult("c", [makeNaCheck("root-cause-discipline")]), // N/A → excluded from both
      makeResult("d", [makeNaCheck("root-cause-discipline")]), // N/A → excluded from both
      makeResult("e", []), // metric absent → excluded from both
    ];

    const metrics = aggregateMetrics(results);

    expect(metrics.rootCauseDiscipline).toEqual({ numerator: 1, denominator: 2 });
    expect(metrics.evidenceSupport).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.unknownHandling).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.diagnosticJustification).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.confidenceCalibration).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.actionGrounding).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.approvalGate).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.boundsRespected).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.deterministicRecovery).toEqual({ numerator: 0, denominator: 0 });
  });

  it("handles an empty result set deterministically, without NaN or division errors", () => {
    const metrics = aggregateMetrics([]);

    expect(metrics.totalCases).toBe(0);
    expect(metrics.passedCases).toBe(0);
    expect(metrics.failedCases).toBe(0);
    expect(metrics.passRate).toBe(0);
    expect(metrics.retrievalTop1).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.retrievalHitAt3).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.schemaHandlingCorrectness).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.evidenceGroundingCorrectness).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.toolCorrectness).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.expectedStatusCorrectness).toEqual({ numerator: 0, denominator: 0 });
  });
});
