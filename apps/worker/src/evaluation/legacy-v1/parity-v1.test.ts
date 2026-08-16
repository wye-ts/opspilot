// FROZEN v1 oracle test (OpsPilot #59 Checkpoint A §5 / §10 test 3): proves
// the historical v1 contract/scorer remains reproducible OFFLINE against the
// frozen ts-parity-v1.json fixture — and that the fixture itself is frozen,
// never regenerated. This is the only live consumer of legacy-v1/; the
// active runtime/scorer never imports any of it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { EvaluationExpectations } from "../types";
import { LocalEvaluationScorerV1 } from "./local-scorer-v1";
import type { ObservedFactsV1 } from "./observed-facts-v1";
import { buildEvaluationSuiteInputV1 } from "./v1-types";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ts-parity-v1.json");

// The SHA-256 of the committed ts-parity-v1.json, recorded at the OpsPilot
// #59 Checkpoint A freeze. If the file is ever regenerated, this test fails —
// the v1 fixture is frozen and must never be re-created (Revision 5 plan §5).
const FROZEN_FIXTURE_SHA256 = "b70e303c2967666f9a2df6427404a8e0d7bde09e17881356078558475f06a570";

interface FrozenFixtureCheckV1 {
  readonly name: string;
  readonly passed: boolean;
  readonly reasonCode: string | null;
}

interface FrozenFixtureCaseV1 {
  readonly caseId: string;
  readonly expectations: EvaluationExpectations;
  readonly observed: ObservedFactsV1;
  readonly expected: {
    readonly passed: boolean;
    readonly checks: readonly FrozenFixtureCheckV1[];
  };
}

interface FrozenFixtureV1 {
  readonly contractVersion: 1;
  readonly datasetId: string;
  readonly cases: readonly FrozenFixtureCaseV1[];
  readonly expectedMetrics: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly failedCases: number;
    readonly passRate: number;
    readonly retrievalTop1: { readonly numerator: number; readonly denominator: number };
    readonly retrievalHitAt3: { readonly numerator: number; readonly denominator: number };
    readonly schemaHandlingCorrectness: { readonly numerator: number; readonly denominator: number };
    readonly evidenceGroundingCorrectness: { readonly numerator: number; readonly denominator: number };
    readonly toolCorrectness: { readonly numerator: number; readonly denominator: number };
    readonly expectedStatusCorrectness: { readonly numerator: number; readonly denominator: number };
  };
}

function loadFrozenFixture(): FrozenFixtureV1 {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FrozenFixtureV1;
}

function sha256OfFile(): string {
  return createHash("sha256").update(readFileSync(FIXTURE_PATH, "utf8")).digest("hex");
}

describe("frozen v1 offline oracle (legacy-v1/)", () => {
  it("ts-parity-v1.json is frozen — its SHA-256 never changes, so it can never be regenerated silently", () => {
    expect(sha256OfFile()).toBe(FROZEN_FIXTURE_SHA256);
  });

  it("the frozen fixture is the historical v1 artifact — contractVersion 1, datasetId opspilot-deterministic-v1, 15 cases", () => {
    const fixture = loadFrozenFixture();
    expect(fixture.contractVersion).toBe(1);
    expect(fixture.datasetId).toBe("opspilot-deterministic-v1");
    expect(fixture.cases).toHaveLength(15);
  });

  it("the frozen v1 oracle reproduces the historical fixture behavior — per-case passed/checks and all six metrics", () => {
    const fixture = loadFrozenFixture();

    const suiteInput = buildEvaluationSuiteInputV1(
      fixture.datasetId,
      fixture.cases.map((parityCase) => ({
        caseId: parityCase.caseId,
        expectations: parityCase.expectations,
        observed: parityCase.observed,
      })),
    );

    const result = new LocalEvaluationScorerV1().score(suiteInput);

    expect(result.contractVersion).toBe(1);
    expect(result.datasetId).toBe(fixture.datasetId);
    expect(result.cases).toHaveLength(15);

    for (let index = 0; index < fixture.cases.length; index += 1) {
      const parityCase = fixture.cases[index]!;
      const scored = result.cases[index]!;
      expect(scored.caseId).toBe(parityCase.caseId);
      expect(scored.passed).toBe(parityCase.expected.passed);
      expect(scored.checks).toEqual(parityCase.expected.checks);
    }

    expect(result.metrics).toEqual(fixture.expectedMetrics);
  });

  it("the frozen v1 observed shapes carry no v2 additions — no investigation, no failedStage, no completed output", () => {
    const fixture = loadFrozenFixture();
    for (const parityCase of fixture.cases) {
      expect(Object.keys(parityCase.observed).sort()).toEqual(["errorCode", "report", "retrieval", "runStatus", "tools"]);
      expect(Object.keys(parityCase.observed.tools).sort()).toEqual(["completed", "executed", "requested"]);
      for (const completed of parityCase.observed.tools.completed) {
        expect(Object.keys(completed).sort()).toEqual(["toolCallId", "toolName"]);
      }
      if (parityCase.observed.runStatus === "completed") {
        expect(Object.keys(parityCase.observed.report).sort()).toEqual(["evidence", "suggestedActionTypes"]);
      }
    }
  });
});
