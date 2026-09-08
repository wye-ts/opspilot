import { describe, expect, it } from "vitest";

import {
  aggregateMetrics,
  MILESTONE_13_METRIC_NAMES,
  MILESTONE_13_METRIC_PATHS,
  retrievalQualityFields,
  toFlatMilestone13Metrics,
} from "./evaluation-metrics";
import { formatEvaluationReport } from "./evaluation-formatter";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { ZERO_RETRIEVAL_QUALITY_METRICS } from "./types";
import { buildEvaluationSuiteInputV2, type RetrievalQualityMetricsInput } from "./v2-types";
import type { EvaluationCaseResultV2 } from "./v2-types";

const SUPPLIED: RetrievalQualityMetricsInput = {
  retrieverName: "bm25",
  corpusContentHash: "a".repeat(64),
  recallAtK: {
    exact: { numerator: 10, denominator: 10 },
    paraphrase: { numerator: 9, denominator: 10 },
    nearMiss: { numerator: 12, denominator: 12 },
  },
  meanReciprocalRank: {
    // Sixths encoding: 6 per rank-1 hit, 3 per rank-2, 2 per rank-3, 0 for a
    // miss; denominator = queryCount * 6.
    exact: { numerator: 60, denominator: 60 },
    paraphrase: { numerator: 55, denominator: 60 },
    nearMiss: { numerator: 58, denominator: 72 },
  },
  falsePositiveRate: { numerator: 3, denominator: 8 },
};

const PASSING_CASE: EvaluationCaseResultV2 = {
  caseId: "c1",
  passed: true,
  checks: [{ name: "status", status: "PASS", reasonCode: null }],
};

function observedStub() {
  return {
    runStatus: "completed",
    errorCode: null,
    retrieval: { completed: false, chunkIds: [] },
    tools: { requested: [], executed: [], completed: [] },
    report: {
      evidence: [],
      suggestedActionTypes: [],
      category: "SERVICE_DEGRADATION",
      rootCausePresent: false,
      confidence: 0.5,
      evidenceState: "INSUFFICIENT",
      recommendationDisposition: "ADVISORY",
      suggestedActions: [],
    },
    investigation: {
      providerTurnsUsed: 0,
      diagnosticRequestCount: 0,
      forcedFinalization: false,
      stopReason: null,
      assessments: [],
      toolFailures: [],
      bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
      usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
    },
    failedStage: null,
  } as const;
}

describe("Milestone 13 retrieval-quality metrics (#75)", () => {
  it("defaults to zero ratios with a null provenance when no input is supplied", () => {
    expect(retrievalQualityFields(undefined)).toEqual(ZERO_RETRIEVAL_QUALITY_METRICS);
    const metrics = aggregateMetrics([PASSING_CASE]);
    expect(metrics.retrievalQualityProvenance).toBeNull();
    expect(metrics.recallAtK.exact).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.falsePositiveRate).toEqual({ numerator: 0, denominator: 0 });
  });

  it("copies the supplied numbers through verbatim and records provenance", () => {
    const metrics = aggregateMetrics([PASSING_CASE], SUPPLIED);

    expect(metrics.recallAtK).toEqual(SUPPLIED.recallAtK);
    expect(metrics.meanReciprocalRank).toEqual(SUPPLIED.meanReciprocalRank);
    expect(metrics.falsePositiveRate).toEqual(SUPPLIED.falsePositiveRate);
    expect(metrics.retrievalQualityProvenance).toEqual({
      retrieverName: "bm25",
      corpusContentHash: SUPPLIED.corpusContentHash,
    });
  });

  it("never lets retrieval-quality input change the fifteen case-derived ratios", () => {
    const withInput = aggregateMetrics([PASSING_CASE], SUPPLIED);
    const without = aggregateMetrics([PASSING_CASE]);

    expect(withInput.expectedStatusCorrectness).toEqual(without.expectedStatusCorrectness);
    expect(withInput.totalCases).toBe(without.totalCases);
    expect(withInput.passRate).toBe(without.passRate);
  });

  it("LocalEvaluationScorer threads the suite input's field through unchanged", () => {
    const cases = [
      { caseId: "c1", expectations: { runStatus: "completed" } as const, observed: observedStub() },
    ];

    const withInput = new LocalEvaluationScorer().score(
      buildEvaluationSuiteInputV2("ds", cases, SUPPLIED),
    );
    expect(withInput.metrics.recallAtK).toEqual(SUPPLIED.recallAtK);
    expect(withInput.metrics.retrievalQualityProvenance?.retrieverName).toBe("bm25");

    const without = new LocalEvaluationScorer().score(buildEvaluationSuiteInputV2("ds", cases));
    expect(without.metrics.retrievalQualityProvenance).toBeNull();
    // Only the four new fields differ — the scored cases are identical.
    expect(without.cases).toEqual(withInput.cases);
  });

  it("omits retrievalQualityMetrics from the suite input entirely when not supplied", () => {
    const input = buildEvaluationSuiteInputV2("ds", []);
    // Not merely undefined — the KEY must be absent, so the JSON body an
    // ordinary run POSTs matches the pre-#75 shape exactly (the Python models
    // use extra="forbid" and reject an explicit null).
    expect(Object.hasOwn(input, "retrievalQualityMetrics")).toBe(false);
    expect(JSON.stringify(input)).not.toContain("retrievalQualityMetrics");
  });
});

