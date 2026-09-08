import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { computeCorpusContentHash, CURRENT_RETRIEVER_FINGERPRINTS } from "../rag";
import {
  INCLUDE_RETRIEVAL_QUALITY_ENV,
  RETRIEVAL_QUALITY_RETRIEVER_ENV,
  RetrievalQualityConfigError,
  resolveRetrievalQualityMetrics,
} from "./retrieval-quality-config";

const CORPUS: readonly StoredRunbookChunk[] = [
  { chunkId: "c-1", runbookId: "r-1", title: "Notification Delay", content: "Delayed notification emails." },
  { chunkId: "c-2", runbookId: "r-2", title: "Auth Failures", content: "Customers unable to log in." },
];

const CORPUS_HASH = computeCorpusContentHash(CORPUS);

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator };
}

// Fingerprints must be the REAL current ones (not placeholder strings) —
// this fixture exercises resolveRetrievalQualityMetrics's fingerprint check
// (added as a Codex-review MAJOR fix), which rejects any artifact whose
// stored fingerprint disagrees with CURRENT_RETRIEVER_FINGERPRINTS.
function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    corpusContentHash: CORPUS_HASH,
    queryContentHash: "b".repeat(64),
    retrieverFingerprints: CURRENT_RETRIEVER_FINGERPRINTS,
    retrievers: {
      keyword: {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(9, 10), nearMiss: ratio(11, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(55, 60), nearMiss: ratio(53, 72) },
        falsePositiveRate: ratio(5, 8),
      },
      bm25: {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(58, 72) },
        falsePositiveRate: ratio(3, 8),
      },
    },
    ...overrides,
  });
}

const read = (json: string) => () => json;

