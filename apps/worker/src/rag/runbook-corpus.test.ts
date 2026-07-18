import { describe, expect, it } from "vitest";

import { RUNBOOK_CORPUS } from "./runbook-corpus";

describe("RUNBOOK_CORPUS", () => {
  it("has between 5 and 10 chunks", () => {
    expect(RUNBOOK_CORPUS.length).toBeGreaterThanOrEqual(5);
    expect(RUNBOOK_CORPUS.length).toBeLessThanOrEqual(10);
  });

  it("has unique, stable, human-readable chunkIds", () => {
    const ids = RUNBOOK_CORPUS.map((chunk) => chunk.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("has no empty required fields", () => {
    for (const chunk of RUNBOOK_CORPUS) {
      expect(chunk.chunkId.trim().length).toBeGreaterThan(0);
      expect(chunk.runbookId.trim().length).toBeGreaterThan(0);
      expect(chunk.title.trim().length).toBeGreaterThan(0);
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("covers notification-service degradation", () => {
    expect(
      RUNBOOK_CORPUS.some((chunk) => chunk.title.toLowerCase().includes("notification")),
    ).toBe(true);
  });

  it("covers notification/email queue backlog", () => {
    expect(RUNBOOK_CORPUS.some((chunk) => chunk.title.toLowerCase().includes("queue backlog"))).toBe(
      true,
    );
  });

  it("covers authentication failures", () => {
    expect(
      RUNBOOK_CORPUS.some((chunk) => chunk.title.toLowerCase().includes("authentication")),
    ).toBe(true);
  });

  it("covers database connection saturation", () => {
    expect(
      RUNBOOK_CORPUS.some((chunk) => chunk.title.toLowerCase().includes("database connection")),
    ).toBe(true);
  });

  it("includes one intentionally irrelevant control topic", () => {
    expect(RUNBOOK_CORPUS.some((chunk) => chunk.runbookId === "billing-runbook")).toBe(true);
  });

  it("is deterministic across repeated imports (no randomness/timestamps)", async () => {
    const { RUNBOOK_CORPUS: reimported } = await import("./runbook-corpus");
    expect(reimported).toEqual(RUNBOOK_CORPUS);
  });
});
