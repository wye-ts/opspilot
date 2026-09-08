import { describe, expect, it } from "vitest";

import { cosineSimilarity, l2Norm } from "./cosine-similarity";

// ---------------------------------------------------------------------------
// Issue #76 §0 fix 1 / §2.3: the extraction of cosineSimilarity()/l2Norm() out
// of apps/worker/src/rag/voyage-runbook-retriever.ts into this shared package
// file must be a pure move — the retriever's observable ranking behavior must
// be byte-for-byte unchanged. FROZEN_* below are verbatim copies of the
// pre-extraction implementations, kept as a frozen oracle so any future edit
// to cosine-similarity.ts that changes behavior fails here.
// ---------------------------------------------------------------------------

function frozenL2Norm(vector: readonly number[]): number {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  return Math.sqrt(sumSquares);
}

function frozenCosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (frozenL2Norm(a) * frozenL2Norm(b));
}

const VECTOR_PAIRS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [[1, 0], [0, 1]],
  [[1, 0], [1, 0]],
  [[1, 2, 3], [4, 5, 6]],
  [[-1, -2, -3], [1, 2, 3]],
  [[0.1, 0.2, 0.3, 0.4], [0.4, 0.3, 0.2, 0.1]],
  [[3, 4], [3, 4]],
  [[1, 1, 1, 1, 1], [1, -1, 1, -1, 1]],
];

describe("cosine-similarity (relocated from voyage-runbook-retriever.ts)", () => {
  it("l2Norm matches the frozen pre-extraction implementation for real vectors", () => {
    for (const [a] of VECTOR_PAIRS) {
      expect(l2Norm(a)).toBeCloseTo(frozenL2Norm(a), 12);
    }
  });

  it("cosineSimilarity matches the frozen pre-extraction implementation for real vector pairs", () => {
    for (const [a, b] of VECTOR_PAIRS) {
      expect(cosineSimilarity(a, b)).toBeCloseTo(frozenCosineSimilarity(a, b), 12);
    }
  });

  it("returns 1 for identical vectors and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it("returns -1 for exactly opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 12);
  });
});
