// Issue #76 §0 fix 1 / §2.3 — relocated from apps/worker/src/rag/voyage-runbook-retriever.ts.
// Pure, provider-neutral cosine-similarity math with zero SDK dependency —
// every retriever that ranks by cosine similarity (VoyageRunbookRetriever's
// live embeddings, FixtureBackedRunbookRetriever's frozen embeddings) needs
// the identical implementation, and duplicating floating-point-sensitive
// math in two places is exactly the kind of drift corpus-content-hash.ts's
// and retriever-fingerprints.ts's own "single shared implementation"
// rationale already warns against. Lives in the shared package (not
// apps/worker) because packages/agent-runtime is the one place both an
// ESM app (apps/worker) and this issue's fixture-backed retriever can
// import identical code from without a module-system or dependency-
// direction violation (see this issue's plan §0 fix 1 for the full
// module-boundary analysis).
export function l2Norm(vector: readonly number[]): number {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  return Math.sqrt(sumSquares);
}

// score is application-computed from provider-returned or fixture-frozen
// vectors, never a raw provider value.
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (l2Norm(a) * l2Norm(b));
}
