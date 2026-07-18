import { describe, expect, it } from "vitest";

import { InMemoryKeywordRunbookRetriever } from "./in-memory-runbook-retriever";
import { RUNBOOK_CORPUS } from "./runbook-corpus";
import { validateRetrievedChunks } from "./retrieval-validation";
import type { StoredRunbookChunk } from "./runbook-retriever";

const TEST_CORPUS: readonly StoredRunbookChunk[] = [
  {
    chunkId: "chunk-b",
    runbookId: "runbook-1",
    title: "Notification Delay",
    content: "Notification delivery is delayed.",
  },
  {
    chunkId: "chunk-a",
    runbookId: "runbook-1",
    title: "Notification Delay",
    content: "Notification delivery is delayed.",
  },
  {
    chunkId: "chunk-c",
    runbookId: "runbook-2",
    title: "Billing Formatting",
    content: "Invoice PDFs sometimes misalign totals.",
  },
];

describe("InMemoryKeywordRunbookRetriever", () => {
  it("ranks a notification query's notification chunks above an irrelevant billing chunk", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(RUNBOOK_CORPUS);
    const results = await retriever.retrieve({
      query: "notification service degradation delayed",
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    const billingRank = results.find((r) => r.runbookId === "billing-runbook")?.rank;
    const notificationRanks = results
      .filter((r) => r.runbookId !== "billing-runbook")
      .map((r) => r.rank);
    expect(notificationRanks.length).toBeGreaterThan(0);
    if (billingRank !== undefined) {
      expect(Math.min(...notificationRanks)).toBeLessThan(billingRank);
    }
  });

  it("is deterministic across repeated calls", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(RUNBOOK_CORPUS);
    const first = await retriever.retrieve({ query: "authentication failures", topK: 3 });
    const second = await retriever.retrieve({ query: "authentication failures", topK: 3 });
    expect(second).toEqual(first);
  });

  it("breaks score ties by chunkId ascending", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(TEST_CORPUS);
    const results = await retriever.retrieve({ query: "notification delay", topK: 5 });

    const tied = results.filter((r) => r.chunkId === "chunk-a" || r.chunkId === "chunk-b");
    expect(tied).toHaveLength(2);
    expect(tied[0]?.chunkId).toBe("chunk-a");
    expect(tied[1]?.chunkId).toBe("chunk-b");
    expect(tied[0]?.rank).toBeLessThan(tied[1]!.rank);
  });

  it("enforces topK", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(RUNBOOK_CORPUS);
    const results = await retriever.retrieve({ query: "notification queue backlog", topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns an empty array for a query with no token overlap", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(RUNBOOK_CORPUS);
    const results = await retriever.retrieve({ query: "xyzzy plugh qwerty", topK: 5 });
    expect(results).toEqual([]);
  });

  it("always returns output that passes the shared retrieval validator", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(RUNBOOK_CORPUS);
    const queries = ["notification", "authentication failures", "database connection", "billing invoice"];
    for (const query of queries) {
      const results = await retriever.retrieve({ query, topK: 5 });
      expect(validateRetrievedChunks(results, 5)).toBeNull();
    }
  });
});