describe("MILESTONE_13_METRIC_PATHS (nested <-> flat mapping)", () => {
  it("names exactly the seven flat persisted metric names", () => {
    expect(MILESTONE_13_METRIC_NAMES).toEqual([
      "recallAtKExact",
      "recallAtKParaphrase",
      "recallAtKNearMiss",
      "meanReciprocalRankExact",
      "meanReciprocalRankParaphrase",
      "meanReciprocalRankNearMiss",
      "falsePositiveRate",
    ]);
    expect(MILESTONE_13_METRIC_PATHS).toHaveLength(7);
  });

  it("resolves every nested path to the value the nested shape actually holds", () => {
    const metrics = aggregateMetrics([PASSING_CASE], SUPPLIED);
    const flat = toFlatMilestone13Metrics(metrics);

    expect(flat.recallAtKExact).toEqual(SUPPLIED.recallAtK.exact);
    expect(flat.recallAtKParaphrase).toEqual(SUPPLIED.recallAtK.paraphrase);
    expect(flat.recallAtKNearMiss).toEqual(SUPPLIED.recallAtK.nearMiss);
    expect(flat.meanReciprocalRankExact).toEqual(SUPPLIED.meanReciprocalRank.exact);
    expect(flat.meanReciprocalRankParaphrase).toEqual(SUPPLIED.meanReciprocalRank.paraphrase);
    expect(flat.meanReciprocalRankNearMiss).toEqual(SUPPLIED.meanReciprocalRank.nearMiss);
    // The one non-nested entry.
    expect(flat.falsePositiveRate).toEqual(SUPPLIED.falsePositiveRate);
  });

  it("flattens the zero default to seven 0/0 rows", () => {
    const flat = toFlatMilestone13Metrics(aggregateMetrics([PASSING_CASE]));
    expect(Object.keys(flat).sort()).toEqual([...MILESTONE_13_METRIC_NAMES].sort());
    for (const name of MILESTONE_13_METRIC_NAMES) {
      expect(flat[name]).toEqual({ numerator: 0, denominator: 0 });
    }
  });
});

describe("formatEvaluationReport — retrieval-quality rendering", () => {
  it("omits the section entirely for an ordinary case-only run", () => {
    const output = formatEvaluationReport([PASSING_CASE], aggregateMetrics([PASSING_CASE]));
    expect(output).not.toContain("Retrieval quality");
  });

  it("prints the named retriever, all seven ratios, and the corpus hash when present", () => {
    const output = formatEvaluationReport([PASSING_CASE], aggregateMetrics([PASSING_CASE], SUPPLIED));

    expect(output).toContain("Retrieval quality (retriever: bm25)");
    expect(output).toContain("Recall@3 exact: 10/10");
    expect(output).toContain("Recall@3 paraphrase: 9/10");
    expect(output).toContain("Recall@3 near-miss: 12/12");
    // Sixths are shown as stored AND divided into a readable mean.
    expect(output).toContain("MRR exact: 60/60 (1.000)");
    expect(output).toContain("MRR near-miss: 58/72 (0.806)");
    expect(output).toContain("False-positive rate: 3/8");
    expect(output).toContain(`Corpus content hash: ${SUPPLIED.corpusContentHash}`);
  });
});
