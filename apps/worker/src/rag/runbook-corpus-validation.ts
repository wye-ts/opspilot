function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Defense-in-depth shape check for a loader's assembled corpus, mirroring
// validateRetrievedChunks' style (retrieval-validation.ts) but over
// StoredRunbookChunk shape rather than RetrievedRunbookChunk (no score/rank).
// `chunks` is deliberately typed `unknown`: the loader that calls this treats
// its own freshly-parsed output as untrusted at this boundary, the same way a
// retriever's raw output is never trusted just because it typechecks.
export function validateStoredRunbookChunks(chunks: unknown): string | null {
  if (!Array.isArray(chunks)) {
    return "runbook corpus must be an array.";
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk: unknown = chunks[i];

    if (typeof chunk !== "object" || chunk === null) {
      return `chunk at position ${i} must be a non-null object.`;
    }

    const record = chunk as Record<string, unknown>;

    if (!isNonEmptyString(record.chunkId)) {
      return `chunk at position ${i} has an invalid or empty chunkId.`;
    }
    const chunkId = record.chunkId;

    if (!isNonEmptyString(record.runbookId)) {
      return `chunk "${chunkId}" has an invalid or empty runbookId.`;
    }
    if (!isNonEmptyString(record.title)) {
      return `chunk "${chunkId}" has an invalid or empty title.`;
    }
    if (!isNonEmptyString(record.content)) {
      return `chunk "${chunkId}" has an invalid or empty content.`;
    }
    if (record.serviceSlug !== undefined && typeof record.serviceSlug !== "string") {
      return `chunk "${chunkId}" has a non-string serviceSlug.`;
    }
    if (record.category !== undefined && typeof record.category !== "string") {
      return `chunk "${chunkId}" has a non-string category.`;
    }

    if (seenIds.has(chunkId)) {
      return `duplicate chunkId "${chunkId}" in runbook corpus.`;
    }
    seenIds.add(chunkId);
  }

  return null;
}
