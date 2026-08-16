import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { validateEvaluationDataset } from "./dataset-validation";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { runEvaluationSuite } from "./evaluation-runner";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import type { EvaluationCase, EvaluationExpectations, EvaluationMetrics } from "./types";
import {
  buildEvaluationSuiteInputV2,
  EVALUATION_CONTRACT_VERSION,
  EVALUATION_DATASET_ID,
  type EvaluationCheckV2,
  type EvaluationSuiteInputV2,
  type EvaluationSuiteResultV2,
} from "./v2-types";
import type { ObservedFacts } from "./observed-facts";

// The single TS-owned ACTIVE parity artifact for the current 15-case dataset
// (see the OpsPilot #61 Phase 1 plan, clarification B, and the HQ targeted
// corrections, correction 4). Unlike a plain scoring-output snapshot, this
// fixture carries BOTH the normalized inputs (caseId/expectations/observed)
// AND the expected TS scoring output (per-case passed/checks, plus
// aggregate metrics) in one document — Python Phase 2 can score `cases[]`
// independently and diff against `.expected`/`.expectedMetrics` without ever
// executing the TypeScript agent runtime. There must never be a second,
// Python-owned copy of this fixture. The historical v1 fixture
// (ts-parity-v1.json) is frozen and never regenerated — it survives only as
// the offline oracle input for legacy-v1/ (see the OpsPilot #59 Revision 5
// plan §5).
export interface ParityFixtureCaseV2 {
  readonly caseId: string;
  readonly expectations: EvaluationExpectations;
  readonly observed: ObservedFacts;
  readonly expected: {
    readonly passed: boolean;
    readonly checks: readonly EvaluationCheckV2[];
  };
}

export interface ParityFixtureV2 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly cases: readonly ParityFixtureCaseV2[];
  readonly expectedMetrics: EvaluationMetrics;
}

// Thrown by computeParityFixture when the corpus it was asked to build a
// fixture from fails the same dataset validation the normal CLI run-eval.ts
// path applies before executing anything (see validateEvaluationDataset in
// dataset-validation.ts). Fixed, application-authored message text — never
// interpolates the raw invalid case data itself, only the validator's own
// safe diagnostic strings.
export class InvalidParityDatasetError extends Error {
  constructor(public readonly validationMessages: readonly string[]) {
    super(
      `Parity fixture generation aborted: evaluation dataset failed validation (${validationMessages.length} issue(s)).`,
    );
  }
}

// Pure: merges an already-computed suite input with its already-computed
// suite result (matched by caseId) into the combined fixture shape,
// preserving supplied case order exactly. Fails closed on a duplicate
// caseId within suiteInput rather than silently collapsing two distinct
// cases onto whichever one happens to be resolved last from
// resultsByCaseId — computeParityFixture's own validateEvaluationDataset
// call is the primary guard, but buildParityFixture is independently
// exported and callable directly, so it must not trust that a caller ran
// that validation first.
export function buildParityFixture(
  suiteInput: EvaluationSuiteInputV2,
  suiteResult: EvaluationSuiteResultV2,
): ParityFixtureV2 {
  const seenCaseIds = new Set<string>();
  for (const caseInput of suiteInput.cases) {
    if (seenCaseIds.has(caseInput.caseId)) {
      throw new Error(`buildParityFixture: duplicate case id "${caseInput.caseId}" in suiteInput.cases.`);
    }
    seenCaseIds.add(caseInput.caseId);
  }

  const resultsByCaseId = new Map(suiteResult.cases.map((result) => [result.caseId, result]));

  return {
    contractVersion: suiteInput.contractVersion,
    datasetId: suiteInput.datasetId,
    cases: suiteInput.cases.map((caseInput) => {
      const result = resultsByCaseId.get(caseInput.caseId);
      if (!result) {
        throw new Error(`unreachable: no scored result found for case "${caseInput.caseId}"`);
      }
      return {
        caseId: caseInput.caseId,
        expectations: caseInput.expectations,
        observed: caseInput.observed,
        expected: { passed: result.passed, checks: result.checks },
      };
    }),
    expectedMetrics: suiteResult.metrics,
  };
}

// Loads the real corpus and runs the real, fixed 15-case dataset (the same
// path run-eval.ts's CLI uses), scores it with the real LocalEvaluationScorer,
// then builds the combined parity fixture from it. Dependencies are
// injectable for tests, matching the pattern in run-eval.ts's
// EvaluationDependencies.
export async function computeParityFixture(
  overrides: {
    readonly cases?: readonly EvaluationCase[];
    readonly loadCorpus?: () => Promise<{ readonly chunks: readonly StoredRunbookChunk[] }>;
    readonly injectionProbeChunk?: StoredRunbookChunk;
  } = {},
): Promise<ParityFixtureV2> {
  const cases = overrides.cases ?? EVALUATION_CASES;
  const loadCorpus = overrides.loadCorpus ?? loadDefaultRunbookCorpus;
  const injectionProbeChunk = overrides.injectionProbeChunk ?? INJECTION_PROBE_CHUNK;

  const corpusLoad = await loadCorpus();

  const validationMessages = validateEvaluationDataset({
    cases,
    defaultCorpus: corpusLoad.chunks,
    injectionProbeChunk,
  });
  if (validationMessages.length > 0) {
    throw new InvalidParityDatasetError(validationMessages);
  }

  const caseInputs = await runEvaluationSuite({
    cases,
    defaultCorpus: corpusLoad.chunks,
    injectionProbeChunk,
  });

  const suiteInput = buildEvaluationSuiteInputV2(EVALUATION_DATASET_ID, caseInputs);
  const suiteResult = new LocalEvaluationScorer().score(suiteInput);

  return buildParityFixture(suiteInput, suiteResult);
}
