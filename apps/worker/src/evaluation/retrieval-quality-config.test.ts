import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { computeCorpusContentHash } from "../rag";
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

function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    corpusContentHash: CORPUS_HASH,
    queryContentHash: "b".repeat(64),
    retrieverFingerprints: { keyword: "f-keyword", bm25: "f-bm25" },
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
