import { describe, expect, it } from "vitest";

import {
  BM25_B,
  BM25_K1,
  BM25RunbookRetriever,
  DEFAULT_BM25_RETRIEVER_MIN_SCORE,
} from "./bm25-runbook-retriever";
import { validateRetrievedChunks } from "./retrieval-validation";
import type { StoredRunbookChunk } from "./runbook-retriever";

// Same multi-topic fixture shape as in-memory-runbook-retriever.test.ts — a
// small self-contained corpus, not the production Markdown-backed one (that is
// exercised end-to-end by runbooks-eval/score-query-set.ts).
const FULL_CORPUS: readonly StoredRunbookChunk[] = [
  {
    chunkId: "test-notification-degradation-001",
    runbookId: "notification-service-runbook",
    title: "Notification Service Degradation",
    content: "The notification-service reports a degraded status with delayed notification emails.",
  },
  {
    chunkId: "test-notification-queue-backlog-001",
    runbookId: "notification-queue-runbook",
    title: "Notification Queue Backlog",
    content: "A growing backlog in the notification queue causes delayed emails.",
  },
  {
    chunkId: "test-auth-failures-001",
    runbookId: "auth-failures-runbook",
    title: "Authentication Failures",
    content: "Authentication failures present as customers unable to log in.",
  },
  {
    chunkId: "test-database-connection-001",
    runbookId: "database-runbook",
    title: "Database Connection Pool Saturation",
    content:
      "Connection pool saturation presents as intermittent timeouts across services sharing the database.",
  },
  {
    chunkId: "test-billing-invoice-001",
    runbookId: "billing-runbook",
    title: "Billing Invoice Formatting",
    content:
      "Invoice PDFs sometimes misalign totals, unrelated to notification, authentication, or database issues.",
  },
];

// Two byte-identical documents under different ids — the tie-break fixture.
const TIE_CORPUS: readonly StoredRunbookChunk[] = [
  { chunkId: "chunk-b", runbookId: "runbook-1", title: "Notification Delay", content: "Notification delivery is delayed." },
  { chunkId: "chunk-a", runbookId: "runbook-1", title: "Notification Delay", content: "Notification delivery is delayed." },
  { chunkId: "chunk-c", runbookId: "runbook-2", title: "Billing Formatting", content: "Invoice PDFs sometimes misalign totals." },
];

// IDF fixture: "shared" appears in every document, "rare" in exactly one.
// Every document is the same length, so length normalization cannot be what
// separates the two terms — only IDF can.
const IDF_CORPUS: readonly StoredRunbookChunk[] = [
  { chunkId: "idf-1", runbookId: "r", title: "alpha", content: "shared rare filler filler" },
  { chunkId: "idf-2", runbookId: "r", title: "beta", content: "shared other filler filler" },
  { chunkId: "idf-3", runbookId: "r", title: "gamma", content: "shared other filler filler" },
  { chunkId: "idf-4", runbookId: "r", title: "delta", content: "shared other filler filler" },
];

