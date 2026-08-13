import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
import { buildParityFixture, computeParityFixture, InvalidParityDatasetError } from "./parity-vectors";
import { buildEvaluationSuiteInputV1 } from "./v1-types";
import type { EvaluationCase } from "./types";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ts-parity-v1.json");

const FIXTURE_INJECTION_PROBE_CHUNK: StoredRunbookChunk = {
  chunkId: "fixture-injection-probe",
  runbookId: "fixture-runbook",
  title: "Fixture Injection Probe",
  content: "fixture probe content",
};

function fixtureCase(overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  return {
    id: "fixture-case",
    description: "fixture case",
    ticketContext: { ticketId: "T-1", summary: "summary" },
    retrievalQuery: "fixture",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: { id: "fixture-case", turns: [] },
    expectations: { runStatus: "completed", report: { schemaExpectation: "VALID" } },
    ...overrides,
  };
}

describe("parity fixture — TS-owned (fixtures/ts-parity-v1.json)", () => {
  it("regenerates byte-identically from the real 15-case dataset — fails if the committed fixture has drifted", async () => {
    const regenerated = await computeParityFixture();
    const committedRaw = readFileSync(FIXTURE_PATH, "utf8");
    const committed: unknown = JSON.parse(committedRaw);

    expect(regenerated).toEqual(committed);
    // Byte-identical serialized form too (same key order/formatting the
    // export script writes), not just deep-equal parsed values.
    expect(`${JSON.stringify(regenerated, null, 2)}\n`).toBe(committedRaw);
  });

  it("uses numeric contractVersion 1 and the approved datasetId", async () => {
    const fixture = await computeParityFixture();
    expect(fixture.contractVersion).toBe(1);
    expect(typeof fixture.contractVersion).toBe("number");
    expect(fixture.datasetId).toBe("opspilot-deterministic-v1");
  });

  it("covers all 15 cases, in the fixed dataset order, each with normalized input AND expected scored output", async () => {
    const fixture = await computeParityFixture();
    expect(fixture.cases).toHaveLength(15);
    expect(fixture.cases[0]?.caseId).toBe("notification-service-degradation");
    expect(fixture.cases.at(-1)?.caseId).toBe("injection-probe-structural");

    for (const parityCase of fixture.cases) {
      expect(parityCase).toHaveProperty("expectations");
      expect(parityCase).toHaveProperty("observed");
      expect(parityCase.expected).toHaveProperty("passed");
      expect(parityCase.expected).toHaveProperty("checks");
    }
  });

  it("marks every case as passed — the current 15-case dataset is fully green", async () => {
    const fixture = await computeParityFixture();
    expect(fixture.cases.every((parityCase) => parityCase.expected.passed)).toBe(true);
  });

  it("includes aggregate case totals and all six metrics", async () => {
    const fixture = await computeParityFixture();
    const metrics = fixture.expectedMetrics;

    expect(metrics.totalCases).toBe(15);
    expect(metrics.passedCases).toBe(15);
    expect(metrics.failedCases).toBe(0);
    expect(metrics.passRate).toBe(1);
    expect(metrics.retrievalTop1).toEqual({ numerator: 6, denominator: 6 });
    expect(metrics.retrievalHitAt3).toEqual({ numerator: 2, denominator: 2 });
    expect(metrics.schemaHandlingCorrectness).toEqual({ numerator: 10, denominator: 10 });
    expect(metrics.evidenceGroundingCorrectness).toEqual({ numerator: 9, denominator: 9 });
    expect(metrics.toolCorrectness).toEqual({ numerator: 11, denominator: 11 });
    expect(metrics.expectedStatusCorrectness).toEqual({ numerator: 15, denominator: 15 });
  });

  it("is independently scoreable by Python: each case carries only expectations/observed (JSON-serializable) plus the expected verdict to diff against", async () => {
    const fixture = await computeParityFixture();
    for (const parityCase of fixture.cases) {
      expect(Object.keys(parityCase).sort()).toEqual(["caseId", "expectations", "expected", "observed"].sort());
      expect(Object.keys(parityCase.expected).sort()).toEqual(["checks", "passed"]);
      // No expected/observed leaking into the wire-shaped check list itself.
      for (const check of parityCase.expected.checks) {
        expect(Object.keys(check).sort()).toEqual(["name", "passed", "reasonCode"]);
      }
    }
  });

  it("uses the exact nested v1 observed shape — retrieval.completed/chunkIds, tools.requested/executed/completed, report.evidence/suggestedActionTypes, errorCode explicit null", async () => {
    const fixture = await computeParityFixture();
    for (const parityCase of fixture.cases) {
      const { observed } = parityCase;
      expect(Object.keys(observed).sort()).toEqual(["errorCode", "report", "retrieval", "runStatus", "tools"]);
      expect(Object.keys(observed.retrieval).sort()).toEqual(["chunkIds", "completed"]);
      expect(Object.keys(observed.tools).sort()).toEqual(["completed", "executed", "requested"]);
      expect("errorCode" in observed).toBe(true);
      if (observed.runStatus === "completed") {
        expect(observed.errorCode).toBeNull();
        expect(observed.report).not.toBeNull();
        expect(Object.keys(observed.report!).sort()).toEqual(["evidence", "suggestedActionTypes"]);
      } else {
        expect(observed.errorCode).not.toBeNull();
        expect(observed.report).toBeNull();
      }
    }
  });

  it("contains none of the pre-correction legacy flat observation keys anywhere in the serialized fixture", async () => {
    const fixture = await computeParityFixture();
    const serialized = JSON.stringify(fixture);

    const legacyKeys = [
      "retrievalCompletedObserved",
      "retrievedChunkIds",
      "requestedTools",
      "executedTools",
      "completedTools",
    ];
    for (const legacyKey of legacyKeys) {
      expect(serialized).not.toContain(`"${legacyKey}"`);
    }
    // Top-level (case-observed-level) evidence/suggestedActionTypes must be
    // nested under report, never siblings of retrieval/tools/runStatus.
    for (const parityCase of fixture.cases) {
      expect(parityCase.observed).not.toHaveProperty("evidence");
      expect(parityCase.observed).not.toHaveProperty("suggestedActionTypes");
    }
  });
});

