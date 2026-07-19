import { describe, expect, it } from "vitest";

import { validateStoredRunbookChunks } from "./runbook-corpus-validation";

const validChunk = {
  chunkId: "runbook-a-001",
  runbookId: "a-runbook",
  title: "A",
  content: "Content A",
};

describe("validateStoredRunbookChunks", () => {
  it("passes for a well-formed corpus", () => {
    expect(validateStoredRunbookChunks([validChunk])).toBeNull();
  });

  it("passes with optional serviceSlug/category present", () => {
    expect(
      validateStoredRunbookChunks([{ ...validChunk, serviceSlug: "svc", category: "CAT" }]),
    ).toBeNull();
  });

  it("passes for an empty array", () => {
    expect(validateStoredRunbookChunks([])).toBeNull();
  });

  it("rejects a non-array", () => {
    expect(validateStoredRunbookChunks({})).toBe("runbook corpus must be an array.");
  });

  it("rejects a null element", () => {
    expect(validateStoredRunbookChunks([null])).toMatch(/non-null object/);
  });

  it("rejects a missing/empty chunkId", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, chunkId: "" }])).toMatch(/chunkId/);
  });

  it("rejects a missing/empty runbookId", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, runbookId: "" }])).toMatch(/runbookId/);
  });

  it("rejects a missing/empty title", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, title: "" }])).toMatch(/title/);
  });

  it("rejects a missing/empty content", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, content: "" }])).toMatch(/content/);
  });

  it("rejects a non-string serviceSlug", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, serviceSlug: 5 }])).toMatch(/serviceSlug/);
  });

  it("rejects a non-string category", () => {
    expect(validateStoredRunbookChunks([{ ...validChunk, category: 5 }])).toMatch(/category/);
  });

  it("rejects a duplicate chunkId", () => {
    expect(validateStoredRunbookChunks([validChunk, validChunk])).toMatch(/duplicate chunkId/);
  });
});
