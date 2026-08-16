import { evaluateCase } from "./evaluation-evaluator";
import { aggregateMetrics } from "./evaluation-metrics";
import {
  toEvaluationCaseResultV2,
  type EvaluationSuiteInputV2,
  type EvaluationSuiteResultV2,
} from "./v2-types";
import { createHttpEvaluationScorer } from "./evaluation-service-client";
import {
  MAX_EVALUATION_SERVICE_TIMEOUT_MS,
  MIN_EVALUATION_SERVICE_TIMEOUT_MS,
} from "./evaluation-scorer-config";

// Narrow scoring boundary, mirroring the LlmProvider/LlmProviderFactory
// pattern in packages/agent-runtime/src/providers: a scorer takes the
// normalized suite input and produces the normalized suite result. Nothing
// in this interface (or either implementation below) ever references
// AgentOrchestratorResult, a trace event, or the tool recorder — the remote
// scorer serializes `input` to JSON, POSTs it to FastAPI, and returns the
// parsed JSON response (see the OpsPilot #61 Phase 1 HQ targeted
// corrections, correction 5). Two implementations: LocalEvaluationScorer,
// the active in-process v2 scorer, and HttpEvaluationScorer, the
// Python/FastAPI service client and default, authoritative scorer as of
// Phase 4 (see DEFAULT_EVALUATION_SCORER_SELECTION and
// resolveScorerSelectionFromEnv). There is deliberately no automatic
// fallback between them, in either direction (see
// service-unavailable.test.ts). The historical v1 scorer survives only as
// the frozen offline oracle in legacy-v1/ (never on this active path).
export interface EvaluationScorer {
  score(input: EvaluationSuiteInputV2): EvaluationSuiteResultV2 | Promise<EvaluationSuiteResultV2>;
}

// LocalEvaluationScorer = the active in-process v2 scorer.
//
// As of OpsPilot #61 Phase 4, the Python/FastAPI evaluation service is the
// default, authoritative scorer (HttpEvaluationScorer, selected via
// EVALUATION_SCORER=service or the unset/empty default). This class is the
// explicit EVALUATION_SCORER=local opt-in: a deterministic, in-process v2
// regression/parity scorer for comparison against the service. At
// Checkpoint A it implements only the existing low-level checks (PASS/FAIL)
// and the six existing metrics — the nine #59 metric rules belong to
// Checkpoint B. The frozen v1 migration/parity oracle that previously lived
// here has moved to legacy-v1/local-scorer-v1.ts (see the OpsPilot #59
// Revision 5 plan §5).
export class LocalEvaluationScorer implements EvaluationScorer {
  score(input: EvaluationSuiteInputV2): EvaluationSuiteResultV2 {
    const results = input.cases.map((caseInput) => evaluateCase(caseInput));
    const cases = results.map(toEvaluationCaseResultV2);
    const metrics = aggregateMetrics(cases);

    return {
      contractVersion: input.contractVersion,
      datasetId: input.datasetId,
      cases,
      metrics,
    };
  }
}

// Selection discriminated union, mirroring LlmProviderSelection. "LOCAL" runs
// LocalEvaluationScorer in-process (the active v2 scorer, explicit opt-in
// only as of Phase 4); "SERVICE" posts the same normalized v2 suite to the
// Python/FastAPI evaluation service over HTTP (the default, authoritative
// scorer as of Phase 4 — see resolveScorerSelectionFromEnv). There is no
// silent fallback between the two modes in either direction — an unreachable
// service fails the evaluation, and an unrecognized mode is a configuration
// error (see resolveEvaluationScorerSelection below and CLAUDE.md).
export type EvaluationScorerSelection =
  | { readonly scorerMode: "LOCAL" }
  | { readonly scorerMode: "SERVICE"; readonly serviceUrl: string; readonly timeoutMs: number };

