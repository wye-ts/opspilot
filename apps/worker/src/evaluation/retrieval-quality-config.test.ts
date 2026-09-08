import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../../../runbooks-eval/embedding-fixture-config";
import {
  computeCorpusContentHash,
  computeEmbeddingFixturePayloadHash,
  computeFrozenEmbeddingFingerprint,
  CURRENT_RETRIEVER_FINGERPRINTS,
  DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE,
  sha256,
} from "../rag";
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

// A real query-set text (not a placeholder) — every test's readQuerySet()
// returns this exact text by default, so its hash matches the artifact's
// queryContentHash field (issue #76 §2.5 / round-2 fix #2's new check).
const RAW_QUERY_SET_TEXT = '{"queries":["fixture query set text"]}';
const QUERY_SET_HASH = sha256(RAW_QUERY_SET_TEXT);

// One-hot vectors at the REAL current EMBEDDING_DIMENSIONS — using the real
// dimensionality (not a toy 2-d vector) exercises the actual
// EMBEDDING_MODEL/EMBEDDING_DIMENSIONS cross-check (Codex-review MAJOR fix)
// through the same well-formed default fixture every other test reuses.
function oneHot(index: number): readonly number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

// A well-formed, hash-consistent embedding fixture (issue #76 §2.5 / round-2
// fix #3's frozen-embedding fingerprint check) using the real current
// EMBEDDING_MODEL/EMBEDDING_DIMENSIONS.
const RAW_EMBEDDING_FIXTURE = JSON.stringify({
  embeddingModel: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  corpusContentHash: CORPUS_HASH,
  queryContentHash: QUERY_SET_HASH,
  chunks: [
    { chunkId: "c-1", vector: oneHot(0) },
    { chunkId: "c-2", vector: oneHot(1) },
  ],
  queries: [{ id: "q-1", vector: oneHot(0) }],
});

const FROZEN_EMBEDDING_FINGERPRINT = (() => {
  const parsed = JSON.parse(RAW_EMBEDDING_FIXTURE) as {
    embeddingModel: string;
    dimensions: number;
    corpusContentHash: string;
    queryContentHash: string;
    chunks: readonly { chunkId: string; vector: readonly number[] }[];
    queries: readonly { id: string; vector: readonly number[] }[];
  };
  return computeFrozenEmbeddingFingerprint(
    {
      embeddingModel: parsed.embeddingModel,
      dimensions: parsed.dimensions,
      corpusContentHash: parsed.corpusContentHash,
      queryContentHash: parsed.queryContentHash,
      vectorPayloadHash: computeEmbeddingFixturePayloadHash(parsed.chunks, parsed.queries),
    },
    DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE,
  );

})();

function ratio(numerator: number, denominator: number) {
  return { numerator, denominator };
}

// Fingerprints must be the REAL current ones (not placeholder strings) —
// this fixture exercises resolveRetrievalQualityMetrics's fingerprint check
// (added as a Codex-review MAJOR fix), which rejects any artifact whose
// stored fingerprint disagrees with CURRENT_RETRIEVER_FINGERPRINTS (keyword/
// bm25) or the freshly-derived frozen-embedding fingerprint.
function artifact(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    corpusContentHash: CORPUS_HASH,
    queryContentHash: QUERY_SET_HASH,
    retrieverFingerprints: { ...CURRENT_RETRIEVER_FINGERPRINTS, "frozen-embedding": FROZEN_EMBEDDING_FINGERPRINT },
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
      "frozen-embedding": {
        recallAtK: { exact: ratio(10, 10), paraphrase: ratio(10, 10), nearMiss: ratio(12, 12) },
        meanReciprocalRank: { exact: ratio(60, 60), paraphrase: ratio(60, 60), nearMiss: ratio(60, 72) },
        falsePositiveRate: ratio(2, 8),
      },
    },
    ...overrides,
  });
}

const read = (json: string) => () => json;
const readQuerySet = () => RAW_QUERY_SET_TEXT;
const readEmbeddingFixture = () => RAW_EMBEDDING_FIXTURE;

// Builds an otherwise well-formed embedding fixture with chunks/queries
// overridden — used by the malformed-entry table-driven test below (Codex-
// review MINOR fix's missingTest spec).
function fixtureWith(overrides: { chunks?: unknown; queries?: unknown }): string {
  return JSON.stringify({
    embeddingModel: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    corpusContentHash: CORPUS_HASH,
    queryContentHash: QUERY_SET_HASH,
    chunks: overrides.chunks ?? [{ chunkId: "c-1", vector: oneHot(0) }, { chunkId: "c-2", vector: oneHot(1) }],
    queries: overrides.queries ?? [{ id: "q-1", vector: oneHot(0) }],
  });
}


