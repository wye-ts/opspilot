import { createHash } from "node:crypto";

import { DEFAULT_BM25_RETRIEVER_MIN_SCORE, BM25_K1, BM25_B } from "./bm25-runbook-retriever";
import { DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE } from "./in-memory-runbook-retriever";

// Issue #75 §2.1a / round-2-of-codex-review MAJOR fix — the single
// implementation of each retriever's configuration fingerprint, and the
// single source of truth for what "the current retriever configuration"
// means. It lives in the shared package for the same reason
// corpus-content-hash.ts does: TWO independent processes must compute it
// IDENTICALLY for the freshness check to mean anything —
// runbooks-eval/score-query-set.ts (which stamps fingerprints into
// query-set-scores.json) and apps/worker's eval CLI (which must compare the
// artifact's stored fingerprint against the CURRENT configuration before
// trusting the artifact's numbers, not merely check the corpus hash — a
// config-only change, e.g. editing BM25_K1 or a frozen minScore constant,
// changes retrieval behavior without changing the corpus at all, and the
// corpus-hash check alone cannot catch that class of staleness).
//
// A hash of a retriever's effective, score-affecting configuration: its
// class name, its enforced threshold, and every tunable parameter. Changing
// k1/b or a frozen threshold changes this, which invalidates any artifact
// stamped with the old value.
export function computeRetrieverFingerprint(
  className: string,
  minScore: number,
  params: Readonly<Record<string, number>>,
): string {
  return createHash("sha256").update(JSON.stringify({ className, minScore, params }), "utf8").digest("hex");
}

// The CURRENT fingerprint for every retriever this issue ships, computed
// once from the live frozen constants — never a value copied by hand into
// two places that could drift. Both score-query-set.ts (to stamp the
// artifact) and retrieval-quality-config.ts (to validate it) import this
// same map rather than each recomputing their own guess at "current." Keyed
// by literal retriever name (not a generic Record<string, string>) so a
// known candidate's fingerprint is typed as `string`, never
// `string | undefined`, at every call site that indexes by a literal key —
// an unknown/runtime-supplied name (e.g. from EVALUATION_RETRIEVAL_QUALITY_RETRIEVER)
// still correctly types as possibly-undefined when indexed dynamically.
export const CURRENT_RETRIEVER_FINGERPRINTS: Readonly<Record<"keyword" | "bm25", string>> & Readonly<Record<string, string>> = {
  keyword: computeRetrieverFingerprint("InMemoryKeywordRunbookRetriever", DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE, {
    titleWeight: 2,
    contentWeight: 1,
  }),
  bm25: computeRetrieverFingerprint("BM25RunbookRetriever", DEFAULT_BM25_RETRIEVER_MIN_SCORE, {
    k1: BM25_K1,
    b: BM25_B,
  }),
};

// Issue #76 §2.5 — the frozen-embedding candidate's fingerprint is
// deliberately NOT a third entry in CURRENT_RETRIEVER_FINGERPRINTS above,
// because (unlike keyword/BM25's pure in-code constants) its configuration
// depends on the CONTENTS of an external fixture file
// (runbooks-eval/embedding-fixture.json) that this module — re-exported
// through packages/agent-runtime's public index.ts, which apps/api's
// production code already imports from — must stay safe to import without
// ever performing file I/O at module-evaluation time (plan §0 fix 1's
// Dockerfile-boundary analysis: the production image never ships
// runbooks-eval/, so a top-level read of that file here would crash
// container startup). Instead, this is a PURE function: callers that have
// already loaded and validated the fixture (runbooks-eval/score-query-set.ts,
// apps/worker's retrieval-quality-config.ts, both of which already read
// files) pass its metadata in.
//
// `minScore` is a required parameter, not folded into `fixture` (round-2
// Codex-review MAJOR fix — verified: the first draft's signature took only
// fixture-derived fields, so freezing a new DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE
// value after query-set-scores.json was generated left this fingerprint —
// and therefore the runtime freshness check — unchanged, silently accepting
// stale falsePositiveRate/recall numbers computed under the old threshold).
// Mirrors exactly how computeRetrieverFingerprint() already folds minScore
// into keyword's/BM25's own fingerprints above — the same rule applied to
// the third retriever, not a new one.
export interface EmbeddingFixtureFingerprintInput {
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly corpusContentHash: string;
  readonly queryContentHash: string;
  readonly vectorPayloadHash: string;
}

export function computeFrozenEmbeddingFingerprint(
  fixture: EmbeddingFixtureFingerprintInput,
  minScore: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        className: "FixtureBackedRunbookRetriever",
        minScore,
        embeddingModel: fixture.embeddingModel,
        dimensions: fixture.dimensions,
        corpusContentHash: fixture.corpusContentHash,
        queryContentHash: fixture.queryContentHash,
        vectorPayloadHash: fixture.vectorPayloadHash,
      }),
      "utf8",
    )
    .digest("hex");
}

// Issue #76 §2.5 / §0 fix 3 — a canonical hash of the fixture's own vector
// PAYLOAD (as opposed to its metadata, which corpusContentHash/queryContentHash/
// embeddingModel/dimensions already cover). A single vector-coordinate edit
// with every metadata field held constant is otherwise undetectable: this
// is the missing piece that makes such an edit change the fingerprint.
// Sorted by id (chunk, then query) so the hash never depends on array order.
export function computeEmbeddingFixturePayloadHash(
  chunks: readonly { readonly chunkId: string; readonly vector: readonly number[] }[],
  queries: readonly { readonly id: string; readonly vector: readonly number[] }[],
): string {
  const canonicalChunks = [...chunks]
    .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
    .map((entry) => ({ chunkId: entry.chunkId, vector: entry.vector }));
  const canonicalQueries = [...queries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, vector: entry.vector }));
  return createHash("sha256")
    .update(JSON.stringify({ chunks: canonicalChunks, queries: canonicalQueries }), "utf8")
    .digest("hex");
}
