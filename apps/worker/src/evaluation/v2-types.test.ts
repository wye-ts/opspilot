import { describe, expect, it } from "vitest";

import { evaluateCase } from "./evaluation-evaluator";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { NonJsonSafeValueError, type JsonValue } from "./json-value";
import type { NotApplicableCode } from "./not-applicable-codes";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseResult, EvaluationExpectations } from "./types";
import {
  buildEvaluationCaseInputV2,
  buildEvaluationSuiteInputV2,
  toEvaluationCaseResultV2,
  type EvaluationCheckV2,
  type EvaluationSuiteInputV2,
} from "./v2-types";

// v2 completed-run observed facts with a full Milestone-11 investigation.
// Never used by scoring here — only to give buildEvaluationCaseInputV2 the
// normalized observed half of a case.
function observedWithExecuted(
  executed: readonly { readonly toolName: string; readonly input: JsonValue }[] = [],
): ObservedFacts {
  return {
    runStatus: "completed",
    errorCode: null,
    retrieval: { completed: false, chunkIds: [] },
    tools: { requested: [], executed, completed: [] },
    report: {
      evidence: [],
      suggestedActionTypes: [],
      category: "SERVICE_DEGRADATION",
      rootCausePresent: true,
      confidence: 0.5,
      evidenceState: "SUFFICIENT",
      recommendationDisposition: "ADVISORY",
      suggestedActions: [],
    },
    investigation: {
      providerTurnsUsed: 0,
      diagnosticRequestCount: 0,
      forcedFinalization: false,
      stopReason: "SUFFICIENT_EVIDENCE",
      assessments: [],
      toolFailures: [],
      bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
      usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
    },
    failedStage: null,
  };
}

// Correction 3 (OpsPilot #61 Phase 1 HQ targeted corrections): the wire/parity
// result must not expose EvaluationCheckResult's internal expected/observed
// echoes. This is the exact boundary where that stripping happens —
// toEvaluationCaseResultV2 — so this is where the "no expected/observed
// leaks into the serialized wire shape" proof belongs.
describe("toEvaluationCaseResultV2 — wire boundary strips expected/observed", () => {
  const internalResult: EvaluationCaseResult = {
    caseId: "sentinel-case",
    passed: false,
    checks: [
      { name: "status", status: "PASS", expected: "completed", observed: "completed" },
      {
        name: "retrieval-top1",
        status: "FAIL",
        expected: "SENTINEL-expected-chunk-id",
        observed: { rawPrompt: "SENTINEL_RAW_PROMPT", path: "/private/tmp/sentinel/should-not-appear" },
        reasonCode: "RETRIEVAL_TOP1_MISMATCH",
      },
    ],
    observed: {
      runStatus: "completed",
      errorCode: null,
      retrieval: { completed: true, chunkIds: ["a"] },
      tools: { requested: [], executed: [], completed: [] },
      report: {
        evidence: [],
        suggestedActionTypes: [],
        category: "SERVICE_DEGRADATION",
        rootCausePresent: true,
        confidence: 0.5,
        evidenceState: "SUFFICIENT",
        recommendationDisposition: "ADVISORY",
        suggestedActions: [],
      },
      investigation: {
        providerTurnsUsed: 0,
        diagnosticRequestCount: 0,
        forcedFinalization: false,
        stopReason: "SUFFICIENT_EVIDENCE",
        assessments: [],
        toolFailures: [],
        bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
        usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
      },
      failedStage: null,
    },
  };

  it("the mapped result has no expected/observed key anywhere, at any level", () => {
    const wireResult = toEvaluationCaseResultV2(internalResult);

    expect(wireResult).not.toHaveProperty("observed");
    for (const check of wireResult.checks) {
      expect(check).not.toHaveProperty("expected");
      expect(check).not.toHaveProperty("observed");
    }
  });

  it("the serialized JSON string contains no 'expected' or 'observed' key and no planted sentinel value", () => {
    const wireResult = toEvaluationCaseResultV2(internalResult);
    const serialized = JSON.stringify(wireResult);

    expect(serialized).not.toContain('"expected"');
    expect(serialized).not.toContain('"observed"');
    expect(serialized).not.toContain("SENTINEL");
    expect(serialized).not.toContain("/private/tmp/sentinel");
  });

  it("preserves caseId, passed, and per-check name/status/reasonCode exactly", () => {
    const wireResult = toEvaluationCaseResultV2(internalResult);

    expect(wireResult).toEqual({
      caseId: "sentinel-case",
      passed: false,
      checks: [
        { name: "status", status: "PASS", reasonCode: null },
        { name: "retrieval-top1", status: "FAIL", reasonCode: "RETRIEVAL_TOP1_MISMATCH" },
      ],
    });
  });

  it("a passing check maps reasonCode to null, never undefined — a stable wire representation across languages", () => {
    const wireResult = toEvaluationCaseResultV2(internalResult);
    expect(wireResult.checks[0]?.reasonCode).toBeNull();
    expect("reasonCode" in wireResult.checks[0]!).toBe(true);
  });
});

