import { describe, expect, it } from "vitest";

import type { RetrievedRunbookChunk } from "./runbook-retriever";
import { validateRetrievalInput, validateRetrievedChunks } from "./retrieval-validation";

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

describe("validateRetrievalInput", () => {
  it.each([0, 6, 2.5, -1])("rejects topK=%s", (topK) => {
    expect(validateRetrievalInput({ query: "notification", topK })).not.toBeNull();
  });

  it.each([1, 2, 3, 4, 5])("accepts topK=%s", (topK) => {
    expect(validateRetrievalInput({ query: "notification", topK })).toBeNull();
  });

  it("rejects an empty query", () => {
    expect(validateRetrievalInput({ query: "", topK: 3 })).not.toBeNull();
  });

  it("rejects a whitespace-only query", () => {
    expect(validateRetrievalInput({ query: "   ", topK: 3 })).not.toBeNull();
  });
});

describe("validateRetrievedChunks", () => {
  it("accepts a well-formed chunk array", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1, score: 4 }),
      chunk({ chunkId: "b", rank: 2, score: 2 }),
    ];
    expect(validateRetrievedChunks(chunks, 3)).toBeNull();
  });

  it("accepts an empty array (zero results is not an error)", () => {
    expect(validateRetrievedChunks([], 3)).toBeNull();
  });

  it("rejects a result count exceeding topK", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1 }),
      chunk({ chunkId: "b", rank: 2 }),
    ];
    expect(validateRetrievedChunks(chunks, 1)).not.toBeNull();
  });

  it("rejects duplicate chunkIds without silently deduplicating", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1 }),
      chunk({ chunkId: "a", rank: 2 }),
    ];
    expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
  });

  it("rejects non-consecutive ranks", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1 }),
      chunk({ chunkId: "b", rank: 3 }),
    ];
    expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
  });

  it("rejects duplicate ranks", () => {
    const chunks = [
      chunk({ chunkId: "a", rank: 1 }),
      chunk({ chunkId: "b", rank: 1 }),
    ];
    expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
  });

  it("requires rank to match array position exactly, not just be a valid 1..N set", () => {
    // Same set of ranks {1,2} as a valid case, but out of positional order.
    const chunks = [
      chunk({ chunkId: "a", rank: 2 }),
      chunk({ chunkId: "b", rank: 1 }),
    ];
    expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])("rejects a non-finite score (%s)", (score) => {
    const chunks = [chunk({ score, rank: 1 })];
    expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
  });

  it.each(["chunkId", "runbookId", "title", "content"] as const)(
    "rejects an empty required field: %s",
    (field) => {
      const chunks = [chunk({ [field]: "", rank: 1 } as Partial<RetrievedRunbookChunk>)];
      expect(validateRetrievedChunks(chunks, 3)).not.toBeNull();
    },
  );
});

describe("validateRetrievedChunks — malformed runtime values", () => {
  // These pass genuinely `unknown`-shaped values (no interface, no cast) to
  // prove the function is a real runtime boundary: it must not assume a
  // TypeScript type ever guaranteed the actual shape, and it must return an
  // error string rather than throwing a TypeError from an unguarded
  // `.trim()` or property access.

  it("rejects when chunks is not an array", () => {
    expect(() => validateRetrievedChunks("not an array", 3)).not.toThrow();
    expect(validateRetrievedChunks("not an array", 3)).not.toBeNull();
  });

  it("rejects when chunks is null", () => {
    expect(() => validateRetrievedChunks(null, 3)).not.toThrow();
    expect(validateRetrievedChunks(null, 3)).not.toBeNull();
  });

  it("rejects when chunks is undefined", () => {
    expect(() => validateRetrievedChunks(undefined, 3)).not.toThrow();
    expect(validateRetrievedChunks(undefined, 3)).not.toBeNull();
  });

  it("rejects a null entry without throwing", () => {
    expect(() => validateRetrievedChunks([null], 3)).not.toThrow();
    expect(validateRetrievedChunks([null], 3)).not.toBeNull();
  });

  it("rejects a non-object entry (e.g. a bare string) without throwing", () => {
    expect(() => validateRetrievedChunks(["not a chunk"], 3)).not.toThrow();
    expect(validateRetrievedChunks(["not a chunk"], 3)).not.toBeNull();
  });

  it("rejects a numeric title without throwing", () => {
    const malformed = {
      chunkId: "a",
      runbookId: "r",
      title: 123,
      content: "c",
      score: 1,
      rank: 1,
    };
    expect(() => validateRetrievedChunks([malformed], 3)).not.toThrow();
    expect(validateRetrievedChunks([malformed], 3)).not.toBeNull();
  });

  it("rejects a missing content field without throwing", () => {
    const malformed = {
      chunkId: "a",
      runbookId: "r",
      title: "t",
      score: 1,
      rank: 1,
    };
    expect(() => validateRetrievedChunks([malformed], 3)).not.toThrow();
    expect(validateRetrievedChunks([malformed], 3)).not.toBeNull();
  });

  it("rejects a string score without throwing", () => {
    const malformed = {
      chunkId: "a",
      runbookId: "r",
      title: "t",
      content: "c",
      score: "1",
      rank: 1,
    };
    expect(() => validateRetrievedChunks([malformed], 3)).not.toThrow();
    expect(validateRetrievedChunks([malformed], 3)).not.toBeNull();
  });

  it("rejects a non-integer rank without throwing", () => {
    const malformed = {
      chunkId: "a",
      runbookId: "r",
      title: "t",
      content: "c",
      score: 1,
      rank: 1.5,
    };
    expect(() => validateRetrievedChunks([malformed], 3)).not.toThrow();
    expect(validateRetrievedChunks([malformed], 3)).not.toBeNull();
  });

  it("rejects a missing chunkId without throwing, even though later fields are well-formed", () => {
    const malformed = {
      runbookId: "r",
      title: "t",
      content: "c",
      score: 1,
      rank: 1,
    };
    expect(() => validateRetrievedChunks([malformed], 3)).not.toThrow();
    expect(validateRetrievedChunks([malformed], 3)).not.toBeNull();
  });
});
