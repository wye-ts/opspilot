import { describe, expect, it } from "vitest";

import {
  ADVERSARIAL_CASE_IDS,
  NON_ADVERSARIAL_FABRICATION_CASE_IDS,
  summarizeAdversarialCases,
} from "./adversarial-gate";
import { EVALUATION_CASES } from "./evaluation-dataset";
import type { EvaluationCaseResultV2 } from "./v2-types";

function result(caseId: string, passed: boolean): EvaluationCaseResultV2 {
  return {
    caseId,
    passed,
    checks: passed
      ? [{ name: "status", status: "PASS", reasonCode: null }]
      : [{ name: "status", status: "FAIL", reasonCode: "STATUS_MISMATCH" }],
  };
}

const allAdversarialPassing = ADVERSARIAL_CASE_IDS.map((caseId) => result(caseId, true));

describe("ADVERSARIAL_CASE_IDS — the declared structural adversarial set", () => {
  // The anti-erosion guarantee this constant exists for: evaluation-dataset.test.ts
  // already fails if the 22-id list changes, but only as "the list changed".
  // THIS test fails with a message naming the security set specifically, so
  // deleting an adversarial case cannot be mistaken for an ordinary dataset edit.
  it("names only ids that really exist in EVALUATION_CASES", () => {
    const datasetIds = new Set(EVALUATION_CASES.map((evaluationCase) => evaluationCase.id));
    const missing = ADVERSARIAL_CASE_IDS.filter((caseId) => !datasetIds.has(caseId));

    expect(
      missing,
      `Structural adversarial case(s) missing from EVALUATION_CASES: ${missing.join(", ")}. ` +
        "A security case was removed or renamed. This is not an ordinary dataset edit — see " +
        "adversarial-gate.ts and docs/reviews/34-issue-78-ci-adversarial-gate-plan.md before changing it.",
    ).toEqual([]);
  });

  it("declares exactly three cases", () => {
    expect(ADVERSARIAL_CASE_IDS).toHaveLength(3);
  });

  it("has no duplicate ids", () => {
    expect(new Set(ADVERSARIAL_CASE_IDS).size).toBe(ADVERSARIAL_CASE_IDS.length);
  });

  // Guards the opposite drift from the test above: someone "correcting" the set
  // to 5 by folding in cases 7/8, which are bare fabricated-id cases with no
  // adversarial content in the run (Issue #77 plan's scope decision).
  it("excludes the two bare fabricated-evidence cases, which carry no adversarial content", () => {
    for (const caseId of NON_ADVERSARIAL_FABRICATION_CASE_IDS) {
      expect(ADVERSARIAL_CASE_IDS).not.toContain(caseId);
    }
  });

  // The excluded ids must still be REAL cases — otherwise this exclusion list
  // silently rots into a list of names that mean nothing.
  it("names real dataset cases in its exclusion list too", () => {
    const datasetIds = new Set(EVALUATION_CASES.map((evaluationCase) => evaluationCase.id));
    for (const caseId of NON_ADVERSARIAL_FABRICATION_CASE_IDS) {
      expect(datasetIds).toContain(caseId);
    }
  });
});

describe("summarizeAdversarialCases", () => {
  it("reports every declared case present and passing", () => {
    const summary = summarizeAdversarialCases(allAdversarialPassing);

    expect(summary).toEqual({ declared: 3, present: 3, passed: 3, missingIds: [] });
  });

  it("ignores non-adversarial cases in the same results array", () => {
    const summary = summarizeAdversarialCases([
      result("notification-service-degradation", true),
      ...allAdversarialPassing,
      result("fabricated-rag-evidence", true),
    ]);

    expect(summary).toEqual({ declared: 3, present: 3, passed: 3, missingIds: [] });
  });

  it("counts a failing adversarial case as present but not passed", () => {
    const [first, ...rest] = ADVERSARIAL_CASE_IDS;
    const summary = summarizeAdversarialCases([
      result(first, false),
      ...rest.map((caseId) => result(caseId, true)),
    ]);

    expect(summary).toEqual({ declared: 3, present: 3, passed: 2, missingIds: [] });
  });

  // The denominator stays at `declared` — an absent case must not shrink it and
  // thereby render a misleading "2/2".
  it("keeps the denominator at declared when a case is absent, and names the absentee", () => {
    const summary = summarizeAdversarialCases(
      allAdversarialPassing.filter((entry) => entry.caseId !== "adversarial-tool-input-shape"),
    );

    expect(summary).toEqual({
      declared: 3,
      present: 2,
      passed: 2,
      missingIds: ["adversarial-tool-input-shape"],
    });
  });

  it("reports every declared case missing for an empty result set, never a vacuous 0/0", () => {
    const summary = summarizeAdversarialCases([]);

    expect(summary).toEqual({
      declared: 3,
      present: 0,
      passed: 0,
      missingIds: [...ADVERSARIAL_CASE_IDS],
    });
  });

  it("returns missingIds in ADVERSARIAL_CASE_IDS order, not results order", () => {
    const summary = summarizeAdversarialCases([result("injection-probe-structural", true)]);

    expect(summary.missingIds).toEqual([
      "fabricated-tool-output-evidence",
      "adversarial-tool-input-shape",
    ]);
  });
});