// Codex MAJOR finding 2 (OpsPilot #61 Phase 1 re-review): computeParityFixture
// must run the same validateEvaluationDataset the normal CLI path runs
// before executing anything, so a corrupted dataset edit (e.g. a duplicate
// case id) can never silently produce a corrupted committed parity fixture.
describe("computeParityFixture — validates the dataset before execution", () => {
  it("rejects duplicate case IDs supplied via overrides, aborting before suite execution", async () => {
    const dup1 = fixtureCase({ id: "dup-case", description: "first" });
    const dup2 = fixtureCase({ id: "dup-case", description: "second" });

    const attempt = computeParityFixture({
      cases: [dup1, dup2],
      loadCorpus: async () => ({ chunks: [] }),
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
    });

    await expect(attempt).rejects.toBeInstanceOf(InvalidParityDatasetError);

    // A plain execution-path error (e.g. buildParityFixture's own
    // "unreachable: no scored result" or duplicate-id guard) would NOT be an
    // InvalidParityDatasetError — only the pre-execution validation step
    // throws this specific class, so this proves the abort happened before
    // runEvaluationSuite/buildParityFixture ever ran.
    try {
      await computeParityFixture({
        cases: [dup1, dup2],
        loadCorpus: async () => ({ chunks: [] }),
        injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      });
      expect.unreachable("computeParityFixture should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidParityDatasetError);
      const validationMessages = (error as InvalidParityDatasetError).validationMessages;
      expect(validationMessages.some((message) => message.includes("duplicates an earlier case"))).toBe(true);
    }
  });

  it("still rejects a non-duplicate but otherwise invalid corpus (e.g. missing a required behavioral expectation)", async () => {
    const invalidCase = fixtureCase({ expectations: { runStatus: "completed" } });

    await expect(
      computeParityFixture({
        cases: [invalidCase],
        loadCorpus: async () => ({ chunks: [] }),
        injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      }),
    ).rejects.toBeInstanceOf(InvalidParityDatasetError);
  });

  it("the real 15-case corpus (with no overrides) remains valid and unaffected by the new validation gate", async () => {
    await expect(computeParityFixture()).resolves.not.toThrow();
  });
});

// buildParityFixture is independently exported and callable directly
// (e.g. by a future caller that already has its own suiteInput/suiteResult),
// so it must not rely solely on computeParityFixture's validation gate to
// avoid collapsing two distinct cases that happen to share a caseId.
describe("buildParityFixture — fails closed on a duplicate caseId even when called directly", () => {
  it("throws rather than silently pairing one case's expectations/observed with a different case's scored result", () => {
    const suiteInput = buildEvaluationSuiteInputV1("test-dataset", [
      { caseId: "dup-case", expectations: { runStatus: "completed" }, observed: sentinelObserved() },
      { caseId: "dup-case", expectations: { runStatus: "completed" }, observed: sentinelObserved() },
    ]);
    const suiteResult = {
      contractVersion: suiteInput.contractVersion,
      datasetId: suiteInput.datasetId,
      cases: [
        { caseId: "dup-case", passed: true, checks: [{ name: "status", passed: true, reasonCode: null }] as const },
      ],
      metrics: {
        totalCases: 1,
        passedCases: 1,
        failedCases: 0,
        passRate: 1,
        retrievalTop1: { numerator: 0, denominator: 0 },
        retrievalHitAt3: { numerator: 0, denominator: 0 },
        schemaHandlingCorrectness: { numerator: 0, denominator: 0 },
        evidenceGroundingCorrectness: { numerator: 0, denominator: 0 },
        toolCorrectness: { numerator: 0, denominator: 0 },
        expectedStatusCorrectness: { numerator: 0, denominator: 0 },
      },
    };

    expect(() => buildParityFixture(suiteInput, suiteResult)).toThrow(/duplicate case id/);
  });
});

function sentinelObserved() {
  return {
    runStatus: "completed" as const,
    errorCode: null,
    retrieval: { completed: false, chunkIds: [] },
    tools: { requested: [], executed: [], completed: [] },
    report: { evidence: [], suggestedActionTypes: [] },
  };
}

// Mapping from each of the ten approved v1 semantic traps (Phase 1
// implementation prompt, "Phase 1 semantic invariants") to the exact
// existing test coverage that proves it — per the HQ targeted corrections'
// instruction to document this mapping rather than duplicate coverage
// blindly.
//
//  1. check names and ordering
//     -> evaluation-evaluator.test.ts (per-function check-name assertions,
//        fixed push order in evaluateCase) + this file's byte-identical
//        fixture regeneration test (checks[] order frozen in fixtures/ts-parity-v1.json).
//  2. optional-vs-empty-list behavior (forbiddenChunkIds/forbiddenExecutedToolNames/
//     forbiddenCompletedToolCallIds only checked when non-empty)
//     -> evaluation-evaluator.test.ts "evaluateRetrieval"/"evaluateTool" describe blocks.
//  3. expectedNoResults truthiness behavior
//     -> evaluation-evaluator.test.ts "passes/fails retrieval-no-results ..." tests.
//  4. requested/executed/completed tool observation distinctions
//     -> evaluation-evaluator.test.ts "case 13's exact shape ..." test +
//        observed-facts.test.ts's TOOL_REQUESTED/TOOL_COMPLETED/executedTools tests.
//  5. report payload-not-available failures
//     -> evaluation-evaluator.test.ts "fails ... with the payload missing-observation reason ..." tests.
//  6. evidence-id combined check behavior
//     -> evaluation-evaluator.test.ts "passes/fails evidence-ids ..." tests (single combined check).
//  7. schema-vs-grounding expectation asymmetry
//     -> evaluation-evaluator.test.ts "evaluateReport — stage expectations" describe block.
//  8. completed-run failure-code behavior
//     -> evaluation-evaluator.test.ts "evaluateFailure" describe block.
//  9. metric denominators based on emitted checks
//     -> evaluation-metrics.test.ts (every "scopes ... to cases declaring the ... check" test).
// 10. supplied case order
//     -> evaluation-runner.test.ts "runEvaluationSuite — order preservation" describe block +
//        this file's fixture cases[] order assertions.
//
// All ten remain exercised by the tests named above; this file additionally
// proves they hold end-to-end against the real dataset via the committed
// parity fixture and the CLI golden-output test (cli-report-golden.test.ts).
describe("ten approved v1 semantic traps — documented mapping", () => {
  it("the mapping above stays anchored to a real, still-passing suite (smoke check)", async () => {
    const fixture = await computeParityFixture();
    expect(fixture.cases).toHaveLength(15);
  });
});
