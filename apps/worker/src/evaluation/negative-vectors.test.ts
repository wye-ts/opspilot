import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isCheckReasonCode, type CheckReasonCode } from "./check-reason-codes";
import { METRIC_CHECK_NAMES } from "./evaluation-evaluator";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationExpectations } from "./types";
import {
  buildEvaluationSuiteInputV2,
  EVALUATION_DATASET_ID,
  type EvaluationCheckV2,
} from "./v2-types";

// Issue #59 Checkpoint B §9 — negative evaluator vectors. This test and its
// Python mirror (services/evaluation/tests/test_negative_vectors.py) both
// read the single TS-owned fixtures/negative-vectors-v2.json and assert the
// EXACT #59 metric FAIL subset each synthetic vector must produce. Because
// both consumers drive their respective scorers from the SAME fixture and
// the Python scorer is a function-for-function mirror of evaluation-evaluator.ts
// (see scorer.py's module docstring), per-vector agreement on the declared
// failures is the cross-language agreement guarantee: no missing expected
// failure, no unexpected #59 metric failure, in either language.

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "negative-vectors-v2.json");

// The 25 retained #59 metric FAIL reason codes (spec §9.1 — one per vector
// family). The mechanical audit below proves the fixture's declared failures
// cover this set exactly: every code appears in >=1 vector and no vector
// declares a code outside it.
const RETAINED_FAIL_REASON_CODES: readonly CheckReasonCode[] = [
  "ROOT_CAUSE_PRESENCE_MISMATCH",
  "ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE",
  "EVIDENCE_REQUIRED_LOCATOR_MISSING",
  "EVIDENCE_STATE_MISMATCH",
  "EVIDENCE_TELEMETRY_MISSING",
  "EVIDENCE_CARDINALITY_INSUFFICIENT",
  "TELEMETRY_CLASSIFICATION_NOT_OBSERVED",
  "UNKNOWN_TELEMETRY_TREATED_AS_ANSWER",
  "UNKNOWN_TELEMETRY_GROUNDS_ACTION",
  "DIAGNOSTIC_SEQUENCE_MISMATCH",
  "DIAGNOSTIC_COUNT_MISMATCH",
  "DIAGNOSTIC_STOP_NOT_VOLUNTARY",
  "STOP_REASON_MISMATCH",
  "CONFIDENCE_OUT_OF_BAND",
  "ACTION_TYPE_SET_MISMATCH",
  "ACTION_REQUIRED_GROUNDING_MISSING",
  "ACTION_GROUNDING_NOT_ALLOWED",
  "ACTION_GROUNDING_DUPLICATED",
  "APPROVAL_ELIGIBILITY_MISMATCH",
  "TURN_BOUND_EXCEEDED",
  "TOOL_BOUND_EXCEEDED",
  "TOKEN_BUDGET_EXCEEDED",
  "RECOVERY_STAGE_MISMATCH",
  "RECOVERY_SIDE_EFFECT_OBSERVED",
  "RECOVERY_REPORT_PRESENCE_MISMATCH",
];

interface ExpectedMetricFailure {
  readonly checkName: (typeof METRIC_CHECK_NAMES)[number];
  readonly reasonCode: CheckReasonCode;
}

interface NegativeVectorFixture {
  readonly vectors: readonly {
    readonly id: string;
    readonly expectations: EvaluationExpectations;
    readonly observed: ObservedFacts;
    readonly expectedFailures: readonly ExpectedMetricFailure[];
  }[];
}

function loadFixture(): NegativeVectorFixture {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as unknown as NegativeVectorFixture;
}

