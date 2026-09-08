/**
 * Issue #76 §2.5 — the single source of truth for the frozen-embedding
 * candidate's EXPECTED embeddingModel/dimensions, independent of whatever
 * embedding-fixture.json itself claims. Every consumer (calibrate-min-score.ts,
 * score-query-set.ts, and this candidate's own retriever-fingerprints.ts
 * entry) imports these two constants rather than re-declaring literals or
 * trusting the fixture's own self-reported metadata (plan §0 fix 2's
 * independently-derived-values requirement).
 *
 * Matches apps/worker's own defaults exactly (EMBEDDING_MODEL default in
 * apps/worker/src/demo/run-rag-live-spike.ts's resolveEmbeddingModel(); the
 * 1024-dimension default in that same file's resolveEmbeddingDimensions()) —
 * the same defaults generate-embedding-fixture.ts used to produce the
 * currently-committed embedding-fixture.json. Changing either requires
 * regenerating the fixture AND updating these constants together; a
 * mismatch is exactly what FixtureBackedRunbookRetriever's staleness check
 * (plan §2.2) is designed to catch.
 */
export const EMBEDDING_MODEL = "voyage-4-lite";
export const EMBEDDING_DIMENSIONS = 1024;
