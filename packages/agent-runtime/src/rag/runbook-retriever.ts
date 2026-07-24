// docs/03-technical-design.md §15.4 defines a provider-neutral EmbeddingProvider
// abstraction. RunbookRetriever is the analogous provider-neutral seam for
// retrieval itself: application code depends on this interface, never on a
// concrete embedding SDK.
export interface RetrievalInput {
  readonly query: string;
  readonly topK: number;
}

export interface StoredRunbookChunk {
  readonly chunkId: string;
  readonly runbookId: string;
  readonly title: string;
  readonly content: string;
  readonly serviceSlug?: string;
  readonly category?: string;
}

export interface RetrievedRunbookChunk extends StoredRunbookChunk {
  readonly score: number;
  readonly rank: number;
}

export interface RunbookRetriever {
  retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]>;
}

// Mirrors LlmProviderErrorCategory (../providers/llm-provider.ts) exactly, plus
// RESPONSE_INVALID for a provider response that fails runtime shape validation
// (see voyage-runbook-retriever.ts). A retriever throws this instead of
// returning a bad result; it must never carry a raw `cause` — messages are
// short, static strings composed by OpsPilot code, never interpolated from a
// raw SDK error's message/body/headers.
export type RetrieverErrorCategory =
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "CONNECTION"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "REQUEST_INVALID"
  | "RESPONSE_INVALID"
  | "UNKNOWN";

export class RetrieverError extends Error {
  constructor(
    readonly category: RetrieverErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "RetrieverError";
  }
}