// OpsPilot #59 Checkpoint A test 6: EvaluationCheckV2 structurally supports
// NOT_APPLICABLE — the third state is representable in the discriminated
// union (with a closed NotApplicableCode), survives the internal→wire
// conversion, and the union still rejects a mismatched status/reason pairing
// at compile time. The active scorer at Checkpoint A emits PASS/FAIL only;
// this proves the *contract* is ready for the NOT_APPLICABLE state the
// Checkpoint-B checks will emit, without implementing any of them.
describe("EvaluationCheckV2 — NOT_APPLICABLE structural support", () => {
  const notApplicableResult: EvaluationCaseResult = {
    caseId: "na-case",
    passed: true,
    checks: [
      {
        name: "approval-gate",
        status: "NOT_APPLICABLE",
        expected: "APPROVAL_ELIGIBILITY",
        observed: { suggestionCount: 0 },
        reasonCode: "NA_RUN_DID_NOT_COMPLETE",
      },
    ],
    observed: {
      runStatus: "completed",
      errorCode: null,
      retrieval: { completed: false, chunkIds: [] },
      tools: { requested: [], executed: [], completed: [] },
      report: {
        evidence: [],
        suggestedActionTypes: [],
        category: "SERVICE_DEGRADATION",
        rootCausePresent: true,
        confidence: 0.5,
        evidenceState: "SUFFICIENT",
        recommendationDisposition: "ADVISORY",
        suggestedActions: [],
      },
      investigation: {
        providerTurnsUsed: 0,
        diagnosticRequestCount: 0,
        forcedFinalization: false,
        stopReason: "SUFFICIENT_EVIDENCE",
        assessments: [],
        toolFailures: [],
        bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
        usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
      },
      failedStage: null,
    },
  };

  it("maps an internal NOT_APPLICABLE check to the wire NOT_APPLICABLE shape with its closed code, and never fails the case", () => {
    const wireResult = toEvaluationCaseResultV2(notApplicableResult);

    expect(wireResult.checks).toEqual([
      { name: "approval-gate", status: "NOT_APPLICABLE", reasonCode: "NA_RUN_DID_NOT_COMPLETE" },
    ]);
    expect(wireResult.passed).toBe(true);
  });

  it("compile-time: every one of the three NotApplicableCode members is a valid NOT_APPLICABLE reasonCode", () => {
    const codes: readonly NotApplicableCode[] = [
      "NA_RUN_DID_NOT_COMPLETE",
      "NA_EXPECTATION_NOT_DECLARED",
      "NA_NO_RECOVERY_PATH_EXERCISED",
    ];
    for (const code of codes) {
      // Each member constructs the discriminated NOT_APPLICABLE variant.
      const check: EvaluationCheckV2 = { name: "some-check", status: "NOT_APPLICABLE", reasonCode: code };
      expect(check.status).toBe("NOT_APPLICABLE");
    }
  });

  it("compile-time: a NOT_APPLICABLE check with a CheckReasonCode is rejected by the union", () => {
    // @ts-expect-error — a NOT_APPLICABLE check must carry a NotApplicableCode,
    // never a CheckReasonCode like RETRIEVAL_TOP1_MISMATCH.
    const invalid: EvaluationCheckV2 = { name: "retrieval-top1", status: "NOT_APPLICABLE", reasonCode: "RETRIEVAL_TOP1_MISMATCH" };
    expect(invalid.status).toBe("NOT_APPLICABLE");
  });

  it("compile-time: a PASS check with a NotApplicableCode is rejected by the union", () => {
    // @ts-expect-error — a PASS check must carry reasonCode null.
    const invalid: EvaluationCheckV2 = { name: "approval-gate", status: "PASS", reasonCode: "NA_EXPECTATION_NOT_DECLARED" };
    expect(invalid.status).toBe("PASS");
  });
});

