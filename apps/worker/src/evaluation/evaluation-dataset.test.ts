import { describe, expect, it } from "vitest";

import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { validateEvaluationDataset } from "./dataset-validation";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { aggregateMetrics } from "./evaluation-metrics";
import { runEvaluationSuite } from "./evaluation-runner";

const EXPECTED_CASE_IDS = [
  "notification-service-degradation",
  "notification-queue-backlog",
  "authentication-failure",
  "database-connection-saturation",
  "billing-invoice-formatting",
  "irrelevant-no-match-query",
  "fabricated-rag-evidence",
  "fabricated-tool-evidence",
  "unknown-tool-request",
  "invalid-tool-input",
  "provider-protocol-error",
  "missing-final-report",
  "tool-execution-failure",
  "malformed-report-submission",
  "injection-probe-structural",
];

describe("EVALUATION_CASES", () => {
  it("contains exactly the 15 approved case ids, in the approved order", () => {
    expect(EVALUATION_CASES.map((evaluationCase) => evaluationCase.id)).toEqual(EXPECTED_CASE_IDS);
  });

  it("has no duplicate case ids", () => {
    const ids = EVALUATION_CASES.map((evaluationCase) => evaluationCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("passes validateEvaluationDataset with zero errors against the real loaded corpus", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const messages = validateEvaluationDataset({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });

    expect(messages).toEqual([]);
  });

  it("passes every declared expectation for all 15 cases when run against the real corpus and real components", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const results = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });

    const failures = results.filter((result) => !result.passed);
    expect(failures).toEqual([]);

    const metrics = aggregateMetrics(results);
    expect(metrics.totalCases).toBe(15);
    expect(metrics.passedCases).toBe(15);
    expect(metrics.failedCases).toBe(0);
    expect(metrics.retrievalTop1).toEqual({ numerator: 6, denominator: 6 });
    expect(metrics.retrievalHitAt3).toEqual({ numerator: 2, denominator: 2 });
    expect(metrics.schemaHandlingCorrectness).toEqual({ numerator: 10, denominator: 10 });
    expect(metrics.evidenceGroundingCorrectness).toEqual({ numerator: 9, denominator: 9 });
    expect(metrics.toolCorrectness).toEqual({ numerator: 11, denominator: 11 });
    expect(metrics.expectedStatusCorrectness).toEqual({ numerator: 15, denominator: 15 });
  });
});
