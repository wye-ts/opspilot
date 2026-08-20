// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): the historical
// v1 wire contract, preserved so the offline v1 regression oracle can
// reproduce the frozen ts-parity-v1.json fixture forever. Unwired from the
// active runtime — the active contract is ../v2-types.ts, and the active
// service accepts contractVersion 2 only.
//
// The v1 cross-language evaluation contract, as frozen by the approved
// Revision 3 plan for OpsPilot #61: a SUITE-level request/response, not a
// per-case protocol. TypeScript owns building EvaluationSuiteInputV1 (one
// dataset's worth of case expectations + observed run facts); a Python/
// FastAPI scorer is intended to consume it whole and produce an
// EvaluationSuiteResultV1 over HTTP.
import type { CheckReasonCode } from "./check-reason-codes-v1";
import type { ObservedFactsV1 } from "./observed-facts-v1";
import type { EvaluationCaseResultV1Internal, EvaluationExpectations } from "./types-v1";

export const EVALUATION_CONTRACT_VERSION_V1 = 1 as const;
export const EVALUATION_DATASET_ID_V1 = "opspilot-deterministic-v1" as const;

// One case's normalized v1 input: exactly what a scorer needs and nothing
// else — never a raw AgentOrchestratorResult, trace event, or
// ResolutionReport (see observed-facts-v1.ts).
export interface EvaluationCaseInputV1 {
  readonly caseId: string;
  readonly expectations: EvaluationExpectations;
  readonly observed: ObservedFactsV1;
}

export interface EvaluationSuiteInputV1 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION_V1;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseInputV1[];
}

// The v1 wire/parity check shape: a discriminated union with no
// expected/observed echoes. A passing check carries reasonCode null; a
// failing check must carry a CheckReasonCode. `reasonCode` is `null` — never
// `undefined` — for a passing check, so the shape serializes identically
// regardless of language/JSON library.
export type EvaluationCheckV1 =
  | { readonly name: string; readonly passed: true; readonly reasonCode: null }
  | { readonly name: string; readonly passed: false; readonly reasonCode: CheckReasonCode };

export interface EvaluationCaseResultV1 {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckV1[];
}

// The v1 suite-level scoring result: per-case check name/order/passed/reasonCode,
// per-case passed, aggregate case totals, and all six aggregate metrics.
// No expected/observed anywhere.
export interface EvaluationSuiteResultV1 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION_V1;
  readonly datasetId: string;
  readonly cases: readonly EvaluationCaseResultV1[];
  readonly metrics: EvaluationMetricsV1;
}

// The historical v1 EvaluationMetrics — structurally identical to the active
// type at Checkpoint A (the six ratios are unchanged), restated here so the
// frozen oracle does not depend on the active types.ts for its result shape.
export interface EvaluationMetricsV1 {
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
}

export function buildEvaluationCaseInputV1(
  caseId: string,
  expectations: EvaluationExpectations,
  observed: ObservedFactsV1,
): EvaluationCaseInputV1 {
  return { caseId, expectations, observed };
}

export function buildEvaluationSuiteInputV1(
  datasetId: string,
  cases: readonly EvaluationCaseInputV1[],
): EvaluationSuiteInputV1 {
  return { contractVersion: EVALUATION_CONTRACT_VERSION_V1, datasetId, cases };
}

// Strips the TS-internal expected/observed echoes off an EvaluationCheckResultV1,
// producing the wire-safe EvaluationCheckV1 the cross-language result may
// contain. Throws if the internal invariant "reasonCode is present iff
// passed === false" (see EvaluationCheckResultV1 in types-v1.ts) is ever
// violated — this is what makes the discriminated EvaluationCheckV1 return
// type actually sound rather than merely declared.
export function toEvaluationCaseResultV1(result: EvaluationCaseResultV1Internal): EvaluationCaseResultV1 {
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
