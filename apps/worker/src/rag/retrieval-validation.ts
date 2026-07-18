import type { RetrievalInput } from "./runbook-retriever";

// Caller-input-level validity (RETRIEVAL_PARAMS_INVALID at the orchestrator
// layer): a bad topK or empty query is a contract violation by the caller,
// not something a retriever's output could ever redeem.
export function validateRetrievalInput(input: RetrievalInput): string | null {
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 5) {
    return `topK must be an integer between 1 and 5, got ${input.topK}.`;
  }
  if (input.query.trim().length === 0) {
    return "query must be a non-empty string.";
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Retriever-output-level validity (RETRIEVAL_RESPONSE_INVALID at the
// orchestrator layer): the retriever ran and returned something, but that
// something doesn't satisfy the contract every retriever implementation must
// uphold. Retriever-agnostic — reused by every RunbookRetriever's own tests
// so each implementation's output is proven valid by construction.
//
// `chunks` is deliberately typed `unknown`, not `readonly RetrievedRunbookChunk[]`:
// this function is the runtime boundary that must not assume a TypeScript
// interface guarantees anything about the actual value at runtime (a
// retriever — especially one backed by a third-party HTTP response — can
// violate its own declared return type at runtime even though it typechecks
// at the call site). Every property is checked for its actual runtime type,
// via `typeof`/`Number.isFinite`/`Number.isInteger` guards, before it is
// ever read as that type — so a malformed value returns a descriptive error
// string instead of throwing a TypeError from an unguarded `.trim()` or
// property access. The one type assertion below (`as Record<string,
// unknown>`) only tells TypeScript that a value already confirmed to be a
// non-null object supports property access — it narrows nothing about the
// values of those properties, which are still checked individually.
//
// rank is checked positionally (chunks[i].rank === i + 1), not by sorting the
// rank values and checking the resulting set is 1..N: the returned array
// order, the model-visible context order, and the trace order must all agree
// with rank, or a chunk shown to Claude in one order could be reported to a
// human/trace in a different order without detection.
export function validateRetrievedChunks(chunks: unknown, topK: number): string | null {
  if (!Array.isArray(chunks)) {
    return "retriever result must be an array.";
  }
  if (chunks.length > topK) {
    return `retriever returned ${chunks.length} chunks, exceeding topK=${topK}.`;
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

    const score = record.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return `chunk "${chunkId}" has a non-finite or non-numeric score.`;
    }

    const rank = record.rank;
    if (typeof rank !== "number" || !Number.isInteger(rank)) {
      return `chunk "${chunkId}" has a non-integer or non-numeric rank.`;
    }

    if (seenIds.has(chunkId)) {
      return `duplicate chunkId "${chunkId}" in retrieval result.`;
    }
    seenIds.add(chunkId);

    if (rank !== i + 1) {
      return `chunk "${chunkId}" at position ${i} has rank ${rank}, expected ${i + 1}.`;
    }
  }

  return null;
}
