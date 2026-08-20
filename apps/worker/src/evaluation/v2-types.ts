import type { CheckReasonCode } from "./check-reason-codes";
import { isCheckReasonCode } from "./check-reason-codes";
import { toJsonValue } from "./json-value";
import { isNotApplicableCode, type NotApplicableCode } from "./not-applicable-codes";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseResult, EvaluationExpectations, EvaluationMetrics } from "./types";

// The v2 cross-language evaluation contract, as fixed by the approved
// Revision 5 plan for OpsPilot #59 Checkpoint A: the active internal
// contract that carries the Milestone-11 observation facts (see
// observed-facts.ts) and the three-state check outcome. TypeScript owns
// building EvaluationSuiteInputV2 (one dataset's worth of case expectations
// + observed run facts); the Python/FastAPI scorer consumes it whole over
// HTTP and produces an EvaluationSuiteResultV2 (contractVersion 2 only —
// v1 is unwired from the active runtime and survives solely as the frozen
// offline oracle in legacy-v1/, see the OpsPilot #59 Revision 5 plan §5).
//
// This v2 state is an internal transitional branch state and is not
// considered externally frozen until #59 merges.
export const EVALUATION_CONTRACT_VERSION = 2 as const;
export const EVALUATION_DATASET_ID = "opspilot-deterministic-v2" as const;

// One case's normalized input: exactly what a scorer needs and nothing
// else — never a raw AgentOrchestratorResult, trace event, or
// ResolutionReport (see observed-facts.ts).
export interface EvaluationCaseInputV2 {
  readonly caseId: string;
  readonly expectations: EvaluationExpectations;
  readonly observed: ObservedFacts;
}

export interface EvaluationSuiteInputV2 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseInputV2[];
}

// EvaluationExpectations.tool.expectedExecuted[].input is typed as
// JsonValue, but that's a compile-time-only guarantee: a dataset literal can
// still contain a runtime value (e.g. NaN, which is a `number` at the type
// level) that isn't actually JSON-safe. `observed` already crosses this same
// boundary through toJsonValue (see observed-facts.ts), so an unvalidated
// expected input could make LocalEvaluationScorer and a JSON/Python scorer
// disagree on the exact same case — this is the one explicit conversion path
// for v2 expectations that closes that gap. Never mutates the source
// `expectations` object; only `tool.expectedExecuted` is replaced.
function normalizeExpectedExecutedInputs(
  caseId: string,
  expectations: EvaluationExpectations,
): EvaluationExpectations {
  const expectedExecuted = expectations.tool?.expectedExecuted;
  if (expectedExecuted === undefined) return expectations;

  const normalizedExpectedExecuted = expectedExecuted.map((entry, index) => ({
    toolName: entry.toolName,
    input: toJsonValue(entry.input, `case[${caseId}].expectations.tool.expectedExecuted[${index}].input`),
  }));

  return {
    ...expectations,
    tool: { ...expectations.tool, expectedExecuted: normalizedExpectedExecuted },
  };
}

export function buildEvaluationCaseInputV2(
  caseId: string,
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCaseInputV2 {
  return { caseId, expectations: normalizeExpectedExecutedInputs(caseId, expectations), observed };
}

export function buildEvaluationSuiteInputV2(
  datasetId: string,
  cases: readonly EvaluationCaseInputV2[],
): EvaluationSuiteInputV2 {
  return { contractVersion: EVALUATION_CONTRACT_VERSION, datasetId, cases };
}

// The wire/parity check shape: deliberately excludes `expected`/`observed`
// (see EvaluationCheckResult in types.ts, which is TS-internal-only and may
// keep them for local test/debug purposes).
//
// A discriminated union, not three independent fields — the same
// invariant-encoding the v1 check carried (see v1-types.ts), advanced to the
// three-state v2 model. A PASS check has reasonCode null; a FAIL check must
// carry a CheckReasonCode; a NOT_APPLICABLE check must carry a
// NotApplicableCode. `reasonCode` is `null` — never `undefined` — for a
// passing check, so the shape serializes identically regardless of
// language/JSON library.
export type EvaluationCheckV2 =
  | { readonly name: string; readonly status: "PASS"; readonly reasonCode: null }
  | { readonly name: string; readonly status: "FAIL"; readonly reasonCode: CheckReasonCode }
  | { readonly name: string; readonly status: "NOT_APPLICABLE"; readonly reasonCode: NotApplicableCode };

export interface EvaluationCaseResultV2 {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckV2[];
}

// The suite-level scoring result: per-case check name/order/status/reasonCode,
// per-case passed, aggregate case totals, and all six aggregate metrics — all
// via the existing, already-tested EvaluationMetrics shape (see
// evaluation-metrics.ts's aggregateMetrics). No expected/observed anywhere.
// A case passes iff no check has status === "FAIL".
export interface EvaluationSuiteResultV2 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseResultV2[];
  readonly metrics: EvaluationMetrics;
}

// Strips the TS-internal expected/observed echoes off an EvaluationCheckResult,
// producing the wire-safe EvaluationCheckV2 the cross-language result may
// contain. Throws if the internal invariant "a non-PASS check always carries
// the reason code its status requires" (see EvaluationCheckResult in
// types.ts) is ever violated — this is what makes the discriminated
// EvaluationCheckV2 return type actually sound rather than merely declared.
export function toEvaluationCaseResultV2(result: EvaluationCaseResult): EvaluationCaseResultV2 {
  return {
    caseId: result.caseId,
    passed: result.passed,
    checks: result.checks.map((check): EvaluationCheckV2 => {
      switch (check.status) {
        case "PASS":
          return { name: check.name, status: "PASS", reasonCode: null };
        case "FAIL":
          if (check.reasonCode === undefined || !isCheckReasonCode(check.reasonCode)) {
            throw new Error(
              `Invariant violated: failing check "${check.name}" on case "${result.caseId}" has no valid CheckReasonCode`,
            );
          }
          return { name: check.name, status: "FAIL", reasonCode: check.reasonCode };
        case "NOT_APPLICABLE":
          if (check.reasonCode === undefined || !isNotApplicableCode(check.reasonCode)) {
            throw new Error(
              `Invariant violated: not-applicable check "${check.name}" on case "${result.caseId}" has no valid NotApplicableCode`,
            );
          }
          return { name: check.name, status: "NOT_APPLICABLE", reasonCode: check.reasonCode };
      }
    }),
  };
}
