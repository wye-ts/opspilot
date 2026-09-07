import { describe, expect, it } from "vitest";

import { loadDefaultRunbookCorpus, resolveDefaultRunbooksDir } from "./load-default-runbook-corpus";

const EXPECTED_CHUNK_IDS = [
  "runbook-notification-degradation-001",
  "runbook-notification-queue-backlog-001",
  "runbook-notification-queue-backlog-002",
  "runbook-auth-failures-001",
  "runbook-auth-failures-002",
  "runbook-database-connection-saturation-001",
  "runbook-billing-invoice-formatting-001",
];

describe("resolveDefaultRunbooksDir", () => {
  it("resolves to a path ending in /runbooks", () => {
    expect(resolveDefaultRunbooksDir()).toMatch(/[/\\]runbooks$/);
  });
});

describe("loadDefaultRunbookCorpus", () => {
  it("loads the real repository runbooks directory: 5 files, 7 chunks, all expected IDs", async () => {
    const result = await loadDefaultRunbookCorpus();

    expect(result.sourceFileCount).toBe(5);
    expect(result.chunks).toHaveLength(7);
    expect(result.chunks.map((chunk) => chunk.chunkId).sort()).toEqual([...EXPECTED_CHUNK_IDS].sort());
  });

  it("is deterministic across repeated loads", async () => {
    const first = await loadDefaultRunbookCorpus();
    const second = await loadDefaultRunbookCorpus();
    expect(second).toEqual(first);
  });

  it("every chunk has non-empty required fields", async () => {
    const result = await loadDefaultRunbookCorpus();
    for (const chunk of result.chunks) {
      expect(chunk.chunkId.trim().length).toBeGreaterThan(0);
      expect(chunk.runbookId.trim().length).toBeGreaterThan(0);
      expect(chunk.title.trim().length).toBeGreaterThan(0);
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("covers the four required topics plus the billing control topic", async () => {
    const result = await loadDefaultRunbookCorpus();
    const titles = result.chunks.map((chunk) => chunk.title.toLowerCase());

    expect(titles.some((title) => title.includes("notification"))).toBe(true);
    expect(titles.some((title) => title.includes("queue backlog"))).toBe(true);
    expect(titles.some((title) => title.includes("authentication"))).toBe(true);
    expect(titles.some((title) => title.includes("database connection"))).toBe(true);
    expect(result.chunks.some((chunk) => chunk.runbookId === "billing-runbook")).toBe(true);
  });

  // The pre-migration TypeScript corpus stored each chunk body as one
  // continuous string (string-literal concatenation, no embedded newlines).
  // The Markdown source now wraps each paragraph across physical lines in
  // some files, and the loader's chunk content is built via
  // `contentLines.join("\n")` — so a body that spans multiple physical
  // Markdown lines would embed "\n" into the loaded content, changing the
  // exact text sent to a retriever/embedding client. Each of these seven
  // migrated chunks' Markdown source is a single physical body line, so no
  // such line break should ever reach the loaded content. Deliberately does
  // not duplicate the seven full bodies here — see the loader's own
  // exact-string comparison performed manually against
  // `git show HEAD:apps/worker/src/rag/runbook-corpus.ts` during migration.
  it("contains no line breaks in any of the seven migrated chunk bodies", async () => {
    const result = await loadDefaultRunbookCorpus();

    const migrated = result.chunks.filter((chunk) => EXPECTED_CHUNK_IDS.includes(chunk.chunkId));
    expect(migrated).toHaveLength(EXPECTED_CHUNK_IDS.length);

    for (const chunk of migrated) {
      expect(chunk.content).not.toContain("\n");
    }
  });
});
