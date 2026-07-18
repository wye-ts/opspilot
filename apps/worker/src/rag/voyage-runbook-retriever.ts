import { VoyageAIError, VoyageAITimeoutError, type EmbedRequest, type EmbedResponse } from "voyageai";

import { validateRetrievalInput } from "./retrieval-validation";
import {
  RetrieverError,
  type RetrievalInput,
  type RetrieverErrorCategory,
  type RetrievedRunbookChunk,
  type RunbookRetriever,
  type StoredRunbookChunk,
} from "./runbook-retriever";
import type { VoyageEmbeddingClient } from "./voyage-embedding-client";

export interface VoyageRunbookRetrieverOptions {
  readonly client: VoyageEmbeddingClient;
  readonly model: string;
  readonly dimensions: number;
  readonly corpus: readonly StoredRunbookChunk[];
}

function l2Norm(vector: readonly number[]): number {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  return Math.sqrt(sumSquares);
}

// score is application-computed from provider-returned vectors, never a raw
// provider value.
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (l2Norm(a) * l2Norm(b));
}

interface ExtractedEmbeddings {
  readonly vectors: readonly (readonly number[])[];
  readonly dimension: number;
}

// Validates and index-reorders a Voyage embed response into a dense array of
// vectors, one per requested input text — never trusting response array
// order to already match request order (correction §4/§5: "response
// ordering/index mapping is valid"). Throws RetrieverError("RESPONSE_INVALID")
// on any structural defect: wrong count, missing data, wrong/inconsistent
// dimension, non-finite values, a zero-norm vector, or an invalid/
// incomplete/duplicate index set. Every EmbedResponse/EmbedResponseDataItem
// field is optional in the real SDK type, so nothing here is assumed present.
function extractValidatedEmbeddings(
  response: EmbedResponse,
  expectedCount: number,
  expectedDimension: number,
  context: string,
): ExtractedEmbeddings {
  const data = response.data;
  if (!data || data.length !== expectedCount) {
    throw new RetrieverError(
      "RESPONSE_INVALID",
      `Embedding provider returned an invalid ${context} response (expected ${expectedCount} embedding(s)).`,
    );
  }

  const byIndex = new Map<number, readonly number[]>();

  for (const item of data) {
    const index = item.index;
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expectedCount ||
      byIndex.has(index)
    ) {
      throw new RetrieverError(
        "RESPONSE_INVALID",
        `Embedding provider returned an invalid ${context} response (invalid or duplicate index).`,
      );
    }

    const vector = item.embedding;
    if (!vector || vector.length === 0) {
      throw new RetrieverError(
        "RESPONSE_INVALID",
        `Embedding provider returned an invalid ${context} response (missing embedding vector).`,
      );
    }
    if (vector.length !== expectedDimension) {
      throw new RetrieverError(
        "RESPONSE_INVALID",
        `Embedding provider returned an invalid ${context} response (dimension mismatch).`,
      );
    }
    if (!vector.every((value) => Number.isFinite(value))) {
      throw new RetrieverError(
        "RESPONSE_INVALID",
        `Embedding provider returned an invalid ${context} response (non-finite value in vector).`,
      );
    }
    if (l2Norm(vector) === 0) {
      throw new RetrieverError(
        "RESPONSE_INVALID",
        `Embedding provider returned an invalid ${context} response (zero-norm vector).`,
      );
    }

    byIndex.set(index, vector);
  }

  if (byIndex.size !== expectedCount) {
    throw new RetrieverError(
      "RESPONSE_INVALID",
      `Embedding provider returned an invalid ${context} response (incomplete index coverage).`,
    );
  }

  const vectors = Array.from({ length: expectedCount }, (_, i) => byIndex.get(i)!);
  return { vectors, dimension: expectedDimension };
}

// Sanitized, category-based — never carries the raw SDK error's message,
// body, headers, or rawResponse. Mirrors ClaudeLlmProvider's classifyError.
function classifyVoyageError(error: unknown): RetrieverErrorCategory {
  if (error instanceof VoyageAITimeoutError) {
    return "TIMEOUT";
  }
  if (error instanceof VoyageAIError) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return "AUTHENTICATION";
    if (status === 429) return "RATE_LIMIT";
    if (status !== undefined && status >= 500) return "SERVER_ERROR";
    if (status !== undefined && status >= 400) return "REQUEST_INVALID";
    return "CONNECTION";
  }
  return "UNKNOWN";
}

function toRetrieverError(error: unknown): RetrieverError {
  if (error instanceof RetrieverError) return error;
  return new RetrieverError(classifyVoyageError(error), "Voyage embedding request failed.");
}

// Embeds the full corpus plus the query fresh on every call (no persistence
// — out of scope for this slice) and ranks by in-process cosine similarity.
// score/rank are always application-computed, never raw provider output; raw
// embedding vectors never leave this class.
export class VoyageRunbookRetriever implements RunbookRetriever {
  constructor(private readonly options: VoyageRunbookRetrieverOptions) {}

  async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
    // Defense-in-depth for direct/standalone use outside the orchestrator
    // (which already validates retrievalInput before calling retrieve()).
    const inputError = validateRetrievalInput(input);
    if (inputError) {
      throw new RetrieverError("REQUEST_INVALID", inputError);
    }

    const { client, model, dimensions, corpus } = this.options;

    const documentRequest: EmbedRequest = {
      input: corpus.map((chunk) => chunk.content),
      model,
      inputType: "document",
      outputDimension: dimensions,
      outputDtype: "float",
    };

    let documentResponse: EmbedResponse;
    try {
      documentResponse = await client.embed(documentRequest);
    } catch (error) {
      throw toRetrieverError(error);
    }

    const { vectors: documentVectors } = extractValidatedEmbeddings(
      documentResponse,
      corpus.length,
      dimensions,
      "document-embedding",
    );

    const queryRequest: EmbedRequest = {
      input: [input.query],
      model,
      inputType: "query",
      outputDimension: dimensions,
      outputDtype: "float",
    };

    let queryResponse: EmbedResponse;
    try {
      queryResponse = await client.embed(queryRequest);
    } catch (error) {
      throw toRetrieverError(error);
    }

    const { vectors: queryVectors } = extractValidatedEmbeddings(
      queryResponse,
      1,
      dimensions,
      "query-embedding",
    );
    const queryVector = queryVectors[0]!;

    const scored = corpus
      .map((chunk, index) => ({
        chunk,
        score: cosineSimilarity(queryVector, documentVectors[index]!),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.chunk.chunkId.localeCompare(b.chunk.chunkId);
      })
      .slice(0, input.topK);

    return scored.map(({ chunk, score }, index) => ({
      ...chunk,
      score,
      rank: index + 1,
    }));
  }
}
