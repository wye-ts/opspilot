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
