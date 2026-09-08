import { createHash } from "node:crypto";

import type { StoredRunbookChunk } from "./runbook-retriever";

// Issue #75 §2.1a — the single implementation of the corpus freshness hash.
//
// It lives in the shared package, not in runbooks-eval/, because TWO
// independent processes must compute it IDENTICALLY for the freshness check to
// mean anything: runbooks-eval/score-query-set.ts (which stamps it into
// query-set-scores.json) and apps/worker's eval CLI (which re-derives it from
// its own freshly-loaded corpus at run time and refuses a stale artifact). A
// second copy in either place would defeat the check the first time one of
// them was edited. runbooks-eval/ is a CommonJS fixture directory and
// apps/worker is genuine ESM, so a direct import between the two is not
// available either way — the shared package is the seam both already use.
//
// It hashes the LOADED corpus's own content, not the on-disk Markdown: what
// affects a retrieval score is what the loader produced, so a loader/chunking
// change is caught as well as a prose edit. Field order and chunk order are
// both fixed explicitly, so the hash never depends on filesystem enumeration
// order or object key insertion order.
export function computeCorpusContentHash(corpus: readonly StoredRunbookChunk[]): string {
  const canonical = [...corpus]
    .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
    .map((chunk) =>
      JSON.stringify({
        chunkId: chunk.chunkId,
        runbookId: chunk.runbookId,
        title: chunk.title,
        content: chunk.content,
        serviceSlug: chunk.serviceSlug ?? null,
        category: chunk.category ?? null,
      }),
    )
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// Issue #76 §2.2 / §0 fix 2 — a general-purpose raw-bytes SHA-256 helper,
// added here (alongside computeCorpusContentHash) rather than as a new
// module, so every place that needs to hash arbitrary text (today:
// retrieval-query-set.json's own bytes, previously computed via a LOCAL,
// inline sha256() inside runbooks-eval/score-query-set.ts) uses the exact
// same implementation. Two independently-written sha256(text) functions
// that happen to agree today are exactly the kind of drift this shared
// package's other hash/fingerprint helpers already exist to prevent.
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
