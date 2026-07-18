import { VoyageAIError, VoyageAITimeoutError, type EmbedRequest, type EmbedResponse } from "voyageai";
import { describe, expect, it, vi } from "vitest";

import { validateRetrievedChunks } from "./retrieval-validation";
import { RetrieverError, type StoredRunbookChunk } from "./runbook-retriever";
import type { VoyageEmbeddingClient } from "./voyage-embedding-client";
import { VoyageRunbookRetriever } from "./voyage-runbook-retriever";

const corpus: readonly StoredRunbookChunk[] = [
  { chunkId: "a", runbookId: "r1", title: "A", content: "Content A" },
  { chunkId: "b", runbookId: "r1", title: "B", content: "Content B" },
];

function buildFakeClient(embed: VoyageEmbeddingClient["embed"]): VoyageEmbeddingClient {
  return { embed };
}

function buildRetriever(embed: VoyageEmbeddingClient["embed"]): VoyageRunbookRetriever {
  return new VoyageRunbookRetriever({
    client: buildFakeClient(embed),
    model: "voyage-4-lite",
    dimensions: 2,
    corpus,
  });
}

// a -> [1,0], b -> [0,1]; a query of [1,0] matches "a" exactly (cosine 1)
// and is orthogonal to "b" (cosine 0).
const orthogonalEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> => {
  if (request.inputType === "document") {
    return {
      object: "list",
      model: "voyage-4-lite",
      data: [
        { object: "embedding", embedding: [1, 0], index: 0 },
        { object: "embedding", embedding: [0, 1], index: 1 },
      ],
      usage: { totalTokens: 10 },
    };
  }
  return {
    object: "list",
    model: "voyage-4-lite",
    data: [{ object: "embedding", embedding: [1, 0], index: 0 }],
    usage: { totalTokens: 2 },
  };
});

