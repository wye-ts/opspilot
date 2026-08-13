import { evaluateCase } from "./evaluation-evaluator";
import { aggregateMetrics } from "./evaluation-metrics";
import {
  toEvaluationCaseResultV1,
  type EvaluationSuiteInputV1,
  type EvaluationSuiteResultV1,
} from "./v1-types";

// Narrow scoring boundary, mirroring the LlmProvider/LlmProviderFactory
// pattern in packages/agent-runtime/src/providers: a scorer takes the
// normalized suite input and produces the normalized suite result. Nothing
// in this interface (or LocalEvaluationScorer below) ever references
// AgentOrchestratorResult, a trace event, or the tool recorder — a future
// HttpEvaluationScorer implementing this same interface could serialize
// `input` to JSON, POST it to FastAPI, and return the parsed JSON response,
// with no other change (see the OpsPilot #61 Phase 1 HQ targeted
// corrections, correction 5). Phase 1 (OpsPilot #61) has exactly one
// implementation, LocalEvaluationScorer — no HTTP-backed scorer exists yet.
export interface EvaluationScorer {
  score(input: EvaluationSuiteInputV1): EvaluationSuiteResultV1 | Promise<EvaluationSuiteResultV1>;
}

export class LocalEvaluationScorer implements EvaluationScorer {
  score(input: EvaluationSuiteInputV1): EvaluationSuiteResultV1 {
    const results = input.cases.map((caseInput) => evaluateCase(caseInput));
    const cases = results.map(toEvaluationCaseResultV1);
    const metrics = aggregateMetrics(cases);

    return {
      contractVersion: input.contractVersion,
      datasetId: input.datasetId,
      cases,
      metrics,
    };
  }
}

// Selection discriminated union, mirroring LlmProviderSelection. Phase 1
// supports only "LOCAL" — there is no silent service→local fallback for any
// other mode; an unrecognized mode is a configuration error (see
// resolveEvaluationScorerSelection below and CLAUDE.md).
export type EvaluationScorerSelection = { readonly scorerMode: "LOCAL" };

export const DEFAULT_EVALUATION_SCORER_SELECTION: EvaluationScorerSelection = { scorerMode: "LOCAL" };

export class UnknownEvaluationScorerModeError extends Error {
  constructor(public readonly rawScorerMode: string) {
    super(`Unknown evaluation scorer mode: ${rawScorerMode}`);
  }
}

export function createEvaluationScorer(selection: EvaluationScorerSelection): EvaluationScorer {
  switch (selection.scorerMode) {
    case "LOCAL":
      return new LocalEvaluationScorer();
    default: {
      const exhaustiveCheck: never = selection.scorerMode;
      throw new UnknownEvaluationScorerModeError(String(exhaustiveCheck));
    }
  }
}

// The parsing boundary for scorer configuration coming from outside the type
// system (e.g. a future env var or task-declaration field) — fails closed on
// anything other than {scorerMode: "LOCAL"} or undefined (which defaults to
// local). Never silently falls back to local for a recognizable-but-invalid
// value.
export function resolveEvaluationScorerSelection(raw: unknown): EvaluationScorerSelection {
  if (raw === undefined) return DEFAULT_EVALUATION_SCORER_SELECTION;

  if (typeof raw === "object" && raw !== null && "scorerMode" in raw) {
    const scorerMode = (raw as { readonly scorerMode: unknown }).scorerMode;
    if (scorerMode === "LOCAL") return { scorerMode: "LOCAL" };
    throw new UnknownEvaluationScorerModeError(String(scorerMode));
  }

  throw new UnknownEvaluationScorerModeError(typeof raw);
}
