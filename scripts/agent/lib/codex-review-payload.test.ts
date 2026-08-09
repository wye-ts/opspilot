import { describe, expect, it } from "vitest";

import { isCodexReviewPayload, verdictConsistentWithFindings } from "./codex-review-payload";
import type { CodexFinding, CodexReviewPayload } from "./types";

function sampleFinding(overrides: Partial<CodexFinding> = {}): CodexFinding {
  return {
    severity: "MAJOR",
    title: "off-by-one in pagination",
    location: "apps/web/src/x.ts:42",
    reproduction: "request page 2 with pageSize 10",
    whyItMatters: "drops the last row of every page",
    smallestFix: "use <= instead of <",
    missingTest: "a test asserting the last row of a full page is included",
    ...overrides,
  };
}

describe("isCodexReviewPayload", () => {
  it("accepts a well-formed READY_FOR_OWNER_REVIEW payload with no findings", () => {
    const payload: CodexReviewPayload = { verdict: "READY_FOR_OWNER_REVIEW", findings: [] };
    expect(isCodexReviewPayload(payload)).toBe(true);
  });

  it("accepts a well-formed NEEDS_FIXES payload with findings", () => {
    const payload: CodexReviewPayload = { verdict: "NEEDS_FIXES", findings: [sampleFinding()] };
    expect(isCodexReviewPayload(payload)).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isCodexReviewPayload(null)).toBe(false);
    expect(isCodexReviewPayload("not an object")).toBe(false);
    expect(isCodexReviewPayload([])).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    expect(isCodexReviewPayload({ verdict: "READY_FOR_OWNER_REVIEW", findings: [], extra: 1 })).toBe(false);
  });

  it("rejects an invalid verdict", () => {
    expect(isCodexReviewPayload({ verdict: "MAYBE", findings: [] })).toBe(false);
  });

  it("rejects a missing findings array", () => {
    expect(isCodexReviewPayload({ verdict: "READY_FOR_OWNER_REVIEW" })).toBe(false);
  });

  it("rejects a finding with an unknown field", () => {
    const bad = { ...sampleFinding(), extra: "nope" };
    expect(isCodexReviewPayload({ verdict: "NEEDS_FIXES", findings: [bad] })).toBe(false);
  });

  it("rejects a finding with an invalid severity", () => {
    const bad = sampleFinding({ severity: "CRITICAL" as never });
    expect(isCodexReviewPayload({ verdict: "NEEDS_FIXES", findings: [bad] })).toBe(false);
  });

  it("rejects a finding missing a required string field", () => {
    const bad = { ...sampleFinding() };
    delete (bad as Partial<CodexFinding>).smallestFix;
    expect(isCodexReviewPayload({ verdict: "NEEDS_FIXES", findings: [bad] })).toBe(false);
  });

  it("rejects a finding whose field has the wrong type", () => {
    const bad = { ...sampleFinding(), title: 123 };
    expect(isCodexReviewPayload({ verdict: "NEEDS_FIXES", findings: [bad] })).toBe(false);
  });
});

describe("verdictConsistentWithFindings", () => {
  it("READY_FOR_OWNER_REVIEW with no findings is consistent", () => {
    expect(verdictConsistentWithFindings({ verdict: "READY_FOR_OWNER_REVIEW", findings: [] })).toBe(true);
  });

  it("READY_FOR_OWNER_REVIEW with findings is inconsistent", () => {
    expect(
      verdictConsistentWithFindings({ verdict: "READY_FOR_OWNER_REVIEW", findings: [sampleFinding()] }),
    ).toBe(false);
  });

  it("NEEDS_FIXES with findings is consistent", () => {
    expect(verdictConsistentWithFindings({ verdict: "NEEDS_FIXES", findings: [sampleFinding()] })).toBe(true);
  });

  it("NEEDS_FIXES with no findings is inconsistent", () => {
    expect(verdictConsistentWithFindings({ verdict: "NEEDS_FIXES", findings: [] })).toBe(false);
  });
});