describe("resolveRetrievalQualityMetrics", () => {
  it("returns undefined when the feature flag is absent (the default for every existing invocation)", () => {
    expect(
      resolveRetrievalQualityMetrics({}, CORPUS, read(artifact()), readQuerySet, readEmbeddingFixture),
    ).toBeUndefined();
  });

  it("returns undefined for an explicitly-disabled flag", () => {
    for (const flag of ["", "0", "   "]) {
      expect(
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: flag },
          CORPUS,
          read(artifact()),
          readQuerySet,
          readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(RetrievalQualityConfigError);
    // Never a silent default to whichever retriever happens to be first.
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "  " },
        CORPUS,
        read(artifact()),
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/is required whenever/);
  });

  it("fails closed when the named retriever is absent from the artifact", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "voyage" },
        CORPUS,
        read(artifact()),
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/is not present in query-set-scores.json \(available: bm25, frozen-embedding, keyword\)/);
  });

  it("selects exactly one retriever's entry and labels it", () => {
    const resolved = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
      CORPUS,
      read(artifact()),
      readQuerySet,
      readEmbeddingFixture,
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
      readQuerySet,
      readEmbeddingFixture,
    );
    const bm25 = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
      CORPUS,
      read(artifact()),
      readQuerySet,
      readEmbeddingFixture,
    );

    expect(keyword?.retrieverName).toBe("keyword");
    expect(bm25?.retrieverName).toBe("bm25");
    expect(keyword?.falsePositiveRate).not.toEqual(bm25?.falsePositiveRate);
  });

  it("selects the frozen-embedding retriever's entry, deriving its fingerprint from the loaded fixture", () => {
    const resolved = resolveRetrievalQualityMetrics(
      { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "frozen-embedding" },
      CORPUS,
      read(artifact()),
      readQuerySet,
      readEmbeddingFixture,
    );

    expect(resolved?.retrieverName).toBe("frozen-embedding");
    expect(resolved?.falsePositiveRate).toEqual(ratio(2, 8));
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
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/stale/);
  });

  // Issue #76 §2.5 / round-2 fix #2 — a pre-existing gap #75 left open for
  // EVERY retriever (not just frozen-embedding): an edited query set with an
  // unchanged corpus must fail closed here too, without any prior
  // `--check` run.
  it("fails closed when the current query set disagrees with the artifact's stored queryContentHash, for every retriever", () => {
    for (const retrieverName of ["keyword", "bm25", "frozen-embedding"]) {
      expect(() =>
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: retrieverName },
          CORPUS,
          read(artifact()),
          () => '{"queries":["a different query set entirely"]}',
          readEmbeddingFixture,
        ),
      ).toThrow(/stale/);
    }
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
        read(
          artifact({
            retrieverFingerprints: {
              ...CURRENT_RETRIEVER_FINGERPRINTS,
              bm25: "stale-fingerprint",
              "frozen-embedding": FROZEN_EMBEDDING_FINGERPRINT,
            },
          }),
        ),
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/stale.*configuration|configuration.*no longer matches/);
  });

  // Issue #76 §2.5 / round-2 fix #3 — the frozen-embedding candidate has no
  // static CURRENT_RETRIEVER_FINGERPRINTS entry; its fingerprint is derived
  // fresh from the loaded fixture on every call, so a stale artifact entry
  // must be caught the same way a stale keyword/bm25 fingerprint already is.
  it("fails closed when the artifact's stored frozen-embedding fingerprint is stale", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "frozen-embedding" },
        CORPUS,
        read(
          artifact({
            retrieverFingerprints: { ...CURRENT_RETRIEVER_FINGERPRINTS, "frozen-embedding": "stale-fingerprint" },
          }),
        ),
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/stale.*configuration|configuration.*no longer matches/);
  });

  // Codex-review MAJOR fix: the fixture-mismatch check above catches the
  // fixture disagreeing with ITSELF (via internal reads), but a stale
  // artifact+fixture that AGREE with each other on an old model/dimensions
  // must also fail closed against the independently-sourced current expected
  // configuration — without running score-query-set.ts --check first.
  it("fails closed when the artifact and fixture agree with each other but both use a stale model", () => {
    const staleFixture = JSON.stringify({
      embeddingModel: "voyage-2",
      dimensions: 1024,
      corpusContentHash: CORPUS_HASH,
      queryContentHash: QUERY_SET_HASH,
      chunks: [
        { chunkId: "c-1", vector: [1, 0] },
        { chunkId: "c-2", vector: [0, 1] },
      ],
      queries: [{ id: "q-1", vector: [1, 0] }],
    });
    const staleFingerprint = computeFrozenEmbeddingFingerprint(
      {
        embeddingModel: "voyage-2",
        dimensions: 1024,
        corpusContentHash: CORPUS_HASH,
        queryContentHash: QUERY_SET_HASH,
        vectorPayloadHash: computeEmbeddingFixturePayloadHash(
          [
            { chunkId: "c-1", vector: [1, 0] },
            { chunkId: "c-2", vector: [0, 1] },
          ],
          [{ id: "q-1", vector: [1, 0] }],
        ),
      },
      DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE,
    );

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "frozen-embedding" },
        CORPUS,
        read(
          artifact({
            retrieverFingerprints: { ...CURRENT_RETRIEVER_FINGERPRINTS, "frozen-embedding": staleFingerprint },
          }),
        ),
        readQuerySet,
        () => staleFixture,
      ),
    ).toThrow(/stale.*embeddingModel/);
  });

  it("fails closed on a stale-dimensions fixture, even when the artifact and fixture agree with each other", () => {
    const staleFixture = JSON.stringify({
      embeddingModel: "voyage-4-lite",
      dimensions: 512,
      corpusContentHash: CORPUS_HASH,
      queryContentHash: QUERY_SET_HASH,
      chunks: [
        { chunkId: "c-1", vector: new Array(512).fill(0).map((_, i) => (i === 0 ? 1 : 0)) },
        { chunkId: "c-2", vector: new Array(512).fill(0).map((_, i) => (i === 1 ? 1 : 0)) },
      ],
      queries: [{ id: "q-1", vector: new Array(512).fill(0).map((_, i) => (i === 0 ? 1 : 0)) }],
    });

    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "frozen-embedding" },
        CORPUS,
        read(artifact()),
        readQuerySet,
        () => staleFixture,
      ),
    ).toThrow(/stale.*dimensions/);
  });

  // Codex-review MINOR fix (missingTest spec): a table-driven regression
  // over null/non-object entries, invalid identifiers, and malformed vectors
  // — each must be rejected with RetrievalQualityConfigError (an actionable
  // configuration error, matching every other structural check in this
  // resolver), never a raw TypeError escaping from
  // computeEmbeddingFixturePayloadHash().
  it("fails closed with RetrievalQualityConfigError (never a raw TypeError) on a malformed fixture chunk/query entry", () => {
    const cases: readonly [string, () => string][] = [
      ["null chunk entry", () => fixtureWith({ chunks: [null] })],
      ["non-object chunk entry", () => fixtureWith({ chunks: ["not-an-object"] })],
      ["chunk entry missing chunkId", () => fixtureWith({ chunks: [{ vector: oneHot(0) }] })],
      ["chunk entry with empty chunkId", () => fixtureWith({ chunks: [{ chunkId: "", vector: oneHot(0) }] })],
      ["chunk entry with non-array vector", () => fixtureWith({ chunks: [{ chunkId: "c-1", vector: "nope" }] })],
      [
        "chunk entry with a non-numeric vector component",
        () => fixtureWith({ chunks: [{ chunkId: "c-1", vector: [0, "x"] }] }),
      ],
      ["null query entry", () => fixtureWith({ queries: [null] })],
      ["query entry missing id", () => fixtureWith({ queries: [{ vector: oneHot(0) }] })],
      [
        "query entry with a non-finite vector component",
        () => fixtureWith({ queries: [{ id: "q-1", vector: [0, Number.NaN] }] }),
      ],
    ];

    for (const [, buildFixture] of cases) {
      expect(() =>
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "frozen-embedding" },
          CORPUS,
          read(artifact()),
          readQuerySet,
          buildFixture,
        ),
      ).toThrow(RetrievalQualityConfigError);
    }
  });

  it("fails closed when retrieverFingerprints is missing or malformed", () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(artifact({ retrieverFingerprints: "nope" })),
        readQuerySet,
        readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/could not be read/);
  });

  it("fails closed on malformed artifact contents rather than attaching partial numbers", () => {
    const cases: readonly [string, RegExp][] = [
      ["not json", /not valid JSON/],
      ["[]", /must be a JSON object/],
      [artifact({ corpusContentHash: 42 }), /corpusContentHash must be a non-empty string/],
      [
        JSON.stringify({ corpusContentHash: CORPUS_HASH, queryContentHash: QUERY_SET_HASH, retrievers: "nope" }),
        /retrievers must be an object/,
      ],
    ];

    for (const [raw, pattern] of cases) {
      expect(() =>
        resolveRetrievalQualityMetrics(
          { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "1", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
          CORPUS,
          read(raw),
          readQuerySet,
          readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
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
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).not.toThrow();
  });

  it('rejects a flag value other than 1 rather than treating it as truthy', () => {
    expect(() =>
      resolveRetrievalQualityMetrics(
        { [INCLUDE_RETRIEVAL_QUALITY_ENV]: "true", [RETRIEVAL_QUALITY_RETRIEVER_ENV]: "bm25" },
        CORPUS,
        read(artifact()),
        readQuerySet,
        readEmbeddingFixture,
      ),
    ).toThrow(/must be "1" when set/);
  });
});
