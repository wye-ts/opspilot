import opspilotAgentRuntime from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";

import { InMemoryKeywordRunbookRetriever } from "./in-memory-runbook-retriever";
import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

const { validateRetrievedChunks } = opspilotAgentRuntime;

// A small, self-contained, multi-topic fixture — not the production
// Markdown-backed corpus (see load-default-runbook-corpus.test.ts for that),
// matching the pattern voyage-runbook-retriever.test.ts already uses. Topics
// mirror the real corpus's shape closely enough to exercise realistic
// cross-topic ranking behavior.
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
    const retriever = new InMemoryKeywordRunbookRetriever(FULL_CORPUS);
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
    const retriever = new InMemoryKeywordRunbookRetriever(FULL_CORPUS);
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
    const retriever = new InMemoryKeywordRunbookRetriever(FULL_CORPUS);
    const results = await retriever.retrieve({ query: "notification queue backlog", topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns an empty array for a query with no token overlap", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(FULL_CORPUS);
    const results = await retriever.retrieve({ query: "xyzzy plugh qwerty", topK: 5 });
    expect(results).toEqual([]);
  });

  it("always returns output that passes the shared retrieval validator", async () => {
    const retriever = new InMemoryKeywordRunbookRetriever(FULL_CORPUS);
    const queries = ["notification", "authentication failures", "database connection", "billing invoice"];
    for (const query of queries) {
      const results = await retriever.retrieve({ query, topK: 5 });
      expect(validateRetrievedChunks(results, 5)).toBeNull();
    }
  });
});