describe("resolveRetrievalQualityMetrics", () => {
  it("returns undefined when the feature flag is absent (the default for every existing invocation)", () => {
    expect(resolveRetrievalQualityMetrics({}, CORPUS, read(artifact()))).toBeUndefined();
  });

  it("returns undefined for an explicitly-disabled flag", () => {
    for (const flag of ["", "0", "   "]) {
      expect(
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: flag },
          CORPUS,
          read(artifact()),
        ),
      ).toBeUndefined();
    }
  });

  it("fails closed when the retriever selector is omitted while the flag is set", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1" },
        CORPUS,
        read(artifact()),
      ),
    ).toThrow(RetrievalQualityConfigError);
    // Never a silent default to whichever retriever happens to be first.
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "  " },
        CORPUS,
        read(artifact()),
      ),
    ).toThrow(/is required whenever/);
  });

  it("fails closed when the named retriever is absent from the artifact", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "voyage" },
        CORPUS,
        read(artifact()),
      ),
    ).toThrow(/is not present in query-set-scores.json \(available: bm25, keyword\)/);
  });

  it("selects exactly one retriever's entry and labels it", () => {
    const resolved = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
      CORPUS,
      read(artifact()),
    );

    expect(resolved).toEqual({
      retrieverName: "bm25",
      corpusContentHash: CORPUS_HASH,
      recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) },
      meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(58, 72) },
      falsePositiveRate: ratio(3, 8),
    });
  });

  it("resolves each retriever to its own distinct numbers", () => {
    const keyword = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "keyword" },
      CORPUS,
      read(artifact()),
    );
    const bm25 = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
      CORPUS,
      read(artifact()),
    );

    expect(keyword?.retrieverName).toBe("keyword");
    expect(bm25?.retrieverName).toBe("bm25");
    expect(keyword?.falsePositiveRate).not.toEqual(bm25?.falsePositiveRate);
  });

  // The runtime freshness binding (plan §2.1a): this must fail WITHOUT any
  // prior `score-query-set.ts --check` run.
  it("fails closed when the loaded corpus disagrees with the artifact's stored hash", () => {
    const editedCorpus: readonly StoredRunbookChunk[] = [
      { ...CORPUS[0]!, content: "Delayed notification emails, plus a newly edited sentence." },
      CORPUS[1]!,
    ];

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        editedCorpus,
        read(artifact()),
      ),
    ).toThrow(/stale/);
  });

  // Codex-review MAJOR fix: a corpus-only freshness check cannot catch a
  // retriever CONFIGURATION change (a threshold, k1/b) — the corpus hash
  // still matches, so this must be checked independently, and must also
  // fail WITHOUT any prior `--check` run.
  it("fails closed when the artifact's stored fingerprint for the selected retriever is stale", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(artifact({ retrieverFingerprints: { ...CURRENT_RETRIEVER_FINGERPRINTS, bm25: "stale-fingerprint" } })),
      ),
    ).toThrow(/stale.*configuration|configuration.*no longer matches/);
  });

  it("fails closed when retrieverFingerprints is missing or malformed", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(artifact({ retrieverFingerprints: "nope" })),
      ),
    ).toThrow(/retrieverFingerprints must be an object/);
  });

  it("fails closed on an unreadable artifact", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        () => {
          throw new Error("ENOENT");
        },
      ),
    ).toThrow(/could not be read/);
  });

  it("fails closed on malformed artifact contents rather than attaching partial numbers", () => {
    const cases: readonly [string, RegExp][] = [
      ["not json", /not valid JSON/],
      ["[]", /must be a JSON object/],
      [artifact({ corpusContentHash: 42 }), /corpusContentHash must be a non-empty string/],
      [JSON.stringify({ corpusContentHash: CORPUS_HASH, retrievers: "nope" }), /retrievers must be an object/],
    ];

    for (const [raw, pattern] of cases) {
      expect(() =>
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
          CORPUS,
          read(raw),
        ),
      ).toThrow(pattern);
    }
  });

  it("rejects a non-integer or negative ratio inside the selected entry", () => {
    const broken = JSON.parse(artifact()) as {
      retrievers: { bm25: { falsePositiveRate: unknown } };
    };
    broken.retrievers.bm25.falsePositiveRate = { numerator: 1.5, denominator: 8 };

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(JSON.stringify(broken)),
      ),
    ).toThrow(/numerator must be a non-negative integer/);
  });

  // Codex-review MAJOR fix: a ratio is a proportion, not merely a pair of
  // non-negative integers — without this check an artifact (or a future
  // Python-service POST body sharing this same validation rule) could carry
  // a numerator exceeding its denominator (a reported rate above 100%) or a
  // positive numerator over a zero denominator (undefined as a ratio), and
  // the pass-through design (plan §0's decision gate) has no later
  // recomputation step that would ever catch the corruption.
  it("rejects a ratio whose numerator exceeds its denominator", () => {
    const broken = JSON.parse(artifact()) as {
      retrievers: { bm25: { falsePositiveRate: unknown } };
    };
    broken.retrievers.bm25.falsePositiveRate = { numerator: 9, denominator: 8 };

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(JSON.stringify(broken)),
      ),
    ).toThrow(/must not exceed/);
  });

  it("rejects a positive numerator over a zero denominator", () => {
    const broken = JSON.parse(artifact()) as {
      retrievers: { bm25: { falsePositiveRate: unknown } };
    };
    broken.retrievers.bm25.falsePositiveRate = { numerator: 1, denominator: 0 };

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(JSON.stringify(broken)),
      ),
      // Any positive numerator over a zero denominator also trips the
      // numerator > denominator check first (fail-fast ordering) — both are
      // real rejections of the same invalid ratio, so asserting the actual
      // (numerator > denominator) message is correct, not a weaker check.
    ).toThrow(/must not exceed/);
  });

  it("accepts a genuinely zero ratio (0/0 — the documented absent-metric shape)", () => {
    const zeroed = JSON.parse(artifact()) as {
      retrievers: { bm25: { falsePositiveRate: unknown } };
    };
    zeroed.retrievers.bm25.falsePositiveRate = { numerator: 0, denominator: 0 };

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(JSON.stringify(zeroed)),
      ),
    ).not.toThrow();
  });

  it("rejects a flag value other than 1 rather than treating it as truthy", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "true", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(artifact()),
      ),
    ).toThrow(/must be "1" when set/);
  });
});
