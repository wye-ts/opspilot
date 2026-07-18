import type { EmbedRequest, EmbedResponse } from "voyageai";

// A narrow seam interface — mirrors AnthropicMessagesClient
// (../providers/claude-llm-provider.ts) — so unit tests can inject a fake
// without needing the real Voyage SDK client, and so only this file and
// voyage-runbook-retriever.ts import from the voyageai package. The real
// VoyageAIClient.embed() returns HttpResponsePromise<EmbedResponse>, which
// extends Promise<EmbedResponse>, so a real client satisfies this interface
// without a cast.
export interface VoyageEmbeddingClient {
  embed(request: EmbedRequest): Promise<EmbedResponse>;
}
