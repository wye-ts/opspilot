import { describe, expect, it } from "vitest";

import { computeCorpusContentHash, sha256 } from "./corpus-content-hash";
import { cosineSimilarity } from "./cosine-similarity";
import { FixtureBackedRunbookRetriever, type FixtureQueryRecord } from "./fixture-backed-runbook-retriever";
import type { StoredRunbookChunk } from "./runbook-retriever";

const corpus: readonly StoredRunbookChunk[] = [
  { chunkId: "a", runbookId: "r1", title: "A", content: "Content A" },
  { chunkId: "b", runbookId: "r1", title: "B", content: "Content B" },
];

const queries: readonly FixtureQueryRecord[] = [
  { id: "q1", query: "match a" },
  { id: "q2", query: "match b" },
];

const RAW_QUERY_SET_TEXT = '{"queries":["fixture text"]}';
const MODEL = "voyage-4-lite";
const DIMENSIONS = 2;

// a -> [1,0], b -> [0,1]; q1 -> [1,0] (matches a exactly), q2 -> [0,1] (matches b exactly).
function buildValidFixture(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    embeddingModel: MODEL,
    dimensions: DIMENSIONS,
    corpusContentHash: computeCorpusContentHash(corpus),
    queryContentHash: sha256(RAW_QUERY_SET_TEXT),
    chunks: [
      { chunkId: "a", vector: [1, 0] },
      { chunkId: "b", vector: [0, 1] },
    ],
    queries: [
      { id: "q1", vector: [1, 0] },
      { id: "q2", vector: [0, 1] },
    ],
    ...overrides,
  };
}

function buildRetriever(
  fixture: unknown,
  minScore: number,
  opts: { corpus?: readonly StoredRunbookChunk[]; queries?: readonly FixtureQueryRecord[]; rawQuerySetText?: string; model?: string; dimensions?: number } = {},
): FixtureBackedRunbookRetriever {
  return new FixtureBackedRunbookRetriever(
    opts.corpus ?? corpus,
    opts.queries ?? queries,
    opts.rawQuerySetText ?? RAW_QUERY_SET_TEXT,
    fixture,
    opts.model ?? MODEL,
    opts.dimensions ?? DIMENSIONS,
    minScore,
  );
}