// The #59 metric FAIL subset of a scored case: exactly the checks whose
// status is FAIL and whose name is one of the nine metric check names.
// Deterministic sort by (checkName, reasonCode) so the expected/actual
// comparison is a true set equality regardless of check order.
function metricFailSubset(checks: readonly EvaluationCheckV2[]): ExpectedMetricFailure[] {
  const failures = checks
    .filter(
      (check) =>
        check.status === "FAIL" && (METRIC_CHECK_NAMES as readonly string[]).includes(check.name),
    )
    .map((check) => ({
      checkName: check.name as ExpectedMetricFailure["checkName"],
      reasonCode: check.reasonCode as CheckReasonCode,
    }));
  return failures.sort(
    (a, b) =>
      a.checkName.localeCompare(b.checkName) || a.reasonCode.localeCompare(b.reasonCode),
  );
}

function sortFailures(failures: readonly ExpectedMetricFailure[]): ExpectedMetricFailure[] {
  return [...failures].sort(
    (a, b) =>
      a.checkName.localeCompare(b.checkName) || a.reasonCode.localeCompare(b.reasonCode),
  );
}

describe("Issue #59 Checkpoint B §9 — negative evaluator vectors", () => {
  const fixture = loadFixture();

  it("loads a non-empty fixture with unique vector ids", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(25);
    const ids = fixture.vectors.map((vector) => vector.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every vector declares only valid #59 metric check names and valid reason codes", () => {
    const metricCheckNameSet = new Set<string>(METRIC_CHECK_NAMES);
    for (const vector of fixture.vectors) {
      for (const failure of vector.expectedFailures) {
        expect(metricCheckNameSet.has(failure.checkName)).toBe(true);
        expect(isCheckReasonCode(failure.reasonCode)).toBe(true);
      }
    }
  });

  it("mechanically covers all 25 retained #59 FAIL reason codes — no gap, no stray code", () => {
    const declared = new Set<CheckReasonCode>(
      fixture.vectors.flatMap((vector) => vector.expectedFailures.map((failure) => failure.reasonCode)),
    );
    expect([...declared].sort()).toEqual([...RETAINED_FAIL_REASON_CODES].sort());
  });

  it("each vector's actual #59 metric FAIL subset equals its declared expectedFailures exactly — no missing, no unexpected", () => {
    const suite = buildEvaluationSuiteInputV2(
      EVALUATION_DATASET_ID,
      fixture.vectors.map((vector) => ({
        caseId: vector.id,
        expectations: vector.expectations,
        observed: vector.observed,
      })),
    );
    const scorer = new LocalEvaluationScorer();
    const result = scorer.score(suite);

    const resultsByCaseId = new Map(result.cases.map((caseResult) => [caseResult.caseId, caseResult]));
    expect(resultsByCaseId.size).toBe(fixture.vectors.length);

    for (const vector of fixture.vectors) {
      const caseResult = resultsByCaseId.get(vector.id);
      expect(caseResult, `vector "${vector.id}" must produce a scored result`).toBeDefined();
      const actual = metricFailSubset(caseResult!.checks);
      expect(actual, `vector "${vector.id}" actual #59 FAIL subset`).toEqual(
        sortFailures(vector.expectedFailures),
      );
      // A vector with any declared failure must have a failing case verdict.
      if (vector.expectedFailures.length > 0) {
        expect(caseResult!.passed).toBe(false);
      }
    }
  });

  it("the fixture is JSON-safe for the Python mirror (only JSON-compatible values, no TS-only echoes)", () => {
    // The Python consumer validates the exact same vectors through
    // EvaluationCaseInputV2.model_validate + score_cases. Re-serializing the
    // loaded fixture here proves every expectation/observed value survives a
    // JSON round-trip (no undefined, no NaN, no functions), which is what the
    // wire/Python side will actually see.
    const roundTripped = JSON.parse(JSON.stringify(fixture)) as NegativeVectorFixture;
    expect(roundTripped.vectors.length).toBe(fixture.vectors.length);
    for (let index = 0; index < fixture.vectors.length; index++) {
      expect(roundTripped.vectors[index]).toEqual(fixture.vectors[index]);
    }
  });
});