describe("VoyageRunbookRetriever", () => {
  it("computes cosine similarity correctly and ranks by descending score", async () => {
    const retriever = buildRetriever(orthogonalEmbed);

    const results = await retriever.retrieve({ query: "match a", topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.chunkId).toBe("a");
    expect(results[0]?.score).toBeCloseTo(1, 5);
    expect(results[0]?.rank).toBe(1);
    expect(results[1]?.chunkId).toBe("b");
    expect(results[1]?.score).toBeCloseTo(0, 5);
    expect(results[1]?.rank).toBe(2);
  });

  it("sends outputDtype: 'float' explicitly for both document and query requests", async () => {
    const embed = vi.fn(orthogonalEmbed);
    const retriever = buildRetriever(embed);

    await retriever.retrieve({ query: "match a", topK: 2 });

    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "document", outputDtype: "float", outputDimension: 2 }),
    );
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "query", outputDtype: "float", outputDimension: 2 }),
    );
  });

  it("output always passes the shared retrieval validator", async () => {
    const retriever = buildRetriever(orthogonalEmbed);
    const results = await retriever.retrieve({ query: "match a", topK: 2 });
    expect(validateRetrievedChunks(results, 2)).toBeNull();
  });

  it("breaks similarity ties by chunkId ascending, matching the keyword retriever's rule", async () => {
    const tiedCorpus: readonly StoredRunbookChunk[] = [
      { chunkId: "zzz", runbookId: "r1", title: "Z", content: "Content Z" },
      { chunkId: "aaa", runbookId: "r1", title: "AAA", content: "Content AAA" },
    ];
    const tiedEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> => {
      if (request.inputType === "document") {
        return {
          data: [
            { embedding: [1, 0], index: 0 },
            { embedding: [1, 0], index: 1 },
          ],
        };
      }
      return { data: [{ embedding: [1, 0], index: 0 }] };
    });
    const retriever = new VoyageRunbookRetriever({
      client: buildFakeClient(tiedEmbed),
      model: "voyage-4-lite",
      dimensions: 2,
      corpus: tiedCorpus,
    });

    const results = await retriever.retrieve({ query: "x", topK: 2 });

    expect(results[0]?.chunkId).toBe("aaa");
    expect(results[1]?.chunkId).toBe("zzz");
  });

  it("reorders a shuffled-but-valid response by index rather than trusting array order", async () => {
    const shuffledEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> => {
      if (request.inputType === "document") {
        return {
          data: [
            { embedding: [0, 1], index: 1 },
            { embedding: [1, 0], index: 0 },
          ],
        };
      }
      return { data: [{ embedding: [1, 0], index: 0 }] };
    });
    const retriever = buildRetriever(shuffledEmbed);

    const results = await retriever.retrieve({ query: "match a", topK: 2 });

    expect(results[0]?.chunkId).toBe("a");
    expect(results[0]?.score).toBeCloseTo(1, 5);
  });

  it("throws RESPONSE_INVALID when the document embedding count doesn't match corpus size", async () => {
    const badResponse: EmbedResponse = { data: [{ embedding: [1, 0], index: 0 }] };
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document" ? badResponse : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it("throws RESPONSE_INVALID when the document embedding response is missing data entirely", async () => {
    const badResponse: EmbedResponse = {};
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document" ? badResponse : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it("throws RESPONSE_INVALID when the query embedding count is not exactly one", async () => {
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document"
        ? {
            data: [
              { embedding: [1, 0], index: 0 },
              { embedding: [0, 1], index: 1 },
            ],
          }
        : {
            data: [
              { embedding: [1, 0], index: 0 },
              { embedding: [0, 1], index: 1 },
            ],
          },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it("throws RESPONSE_INVALID when a vector's dimension doesn't match the configured dimensions", async () => {
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document"
        ? {
            data: [
              { embedding: [1, 0, 0], index: 0 }, // 3 dims, configured for 2
              { embedding: [0, 1], index: 1 },
            ],
          }
        : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it.each([NaN, Infinity, -Infinity])(
    "throws RESPONSE_INVALID when a vector contains a non-finite value (%s)",
    async (badValue) => {
      const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
        request.inputType === "document"
          ? {
              data: [
                { embedding: [badValue, 0], index: 0 },
                { embedding: [0, 1], index: 1 },
              ],
            }
          : { data: [{ embedding: [1, 0], index: 0 }] },
      );
      const retriever = buildRetriever(badEmbed);

      await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
        category: "RESPONSE_INVALID",
      });
    },
  );

  it("throws RESPONSE_INVALID for a zero-norm vector", async () => {
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document"
        ? {
            data: [
              { embedding: [0, 0], index: 0 },
              { embedding: [0, 1], index: 1 },
            ],
          }
        : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it("throws RESPONSE_INVALID for a duplicate index", async () => {
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document"
        ? {
            data: [
              { embedding: [1, 0], index: 0 },
              { embedding: [0, 1], index: 0 },
            ],
          }
        : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it("throws RESPONSE_INVALID for a missing/incomplete index (index out of range)", async () => {
    const badEmbed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> =>
      request.inputType === "document"
        ? {
            data: [
              { embedding: [1, 0], index: 0 },
              { embedding: [0, 1], index: 5 },
            ],
          }
        : { data: [{ embedding: [1, 0], index: 0 }] },
    );
    const retriever = buildRetriever(badEmbed);

    await expect(retriever.retrieve({ query: "x", topK: 2 })).rejects.toMatchObject({
      category: "RESPONSE_INVALID",
    });
  });

  it.each([
    ["AuthenticationError-shaped (401)", () => new VoyageAIError({ statusCode: 401 }), "AUTHENTICATION"],
    ["RateLimit-shaped (429)", () => new VoyageAIError({ statusCode: 429 }), "RATE_LIMIT"],
    ["ServerError-shaped (500)", () => new VoyageAIError({ statusCode: 500 }), "SERVER_ERROR"],
    ["Timeout", () => new VoyageAITimeoutError("timed out"), "TIMEOUT"],
    ["network-level (no statusCode)", () => new VoyageAIError({}), "CONNECTION"],
    ["unknown error type", () => new Error("plain error"), "UNKNOWN"],
  ] as const)("classifies %s as %s", async (_name, buildError, expectedCategory) => {
    const throwingEmbed = vi.fn(async () => {
      throw buildError();
    });
    const retriever = buildRetriever(throwingEmbed);

    let thrown: unknown;
    try {
      await retriever.retrieve({ query: "x", topK: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RetrieverError);
    expect((thrown as RetrieverError).category).toBe(expectedCategory);
  });

  it("never leaks the raw SDK error message/body into the thrown RetrieverError", async () => {
    const throwingEmbed = vi.fn(async () => {
      throw new VoyageAIError({
        statusCode: 500,
        message: "leaked-secret-detail-9f3a",
        body: { secret: "leaked-secret-detail-9f3a" },
      });
    });
    const retriever = buildRetriever(throwingEmbed);

    let thrown: unknown;
    try {
      await retriever.retrieve({ query: "x", topK: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RetrieverError);
    expect((thrown as RetrieverError).message).not.toContain("leaked-secret-detail-9f3a");
    expect(JSON.stringify(thrown)).not.toContain("leaked-secret-detail-9f3a");
  });
});
