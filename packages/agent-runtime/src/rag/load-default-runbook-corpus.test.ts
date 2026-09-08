import { describe, expect, it } from "vitest";

import { loadDefaultRunbookCorpus, resolveDefaultRunbooksDir } from "./load-default-runbook-corpus";

// The ORIGINAL seven chunk ids migrated from the pre-#72 TypeScript corpus.
// Deliberately NOT extended when the corpus grows (issue #74): this constant is
// the sole input to the "no line breaks in any of the seven migrated chunk
// bodies" test below, a migration-fidelity constraint that applies only to
// these seven. Full-corpus assertions use ALL_EXPECTED_CHUNK_IDS instead — the
// two constants must never be merged.
const EXPECTED_CHUNK_IDS = [
  "runbook-notification-degradation-001",
  "runbook-notification-queue-backlog-001",
  "runbook-notification-queue-backlog-002",
  "runbook-auth-failures-001",
  "runbook-auth-failures-002",
  "runbook-database-connection-saturation-001",
  "runbook-billing-invoice-formatting-001",
];

// Issue #74: the seventeen chunk ids added by the eleven new runbook files,
// which exist to give the retrieval-quality query set (runbooks-eval/) real
// near-miss and true-negative targets to discriminate against.
const NEW_CHUNK_IDS = [
  "runbook-notification-rate-limit-001",
  "runbook-notification-rate-limit-002",
  "runbook-identity-provider-outage-001",
  "runbook-identity-provider-outage-002",
  "runbook-datastore-replica-lag-001",
  "runbook-datastore-replica-lag-002",
  "runbook-public-api-rate-limit-001",
  "runbook-public-api-rate-limit-002",
  "runbook-deployment-rollback-001",
  "runbook-deployment-rollback-002",
  "runbook-cache-invalidation-001",
  "runbook-webhook-delivery-001",
  "runbook-search-index-staleness-001",
  "runbook-search-index-staleness-002",
  "runbook-search-query-latency-001",
  "runbook-storage-quota-exhaustion-001",
  "runbook-storage-upload-corruption-001",
];

// The full expanded corpus: the original seven plus the seventeen new ids.
// Used only by the file-count/chunk-count/full-id-set assertions below.
const ALL_EXPECTED_CHUNK_IDS = [...EXPECTED_CHUNK_IDS, ...NEW_CHUNK_IDS];

describe("resolveDefaultRunbooksDir", () => {
  it("resolves to a path ending in /runbooks", () => {
    expect(resolveDefaultRunbooksDir()).toMatch(/[/\\]runbooks$/);
  });
});

describe("loadDefaultRunbookCorpus", () => {
  it("loads the real repository runbooks directory: 16 files, 24 chunks, all expected IDs", async () => {
    const result = await loadDefaultRunbookCorpus();

    expect(result.sourceFileCount).toBe(16);
    expect(result.chunks).toHaveLength(24);
    expect(result.chunks.map((chunk) => chunk.chunkId).sort()).toEqual(
      [...ALL_EXPECTED_CHUNK_IDS].sort(),
    );
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

  // Issue #74 regression guard for the constant split above. The
  // no-line-break rule is a migration-fidelity constraint scoped to the
  // original seven chunks only; the new runbook files deliberately wrap their
  // paragraph bodies across physical Markdown lines, so their loaded content
  // DOES embed "\n". If someone ever merges NEW_CHUNK_IDS into
  // EXPECTED_CHUNK_IDS (or points the no-line-break test at
  // ALL_EXPECTED_CHUNK_IDS), that test would start failing on these chunks —
  // this test states the intended asymmetry explicitly so the split is a
  // documented invariant rather than an accident of ordering.
  it("keeps the no-line-break check scoped to the migrated seven: at least one new chunk does contain a line break and is excluded from it", async () => {
    const result = await loadDefaultRunbookCorpus();

    const newChunks = result.chunks.filter((chunk) => NEW_CHUNK_IDS.includes(chunk.chunkId));
    expect(newChunks).toHaveLength(NEW_CHUNK_IDS.length);

    const wrapped = newChunks.filter((chunk) => chunk.content.includes("\n"));
    expect(wrapped.length).toBeGreaterThan(0);

    for (const chunk of wrapped) {
      expect(EXPECTED_CHUNK_IDS).not.toContain(chunk.chunkId);
    }
  });
});