describe("BM25RunbookRetriever", () => {
  it("uses the conventional BM25 parameters", () => {
    expect(BM25_K1).toBe(1.5);
    expect(BM25_B).toBe(0.75);
  });

  it("ranks a notification query's notification chunks above an irrelevant billing chunk", async () => {
    const retriever = new BM25RunbookRetriever(FULL_CORPUS);
    const results = await retriever.retrieve({ query: "notification service degradation delayed", topK: 5 });

    expect(results.length).toBeGreaterThan(0);
    const billingRank = results.find((r) => r.runbookId === "billing-runbook")?.rank;
    const notificationRanks = results.filter((r) => r.runbookId !== "billing-runbook").map((r) => r.rank);
    expect(notificationRanks.length).toBeGreaterThan(0);
    if (billingRank !== undefined) {
      expect(Math.min(...notificationRanks)).toBeLessThan(billingRank);
    }
  });

  it("is deterministic across repeated calls and across instances", async () => {
    const first = await new BM25RunbookRetriever(FULL_CORPUS).retrieve({ query: "authentication failures", topK: 3 });
    const second = await new BM25RunbookRetriever(FULL_CORPUS).retrieve({ query: "authentication failures", topK: 3 });
    expect(second).toEqual(first);
  });

  it("breaks score ties by chunkId ascending", async () => {
    const retriever = new BM25RunbookRetriever(TIE_CORPUS);
    const results = await retriever.retrieve({ query: "notification delay", topK: 5 });

    const tied = results.filter((r) => r.chunkId === "chunk-a" || r.chunkId === "chunk-b");
    expect(tied).toHaveLength(2);
    expect(tied[0]?.score).toBe(tied[1]?.score);
    expect(tied[0]?.chunkId).toBe("chunk-a");
    expect(tied[1]?.chunkId).toBe("chunk-b");
    expect(tied[0]!.rank).toBeLessThan(tied[1]!.rank);
  });

  it("enforces topK", async () => {
    const retriever = new BM25RunbookRetriever(FULL_CORPUS);
    const results = await retriever.retrieve({ query: "notification queue backlog", topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns an empty array for a query with no token overlap", async () => {
    const retriever = new BM25RunbookRetriever(FULL_CORPUS);
    expect(await retriever.retrieve({ query: "xyzzy plugh qwerty", topK: 5 })).toEqual([]);
  });

  it("returns an empty array for a query built entirely from stopwords/function words", async () => {
    // Same query-side stopword filtering as the keyword retriever (both call
    // tokenizeQuery from the shared tokenize.ts), so the #79 hotfix's
    // guarantee holds identically here.
    const retriever = new BM25RunbookRetriever(FULL_CORPUS);
    expect(await retriever.retrieve({ query: "i cannot send message to my client", topK: 5 })).toEqual([]);
  });

  it("returns an empty array for an empty corpus", async () => {
    const retriever = new BM25RunbookRetriever([]);
    expect(await retriever.retrieve({ query: "notification", topK: 3 })).toEqual([]);
  });

  it("scores a rare term higher than a term present in every document (IDF sanity)", async () => {
    const retriever = new BM25RunbookRetriever(IDF_CORPUS);
    const rare = await retriever.retrieve({ query: "rare", topK: 1 });
    const shared = await retriever.retrieve({ query: "shared", topK: 1 });

    expect(rare).toHaveLength(1);
    expect(shared.length).toBeGreaterThan(0);
    // Both queries hit idf-1 with tf = 1 and identical document length, so the
    // only difference between the two scores is the IDF factor.
    expect(rare[0]!.chunkId).toBe("idf-1");
    expect(rare[0]!.score).toBeGreaterThan(shared[0]!.score);
  });

  it("keeps the smoothed IDF non-negative for a term present in every document", async () => {
    // The unsmoothed Robertson/Sparck-Jones form goes negative once df > N/2,
    // which on a small corpus would let a common term PENALIZE a chunk that
    // contains it. The +1 smoothed form used here must not.
    const retriever = new BM25RunbookRetriever(IDF_CORPUS);
    const results = await retriever.retrieve({ query: "shared", topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.score).toBeGreaterThan(0);
  });

  it("weights title text the same as content (title is concatenated, not boosted)", async () => {
    // Two chunks with the same tokens, swapped between title and content. If a
    // title boost existed, these would score differently.
    const swapped: readonly StoredRunbookChunk[] = [
      { chunkId: "swap-a", runbookId: "r", title: "kafka lag", content: "consumer offset" },
      { chunkId: "swap-b", runbookId: "r", title: "consumer offset", content: "kafka lag" },
    ];
    const results = await new BM25RunbookRetriever(swapped).retrieve({ query: "kafka lag", topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.score).toBe(results[1]!.score);
  });

  it("applies the minScore floor to retrieve()'s real output", async () => {
    const unfiltered = await new BM25RunbookRetriever(FULL_CORPUS, 0).retrieve({
      query: "notification service degradation delayed",
      topK: 5,
    });
    expect(unfiltered.length).toBeGreaterThan(1);

    // Freeze the floor strictly between the top score and the lowest score, so
    // the filter must actually drop something without dropping everything.
    const floor = (unfiltered[0]!.score + unfiltered[unfiltered.length - 1]!.score) / 2;
    const filtered = await new BM25RunbookRetriever(FULL_CORPUS, floor).retrieve({
      query: "notification service degradation delayed",
      topK: 5,
    });

    expect(filtered.length).toBeLessThan(unfiltered.length);
    expect(filtered.length).toBeGreaterThan(0);
    for (const result of filtered) expect(result.score).toBeGreaterThanOrEqual(floor);
    // Ranks are recomputed after filtering — never the pre-filter ranks.
    expect(filtered.map((r) => r.rank)).toEqual(filtered.map((_, index) => index + 1));
  });

  it("returns nothing at all when the floor exceeds every score", async () => {
    const retriever = new BM25RunbookRetriever(FULL_CORPUS, 1000);
    expect(await retriever.retrieve({ query: "notification service degradation", topK: 5 })).toEqual([]);
  });

  it("defaults minScore to 0 (raw, pre-threshold scoring) when omitted", async () => {
    const bare = await new BM25RunbookRetriever(FULL_CORPUS).retrieve({ query: "notification", topK: 5 });
    const explicitZero = await new BM25RunbookRetriever(FULL_CORPUS, 0).retrieve({ query: "notification", topK: 5 });
    expect(bare).toEqual(explicitZero);
  });

  it("exports a frozen default threshold constant", () => {
    expect(Number.isFinite(DEFAULT_BM25_RETRIEVER_MIN_SCORE)).toBe(true);
    expect(DEFAULT_BM25_RETRIEVER_MIN_SCORE).toBeGreaterThan(0);
  });

  it("always returns output that passes the shared retrieval validator", async () => {
    const retriever = new BM25RunbookRetriever(FULL_CORPUS);
    for (const query of ["notification", "authentication failures", "database connection", "billing invoice"]) {
      const results = await retriever.retrieve({ query, topK: 5 });
      expect(validateRetrievedChunks(results, 5)).toBeNull();
    }
  });
});