describe("FixtureBackedRunbookRetriever", () => {
  it("constructs successfully against a well-formed, current fixture", () => {
    expect(() => buildRetriever(buildValidFixture(), 0)).not.toThrow();
  });

  it("retrieve() for a fixture query returns ranked results identical to hand-computed cosine similarity", async () => {
    const retriever = buildRetriever(buildValidFixture(), -1);
    const results = await retriever.retrieve({ query: "match a", topK: 2 });

    expect(results[0]?.chunkId).toBe("a");
    expect(results[0]?.score).toBeCloseTo(cosineSimilarity([1, 0], [1, 0]), 12);
    expect(results[0]?.rank).toBe(1);
    expect(results[1]?.chunkId).toBe("b");
    expect(results[1]?.score).toBeCloseTo(cosineSimilarity([1, 0], [0, 1]), 12);
    expect(results[1]?.rank).toBe(2);
  });

  it("retrieve() for a query NOT in the fixture throws REQUEST_INVALID, never falls back to a live call", async () => {
    const retriever = buildRetriever(buildValidFixture(), 0);
    await expect(retriever.retrieve({ query: "not a fixture query", topK: 2 })).rejects.toMatchObject({
      category: "REQUEST_INVALID",
    });
  });

  it("throws the fixture-stale error when constructed against a corpus whose content hash disagrees", () => {
    const differentCorpus: readonly StoredRunbookChunk[] = [
      { chunkId: "a", runbookId: "r1", title: "A", content: "DIFFERENT CONTENT" },
      { chunkId: "b", runbookId: "r1", title: "B", content: "Content B" },
    ];
    expect(() => buildRetriever(buildValidFixture(), 0, { corpus: differentCorpus })).toThrow(/fixture stale/);
  });

  it("throws the fixture-stale error when constructed against query-set text whose hash disagrees", () => {
    expect(() =>
      buildRetriever(buildValidFixture(), 0, { rawQuerySetText: '{"queries":["different text"]}' }),
    ).toThrow(/fixture stale/);
  });

  it("throws the fixture-stale error when the expected embeddingModel disagrees with the fixture's stored value", () => {
    expect(() => buildRetriever(buildValidFixture(), 0, { model: "voyage-4" })).toThrow(/fixture stale/);
  });

  it("throws the fixture-stale error when the expected dimensions disagrees with the fixture's stored value", () => {
    expect(() => buildRetriever(buildValidFixture(), 0, { dimensions: 4 })).toThrow(/fixture stale/);
  });

  it("throws a structural-validation error for a duplicate chunk id", () => {
    const fixture = buildValidFixture({
      chunks: [
        { chunkId: "a", vector: [1, 0] },
        { chunkId: "a", vector: [0, 1] },
      ],
    });
    expect(() => buildRetriever(fixture, 0)).toThrow(/duplicate chunk id/);
  });

  it("throws a structural-validation error for a missing chunk (fixture id set doesn't match corpus)", () => {
    const fixture = buildValidFixture({ chunks: [{ chunkId: "a", vector: [1, 0] }] });
    expect(() => buildRetriever(fixture, 0)).toThrow(/does not exactly match the current corpus/);
  });

  it("throws a structural-validation error for an orphan chunk (fixture has an id the corpus no longer has)", () => {
    const fixture = buildValidFixture({
      chunks: [
        { chunkId: "a", vector: [1, 0] },
        { chunkId: "b", vector: [0, 1] },
        { chunkId: "orphan", vector: [1, 1] },
      ],
    });
    expect(() => buildRetriever(fixture, 0)).toThrow(/does not exactly match the current corpus/);
  });

  it("throws a structural-validation error for a wrong-length vector", () => {
    const fixture = buildValidFixture({
      chunks: [
        { chunkId: "a", vector: [1, 0, 0] },
        { chunkId: "b", vector: [0, 1] },
      ],
    });
    expect(() => buildRetriever(fixture, 0)).toThrow(/malformed vector/);
  });

  it("throws a structural-validation error for a non-finite value in a vector", () => {
    const fixture = buildValidFixture({
      chunks: [
        { chunkId: "a", vector: [Number.NaN, 0] },
        { chunkId: "b", vector: [0, 1] },
      ],
    });
    expect(() => buildRetriever(fixture, 0)).toThrow(/malformed vector/);
  });

  it("throws a structural-validation error for a zero-norm vector", () => {
    const fixture = buildValidFixture({
      chunks: [
        { chunkId: "a", vector: [0, 0] },
        { chunkId: "b", vector: [0, 1] },
      ],
    });
    expect(() => buildRetriever(fixture, 0)).toThrow(/zero-norm vector/);
  });

  it("throws a structural-validation error for a missing query id (fixture doesn't cover the current query set)", () => {
    const fixture = buildValidFixture({ queries: [{ id: "q1", vector: [1, 0] }] });
    expect(() => buildRetriever(fixture, 0)).toThrow(/does not exactly match the current query set/);
  });

  it("applies the constructor-supplied minScore as a real, enforced filtering floor", async () => {
    const retriever = buildRetriever(buildValidFixture(), 0.5);
    // q1's vector [1,0] against a=[1,0] (cosine 1, passes) and b=[0,1] (cosine 0, filtered out).
    const results = await retriever.retrieve({ query: "match a", topK: 2 });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunkId).toBe("a");
  });

  it("with minScore 0, still returns the true unthresholded score for calibration's rawScore() lookup", async () => {
    // b's vector [0,1] against query [1,0] (orthogonal, cosine 0) — minScore
    // 0 must NOT structurally exclude a 0-scoring chunk the way keyword/BM25
    // do, or calibration's rawScore() would silently see 0 as "not found"
    // instead of a genuine raw score of exactly 0 (plan §0a fix 1).
    const retriever = buildRetriever(buildValidFixture(), 0);
    const results = await retriever.retrieve({ query: "match a", topK: 2 });
    const bEntry = results.find((entry) => entry.chunkId === "b");
    expect(bEntry).toBeDefined();
    expect(bEntry?.score).toBeCloseTo(0, 12);
  });
});
