import { describe, expect, it } from "vitest";

import {
  EvidenceLocatorSchema,
  EvidenceSourceTypeSchema,
  countDistinctEvidenceLocators,
} from "./evidence";

describe("EvidenceSourceTypeSchema", () => {
  it("accepts exactly the two source types", () => {
    expect(EvidenceSourceTypeSchema.safeParse("TOOL_EXECUTION").success).toBe(true);
    expect(EvidenceSourceTypeSchema.safeParse("RAG_CHUNK").success).toBe(true);
    expect(EvidenceSourceTypeSchema.safeParse("HYPOTHESIS").success).toBe(false);
    expect(EvidenceSourceTypeSchema.safeParse("something-else").success).toBe(false);
  });
});

describe("EvidenceLocatorSchema (strict shape)", () => {
  it("accepts a valid locator", () => {
    expect(
      EvidenceLocatorSchema.safeParse({
        evidenceId: "call-1",
        sourceType: "TOOL_EXECUTION",
      }).success,
    ).toBe(true);
  });

  it("rejects an extra key (strict)", () => {
    expect(
      EvidenceLocatorSchema.safeParse({
        evidenceId: "call-1",
        sourceType: "TOOL_EXECUTION",
        finding: "no free-form prose on a locator",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing required key (strict)", () => {
    expect(
      EvidenceLocatorSchema.safeParse({ evidenceId: "call-1" }).success,
    ).toBe(false);
    expect(
      EvidenceLocatorSchema.safeParse({ sourceType: "TOOL_EXECUTION" }).success,
    ).toBe(false);
  });

  it("rejects a blank evidenceId", () => {
    expect(
      EvidenceLocatorSchema.safeParse({ evidenceId: "", sourceType: "TOOL_EXECUTION" }).success,
    ).toBe(false);
  });
});

describe("countDistinctEvidenceLocators", () => {
  it("counts distinct (sourceType, evidenceId) pairs", () => {
    expect(
      countDistinctEvidenceLocators([
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "call-2", sourceType: "TOOL_EXECUTION" },
      ]),
    ).toBe(2);
  });

  it("collapses exact duplicates", () => {
    expect(
      countDistinctEvidenceLocators([
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
      ]),
    ).toBe(1);
  });

  it("counts the same raw evidenceId under different source types as distinct", () => {
    // P1-3: distinctness is keyed on (sourceType, evidenceId), not raw ID —
    // a RAG chunk and a current-run tool observation can share an id without
    // being the same evidence.
    expect(
      countDistinctEvidenceLocators([
        { evidenceId: "chunk-001", sourceType: "RAG_CHUNK" },
        { evidenceId: "chunk-001", sourceType: "TOOL_EXECUTION" },
      ]),
    ).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countDistinctEvidenceLocators([])).toBe(0);
  });

  it("accepts evidence-reference-shaped entries structurally (readonly pick)", () => {
    const references = [
      { evidenceId: "call-1", sourceType: "TOOL_EXECUTION", finding: "..." },
      { evidenceId: "call-2", sourceType: "TOOL_EXECUTION", finding: "..." },
    ] as const;
    expect(countDistinctEvidenceLocators(references)).toBe(2);
  });
});
