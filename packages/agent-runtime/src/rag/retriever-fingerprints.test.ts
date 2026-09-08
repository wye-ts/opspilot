import { describe, expect, it } from "vitest";

import {
  computeEmbeddingFixturePayloadHash,
  computeFrozenEmbeddingFingerprint,
  type EmbeddingFixtureFingerprintInput,
} from "./retriever-fingerprints";

const baseFixture: EmbeddingFixtureFingerprintInput = {
  embeddingModel: "voyage-4-lite",
  dimensions: 1024,
  corpusContentHash: "corpus-hash",
  queryContentHash: "query-hash",
  vectorPayloadHash: "vector-hash",
};

describe("computeFrozenEmbeddingFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeFrozenEmbeddingFingerprint(baseFixture, 0.41)).toBe(
      computeFrozenEmbeddingFingerprint({ ...baseFixture }, 0.41),
    );
  });

  it("changes when minScore changes, fixture metadata unchanged (§0a fix 3 regression test)", () => {
    const before = computeFrozenEmbeddingFingerprint(baseFixture, 0.41);
    const after = computeFrozenEmbeddingFingerprint(baseFixture, 0.5);
    expect(after).not.toBe(before);
  });

  it("changes when vectorPayloadHash changes, all other fields unchanged", () => {
    const before = computeFrozenEmbeddingFingerprint(baseFixture, 0.41);
    const after = computeFrozenEmbeddingFingerprint({ ...baseFixture, vectorPayloadHash: "different-hash" }, 0.41);
    expect(after).not.toBe(before);
  });

  it("changes when embeddingModel or dimensions changes", () => {
    const before = computeFrozenEmbeddingFingerprint(baseFixture, 0.41);
    expect(computeFrozenEmbeddingFingerprint({ ...baseFixture, embeddingModel: "voyage-4" }, 0.41)).not.toBe(before);
    expect(computeFrozenEmbeddingFingerprint({ ...baseFixture, dimensions: 512 }, 0.41)).not.toBe(before);
  });
});

describe("computeEmbeddingFixturePayloadHash", () => {
  const chunks = [
    { chunkId: "b", vector: [0, 1] },
    { chunkId: "a", vector: [1, 0] },
  ];
  const queries = [
    { id: "q2", vector: [0.5, 0.5] },
    { id: "q1", vector: [0.9, 0.1] },
  ];

  it("is deterministic and order-independent (sorted internally by id)", () => {
    const hash1 = computeEmbeddingFixturePayloadHash(chunks, queries);
    const hash2 = computeEmbeddingFixturePayloadHash([...chunks].reverse(), [...queries].reverse());
    expect(hash1).toBe(hash2);
  });

  it("changes when a single vector coordinate is mutated, everything else held constant (§0 fix 3 regression test)", () => {
    const before = computeEmbeddingFixturePayloadHash(chunks, queries);
    const mutatedChunks = [
      { chunkId: "b", vector: [0, 1] },
      { chunkId: "a", vector: [1, 0.0001] }, // one coordinate nudged
    ];
    const after = computeEmbeddingFixturePayloadHash(mutatedChunks, queries);
    expect(after).not.toBe(before);
  });
});
