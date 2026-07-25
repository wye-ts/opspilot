import type { RagContextEntry } from "../providers/llm-provider";
import type { RetrievedRunbookChunk } from "./runbook-retriever";

export type { RagContextEntry };

// A strict one-to-one, order-preserving map — no Set, no dedup logic here.
// Chunks reaching this function must already have passed
// validateRetrievedChunks (see agent-orchestrator.ts), which is the sole
// place duplicate chunkIds are rejected. This function must never drop,
// merge, or reorder entries, so it cannot mask an upstream validation gap.
export function formatRagContext(
  chunks: readonly RetrievedRunbookChunk[],
): readonly RagContextEntry[] {
  return chunks.map((chunk) => ({
    evidenceId: chunk.chunkId,
    sourceType: "RAG_CHUNK",
    runbookId: chunk.runbookId,
    title: chunk.title,
    content: chunk.content,
  }));
}
