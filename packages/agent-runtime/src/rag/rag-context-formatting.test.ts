import { describe, expect, it } from "vitest";

import { formatRagContext } from "./rag-context-formatting";
import { INJECTION_PROBE_CHUNK } from "./injection-probe-fixture";
import type { RetrievedRunbookChunk } from "./runbook-retriever";

function chunk(overrides: Partial<RetrievedRunbookChunk> = {}): RetrievedRunbookChunk {
  return {
    chunkId: "runbook-example-001",
    runbookId: "example-runbook",
    title: "Example",
    content: "Example content.",
    score: 2,
    rank: 1,
    ...overrides,
  };
}

describe("formatRagContext", () => {
  it("preserves the exact evidenceId (=== chunkId), copied verbatim", () => {
    const [entry] = formatRagContext([chunk({ chunkId: "runbook-notification-degradation-001" })]);
    expect(entry?.evidenceId).toBe("runbook-notification-degradation-001");
  });

  it("produces the exact RAG_CHUNK shape", () => {
    const [entry] = formatRagContext([
      chunk({
        chunkId: "id-1",
        runbookId: "runbook-1",
        title: "Title 1",
        content: "Content 1",
      }),
    ]);
    expect(entry).toEqual({
      evidenceId: "id-1",
      sourceType: "RAG_CHUNK",
      runbookId: "runbook-1",
      title: "Title 1",
      content: "Content 1",
    });
  });

  it("preserves order and count exactly for valid input", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1 }),
      chunk({ chunkId: "b", rank: 2 }),
      chunk({ chunkId: "c", rank: 3 }),
    ];
    const entries = formatRagContext(chunks);
    expect(entries.map((e) => e.evidenceId)).toEqual(["a", "b", "c"]);
    expect(entries).toHaveLength(3);
  });

  it("does NOT deduplicate duplicate chunkIds — it is a strict one-to-one map", () => {
    // Upstream validation (validateRetrievedChunks) is the only place
    // duplicates are supposed to be rejected; this proves formatRagContext
    // itself performs no silent Set-based deduplication.
    const chunks = [chunk({ chunkId: "dup", rank: 1 }), chunk({ chunkId: "dup", rank: 1 })];
    const entries = formatRagContext(chunks);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.evidenceId).toBe("dup");
    expect(entries[1]?.evidenceId).toBe("dup");
  });

  it("returns an empty array for an empty input", () => {
    expect(formatRagContext([])).toEqual([]);
  });

  it("renders the injection-probe chunk's content as inert, unmodified data", () => {
    const [entry] = formatRagContext([
      chunk({
        chunkId: INJECTION_PROBE_CHUNK.chunkId,
        runbookId: INJECTION_PROBE_CHUNK.runbookId,
        title: INJECTION_PROBE_CHUNK.title,
        content: INJECTION_PROBE_CHUNK.content,
      }),
    ]);
    // The content is carried through verbatim as a plain string value — never
    // parsed, interpreted, or stripped of its embedded "instruction" text.
    expect(entry?.content).toBe(INJECTION_PROBE_CHUNK.content);
    expect(entry?.sourceType).toBe("RAG_CHUNK");
    expect(entry?.evidenceId).toBe(INJECTION_PROBE_CHUNK.chunkId);
  });
});