// Codex MAJOR finding 1 (OpsPilot #61 Phase 1 re-review): observed tool
// inputs already cross the JSON-safe boundary via toJsonValue (see
// observed-facts.ts), but expectations.tool.expectedExecuted[].input did
// not — a dataset literal typed as JsonValue can still carry a runtime
// value (e.g. NaN) that isn't actually JSON-safe, so the same case could
// score differently in TypeScript than after a real JSON round-trip. This
// is the fix at buildEvaluationCaseInputV2, the one explicit construction
// boundary for EvaluationCaseInputV2.
describe("buildEvaluationCaseInputV2 — normalizes expectedExecuted inputs through the JSON-safe boundary", () => {
  it("a valid nested expectedExecuted input survives the builder and a JSON round-trip unchanged", () => {
    const input = { a: 1, nested: { b: [1, "x", null, true] } };
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input }] },
    };

    const caseInput = buildEvaluationCaseInputV2("case-1", expectations, observedWithExecuted());

    expect(caseInput.expectations.tool?.expectedExecuted).toEqual([{ toolName: "t", input }]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(caseInput));
    expect((roundTripped as typeof caseInput).expectations.tool?.expectedExecuted).toEqual([
      { toolName: "t", input },
    ]);
  });

  it("rejects a NaN expected executed-tool input before serialization/scoring, even though JsonValue's type allows any `number`", () => {
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input: { value: Number.NaN } }] },
    };

    expect(() => buildEvaluationCaseInputV2("case-1", expectations, observedWithExecuted())).toThrow(
      NonJsonSafeValueError,
    );
  });

  it("rejects an Infinity expected executed-tool input", () => {
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input: { value: Number.POSITIVE_INFINITY } }] },
    };

    expect(() => buildEvaluationCaseInputV2("case-1", expectations, observedWithExecuted())).toThrow(
      NonJsonSafeValueError,
    );
  });

  it("rejects bigint and undefined expected executed-tool input values per the existing JSON-safe policy", () => {
    const bigintExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input: { count: 1n } }] },
    } as unknown as EvaluationExpectations;
    expect(() => buildEvaluationCaseInputV2("case-1", bigintExpectations, observedWithExecuted())).toThrow(
      NonJsonSafeValueError,
    );

    const undefinedExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input: { a: undefined } }] },
    } as unknown as EvaluationExpectations;
    expect(() => buildEvaluationCaseInputV2("case-1", undefinedExpectations, observedWithExecuted())).toThrow(
      NonJsonSafeValueError,
    );
  });

  it("rejects an expectedExecuted input containing a sparse array before scoring/serialization — closing the historical local-vs-serialized divergence", () => {
    const sparseExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input: { items: Array(1) } }] },
    } as unknown as EvaluationExpectations;

    // Codex's exact reproduction: expected input carries a hole (Array(1)),
    // observed carries the dense equivalent JSON.stringify would have
    // produced from that same hole ([null]). Before this fix, the sparse
    // expected array would survive normalization unchanged and only
    // diverge from the observed value's dense [null] once one side (but not
    // the other) had been through a real JSON boundary. buildEvaluationCaseInputV2
    // now throws before that expected input can ever reach evaluateCase, so
    // the sparse value never reaches local scoring at all — there is no
    // "local verdict" to diverge from a "serialized verdict" because the
    // sparse input is rejected outright, deterministically, at construction.
    expect(() =>
      buildEvaluationCaseInputV2(
        "case-1",
        sparseExpectations,
        observedWithExecuted([{ toolName: "t", input: { items: [null] } }]),
      ),
    ).toThrow(NonJsonSafeValueError);
  });

  it("does not mutate the source expectations object", () => {
    const expectedExecuted = [{ toolName: "t", input: { a: 1 } }] as const;
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted },
    };

    buildEvaluationCaseInputV2("case-1", expectations, observedWithExecuted());

    expect(expectations.tool?.expectedExecuted).toBe(expectedExecuted);
  });

  it("a valid expected tool input still matches the same normalized observed tool input under evaluateCase", () => {
    const input = { a: 1, nested: { b: [1, "x", null, true] } };
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input }] },
    };
    const observed = observedWithExecuted([{ toolName: "t", input }]);

    const caseInput = buildEvaluationCaseInputV2("case-1", expectations, observed);
    const result = evaluateCase(caseInput);

    expect(result.checks.find((check) => check.name === "tool-executed")?.status).toBe("PASS");
  });

  it("LocalEvaluationScorer produces an identical result before and after a JSON round-trip for a case with expectedExecuted", () => {
    const input = { a: 1, nested: { b: [1, "x", null, true] } };
    const expectations: EvaluationExpectations = {
      runStatus: "completed",
      tool: { expectedExecuted: [{ toolName: "t", input }] },
    };
    const observed = observedWithExecuted([{ toolName: "t", input }]);

    const caseInput = buildEvaluationCaseInputV2("case-1", expectations, observed);
    const suiteInput = buildEvaluationSuiteInputV2("test-dataset", [caseInput]);
    const roundTripped: EvaluationSuiteInputV2 = JSON.parse(JSON.stringify(suiteInput));

    expect(new LocalEvaluationScorer().score(suiteInput)).toEqual(
      new LocalEvaluationScorer().score(roundTripped),
    );
  });
});
