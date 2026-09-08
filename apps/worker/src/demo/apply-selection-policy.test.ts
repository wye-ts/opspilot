import { describe, expect, it } from "vitest";

import { applySelectionPolicy } from "../../../../runbooks-eval/apply-selection-policy";
import type { QuerySetScores, RetrieverScores } from "../../../../runbooks-eval/score-query-set";

// Issue #76 §4/§7 acceptance criterion 11 — table-driven tests for the
// selection-policy tie-break (round-2 Codex-review MAJOR fix #4).

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator };
}

function buildRetrieverScores(overrides: Partial<RetrieverScores> = {}): RetrieverScores {
  return {
    recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(10, 12) },
    meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(60, 72) },
    falsePositiveRate: ratio(1, 8),
    ...overrides,
  };
}

function buildScores(retrievers: Readonly<Record<string, RetrieverScores>>): QuerySetScores {
  return {
    corpusContentHash: "hash",
    queryContentHash: "hash",
    retrieverFingerprints: Object.fromEntries(Object.keys(retrievers).map((name) => [name, `fp-${name}`])),
    retrievers,
  };
}

describe("applySelectionPolicy", () => {
  it("keyword wins a tie it participates in (the concrete regression test for the round-2 fix)", () => {
    const scores = buildScores({
      keyword: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(11, 12) }, falsePositiveRate: ratio(8, 8) }),
      "frozen-embedding": buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) }, falsePositiveRate: ratio(3, 8) }),
    });

    const result = applySelectionPolicy(scores);

    expect(result.winner).toBe("keyword");
    expect(result.tier).toBe("primary-paraphrase-recall");
    expect([...result.tiedCandidates].sort()).toEqual(["frozen-embedding", "keyword"]);
    expect(result.tieBrokenBy).toBe("keyword-participant");
  });

  it("this repo's real committed three-way comparison ties at paraphrase recall and keyword wins", () => {
    // Bit-for-bit the actual numbers in runbooks-eval/query-set-scores.json
    // at the time this issue's comparison ran — the real, not synthetic,
    // trigger of the ambiguity the round-2 finding predicted.
    const scores = buildScores({
      keyword: {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(11, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(53, 72) },
        falsePositiveRate: ratio(8, 8),
      },
      bm25: {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(10, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(49, 72) },
        falsePositiveRate: ratio(4, 8),
      },
      "frozen-embedding": {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(57, 60), nearMiss: ratio(69, 72) },
        falsePositiveRate: ratio(3, 8),
      },
    });

    const result = applySelectionPolicy(scores);

    expect(result.winner).toBe("keyword");
    expect(result.tier).toBe("primary-paraphrase-recall");
    expect([...result.tiedCandidates].sort()).toEqual(["bm25", "frozen-embedding", "keyword"]);
  });

  it("BM25 and frozen-embedding tie for the win, both beating keyword — lower falsePositiveRate decides", () => {
    const scores = buildScores({
      keyword: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(8, 10), nearMiss: ratio(11, 12) }, falsePositiveRate: ratio(8, 8) }),
      bm25: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(10, 12) }, falsePositiveRate: ratio(5, 8) }),
      "frozen-embedding": buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) }, falsePositiveRate: ratio(2, 8) }),
    });

    const result = applySelectionPolicy(scores);

    expect(result.winner).toBe("frozen-embedding");
    expect(result.tier).toBe("primary-paraphrase-recall");
    expect([...result.tiedCandidates].sort()).toEqual(["bm25", "frozen-embedding"]);
    expect(result.tieBrokenBy).toBe("lower-false-positive-rate");
  });

  it("an outright, non-tied primary-metric winner needs no tie-break", () => {
    const scores = buildScores({
      keyword: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(7, 10), nearMiss: ratio(11, 12) }, falsePositiveRate: ratio(8, 8) }),
      "frozen-embedding": buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) }, falsePositiveRate: ratio(3, 8) }),
    });

    const result = applySelectionPolicy(scores);

    expect(result.winner).toBe("frozen-embedding");
    expect(result.tieBrokenBy).toBeNull();
    expect(result.tiedCandidates).toEqual(["frozen-embedding"]);
  });

  it("no candidate clears the falsePositiveRate bar at either tier — falls back to 'no-change'", () => {
    const scores = buildScores({
      keyword: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(8, 10), nearMiss: ratio(11, 12) }, falsePositiveRate: ratio(2, 8) }),
      "frozen-embedding": buildRetrieverScores({
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) },
        falsePositiveRate: ratio(7, 8), // exceeds keyword's own falsePositiveRate (2/8) — fails BOTH tiers' shared FPR bar
      }),
    });

    const result = applySelectionPolicy(scores);

    expect(result.tier).toBe("no-change");
    expect(result.winner).toBe("keyword");
  });

  it("a candidate clears only the falsePositiveRate bar (fails the tier-1 exact-recall bar) — decided at tier 2 by exact recall", () => {
    const scores = buildScores({
      keyword: buildRetrieverScores({ recallAtK: { exact: ratio(10, 10), paraphrase: ratio(6, 10), nearMiss: ratio(11, 12) }, falsePositiveRate: ratio(8, 8) }),
      "frozen-embedding": buildRetrieverScores({
        recallAtK: { exact: ratio(5, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) }, // exact recall regresses > 10pp — fails tier-1's own bar
        falsePositiveRate: ratio(3, 8), // clears the falsePositiveRate bar
      }),
    });

    const result = applySelectionPolicy(scores);

    expect(result.tier).toBe("tiebreak-exact-recall");
    // keyword's exact recall (10/10) beats frozen-embedding's (5/10) at tier 2's own ranking metric.
    expect(result.winner).toBe("keyword");
  });
});
