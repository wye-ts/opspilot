import type { CheckReasonCode } from "./check-reason-codes";
import { toJsonValue } from "./json-value";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseResult, EvaluationExpectations, EvaluationMetrics } from "./types";

// The v1 cross-language evaluation contract, as frozen by the approved
// Revision 3 plan for OpsPilot #61: a SUITE-level request/response, not a
// per-case protocol. TypeScript owns building EvaluationSuiteInputV1 (one
// dataset's worth of case expectations + observed run facts); a future
// Python/FastAPI scorer is intended to consume it whole and produce an
// EvaluationSuiteResultV1 over HTTP. Phase 1 only fixes these shapes ahead
// of that boundary — no HTTP caller exists yet, and the current in-process
// LocalEvaluationScorer remains the sole scorer (see evaluation-scorer.ts).
export const EVALUATION_CONTRACT_VERSION = 1 as const;
export const EVALUATION_DATASET_ID = "opspilot-deterministic-v1" as const;

// One case's normalized input: exactly what a scorer needs and nothing
// else — never a raw AgentOrchestratorResult, trace event, or
// ResolutionReport (see observed-facts.ts).
export interface EvaluationCaseInputV1 {
  readonly caseId: string;
  readonly expectations: EvaluationExpectations;
  readonly observed: ObservedFacts;
}

export interface EvaluationSuiteInputV1 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseInputV1[];
}

// EvaluationExpectations.tool.expectedExecuted[].input is typed as
// JsonValue, but that's a compile-time-only guarantee: a dataset literal can
// still contain a runtime value (e.g. NaN, which is a `number` at the type
// level) that isn't actually JSON-safe. `observed` already crosses this same
// boundary through toJsonValue (see observed-facts.ts), so an unvalidated
// expected input could make LocalEvaluationScorer and a JSON/Python scorer
// disagree on the exact same case — this is the one explicit conversion path
// for v1 expectations that closes that gap. Never mutates the source
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

export function buildEvaluationCaseInputV1(
  caseId: string,
  expectations: EvaluationExpectations,
  observed: ObservedFacts,
): EvaluationCaseInputV1 {
  return { caseId, expectations: normalizeExpectedExecutedInputs(caseId, expectations), observed };
}

export function buildEvaluationSuiteInputV1(
  datasetId: string,
  cases: readonly EvaluationCaseInputV1[],
): EvaluationSuiteInputV1 {
  return { contractVersion: EVALUATION_CONTRACT_VERSION, datasetId, cases };
}

// The wire/parity check shape: deliberately excludes `expected`/`observed`
// (see EvaluationCheckResult in types.ts, which is TS-internal-only and may
// keep them for local test/debug purposes).
//
// A discriminated union, not three independent fields — fixing an
// independent-review finding that the prior shape let TypeScript construct
// `{passed: false, reasonCode: null}` (a failing check with no reason,
// silently rendered as the generic "check failed") and
// `{passed: true, reasonCode: "SOME_CODE"}` (a passing check carrying a
// stray failure code), neither of which the frozen result contract permits.
// `reasonCode` is `null` — never `undefined` — for a passing check, so the
// shape serializes identically regardless of language/JSON library.
export type EvaluationCheckV1 =
  | { readonly name: string; readonly passed: true; readonly reasonCode: null }
  | { readonly name: string; readonly passed: false; readonly reasonCode: CheckReasonCode };

export interface EvaluationCaseResultV1 {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckV1[];
}

// The suite-level scoring result: per-case check name/order/passed/reasonCode,
// per-case passed, aggregate case totals, and all six aggregate metrics — all
// via the existing, already-tested EvaluationMetrics shape (see
// evaluation-metrics.ts's aggregateMetrics). No expected/observed anywhere.
export interface EvaluationSuiteResultV1 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseResultV1[];
  readonly metrics: EvaluationMetrics;
}

// Strips the TS-internal expected/observed echoes off an EvaluationCheckResult,
// producing the wire-safe EvaluationCheckV1 the cross-language result may
// contain. Throws if the internal invariant "reasonCode is present iff
// passed === false" (see EvaluationCheckResult in types.ts) is ever
// violated — this is what makes the discriminated EvaluationCheckV1 return
// type actually sound rather than merely declared.
export function toEvaluationCaseResultV1(result: EvaluationCaseResult): EvaluationCaseResultV1 {
  return {
    caseId: result.caseId,
    passed: result.passed,
    checks: result.checks.map((check): EvaluationCheckV1 => {
      if (check.passed) {
        return { name: check.name, passed: true, reasonCode: null };
      }
      if (check.reasonCode === undefined) {
        throw new Error(
          `Invariant violated: failing check "${check.name}" on case "${result.caseId}" has no reasonCode`,
        );
      }
      return { name: check.name, passed: false, reasonCode: check.reasonCode };
    }),
  };
}
