// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): the historical
// v1 migration/parity oracle, preserved so it keeps reproducing the frozen
// ts-parity-v1.json fixture forever. It is unwired from the active runtime —
// never constructed by the active evaluation path, never accepted by POST
// /evaluations, and never a second authoritative scorer (see the OpsPilot
// #59 Revision 5 plan §5 and the "Revisit trigger" this file supersedes in
// the active evaluation-scorer.ts).
import { evaluateCaseV1 } from "./evaluator-v1";
import { aggregateMetricsV1 } from "./metrics-v1";
import { toEvaluationCaseResultV1, type EvaluationSuiteInputV1, type EvaluationSuiteResultV1 } from "./v1-types";

// LocalEvaluationScorerV1 = frozen v1 migration/parity oracle.
//
// Historical note (as recorded in the original evaluation-scorer.ts this was
// carved from): as of OpsPilot #61 Phase 4, the Python/FastAPI evaluation
// service is the default, authoritative scorer; the in-process v1 scorer was
// kept only as an explicit EVALUATION_SCORER=local opt-in regression/parity
// oracle. Its v1 scoring semantics are frozen and must not change.
export class LocalEvaluationScorerV1 {
  score(input: EvaluationSuiteInputV1): EvaluationSuiteResultV1 {
    const results = input.cases.map((caseInput) => evaluateCaseV1(caseInput));
    const cases = results.map(toEvaluationCaseResultV1);
    const metrics = aggregateMetricsV1(cases);

    return {
      contractVersion: input.contractVersion,
      datasetId: input.datasetId,
      cases,
      metrics,
    };
  }
}