// The bare LOCAL selection, used only as run-eval.ts's DEFAULT_DEPENDENCIES
// fallback for direct/test callers of runEvaluation() that supply no
// scorerSelection and no scorer at all. This is NOT the CLI's real default —
// the CLI entry point always resolves EvaluationScorerSelection from the
// environment via resolveScorerSelectionFromEnv (default: SERVICE as of
// Phase 4) and passes it in explicitly. A SERVICE constant can't play this
// same role without inventing a serviceUrl default, which is deliberately
// not done (see evaluation-scorer-config.ts).
export const DEFAULT_EVALUATION_SCORER_SELECTION: EvaluationScorerSelection = { scorerMode: "LOCAL" };

export class UnknownEvaluationScorerModeError extends Error {
  constructor(public readonly rawScorerMode: string) {
    super(`Unknown evaluation scorer mode: ${rawScorerMode}`);
  }
}

// A recognized SERVICE selection that still cannot be built — missing/empty
// serviceUrl or an out-of-bounds timeoutMs. Distinct from
// UnknownEvaluationScorerModeError so callers can tell "not a mode at all"
// from "the mode is SERVICE but its required fields are invalid".
export class InvalidEvaluationScorerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvaluationScorerSelectionError";
  }
}

export function createEvaluationScorer(selection: EvaluationScorerSelection): EvaluationScorer {
  switch (selection.scorerMode) {
    case "LOCAL":
      return new LocalEvaluationScorer();
    case "SERVICE":
      return createHttpEvaluationScorer(selection.serviceUrl, selection.timeoutMs);
    default: {
      // Exhaustiveness check on the whole selection (accessing
      // selection.scorerMode on the never-narrowed default arm would itself
      // be a type error); the cast is the narrow escape hatch to still name
      // the offending mode in the thrown error.
      const exhaustiveCheck: never = selection;
      throw new UnknownEvaluationScorerModeError(
        (exhaustiveCheck as { readonly scorerMode: string }).scorerMode,
      );
    }
  }
}

// The parsing boundary for scorer configuration coming from outside the type
// system (e.g. a future env var or task-declaration field) — fails closed on
// anything other than a valid LOCAL/SERVICE selection or undefined (which
// defaults to local). Never silently falls back to local for a
// recognizable-but-invalid value.
export function resolveEvaluationScorerSelection(raw: unknown): EvaluationScorerSelection {
  if (raw === undefined) return DEFAULT_EVALUATION_SCORER_SELECTION;

  if (typeof raw === "object" && raw !== null && "scorerMode" in raw) {
    const scorerMode = (raw as { readonly scorerMode: unknown }).scorerMode;
    if (scorerMode === "LOCAL") return { scorerMode: "LOCAL" };

    if (scorerMode === "SERVICE") {
      const selection = raw as {
        readonly scorerMode: "SERVICE";
        readonly serviceUrl?: unknown;
        readonly timeoutMs?: unknown;
      };
      const { serviceUrl, timeoutMs } = selection;
      if (typeof serviceUrl !== "string" || serviceUrl.length === 0) {
        throw new InvalidEvaluationScorerSelectionError(
          "SERVICE scorer selection requires a non-empty serviceUrl.",
        );
      }
      if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < MIN_EVALUATION_SERVICE_TIMEOUT_MS ||
        timeoutMs > MAX_EVALUATION_SERVICE_TIMEOUT_MS
      ) {
        throw new InvalidEvaluationScorerSelectionError(
          `SERVICE scorer selection requires timeoutMs to be an integer between ` +
            `${MIN_EVALUATION_SERVICE_TIMEOUT_MS} and ${MAX_EVALUATION_SERVICE_TIMEOUT_MS}.`,
        );
      }
      return { scorerMode: "SERVICE", serviceUrl, timeoutMs };
    }

    throw new UnknownEvaluationScorerModeError(String(scorerMode));
  }

  throw new UnknownEvaluationScorerModeError(typeof raw);
}
