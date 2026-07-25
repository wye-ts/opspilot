import { fileURLToPath } from "node:url";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { INJECTION_PROBE_CHUNK, RunbookLoadError, loadDefaultRunbookCorpus } from "../rag";
import type { RunbookCorpusLoadResult, RunbookLoadErrorCategory } from "../rag/markdown-runbook-loader";
import { validateEvaluationDataset } from "./dataset-validation";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { formatEvaluationReport } from "./evaluation-formatter";
import { aggregateMetrics } from "./evaluation-metrics";
import { runEvaluationSuite } from "./evaluation-runner";
import type { EvaluationCase, EvaluationCaseResult, EvaluationMetrics } from "./types";

const UNEXPECTED_FAILURE_MESSAGE = "OpsPilot Evaluation\n\nEvaluation failed unexpectedly.";

export interface EvaluationRunOutcome {
  readonly kind: "executed";
  readonly results: readonly EvaluationCaseResult[];
  readonly metrics: EvaluationMetrics;
}

export interface EvaluationConfigFailure {
  readonly kind: "configuration-error";
  readonly message: string;
}

export type EvaluationOutcome = EvaluationRunOutcome | EvaluationConfigFailure;

export interface EvaluationDependencies {
  readonly loadCorpus: () => Promise<RunbookCorpusLoadResult>;
  readonly cases: readonly EvaluationCase[];
  readonly injectionProbeChunk: StoredRunbookChunk;
  readonly runSuite: typeof runEvaluationSuite;
}

const DEFAULT_DEPENDENCIES: EvaluationDependencies = {
  loadCorpus: loadDefaultRunbookCorpus,
  cases: EVALUATION_CASES,
  injectionProbeChunk: INJECTION_PROBE_CHUNK,
  runSuite: runEvaluationSuite,
};

// Composition root: loads the real Markdown corpus once, validates the
// dataset before any case executes, then runs the suite. Dependencies are
// injectable so tests can exercise every branch (validation failure, a
// failing case, a simulated corpus-load error) without a real orchestrator
// run (see docs/07-evaluation-plan.md). May reject with a RunbookLoadError
// or an unexpected error — resolveEvaluationRun is the only caller that
// must catch it.
export async function runEvaluation(
  overrides: Partial<EvaluationDependencies> = {},
): Promise<EvaluationOutcome> {
  const deps: EvaluationDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  const corpusLoad = await deps.loadCorpus();
  const defaultCorpus = corpusLoad.chunks;

  const validationMessages = validateEvaluationDataset({
    cases: deps.cases,
    defaultCorpus,
    injectionProbeChunk: deps.injectionProbeChunk,
  });

  if (validationMessages.length > 0) {
    return { kind: "configuration-error", message: validationMessages[0]! };
  }

  const results = await deps.runSuite({
    cases: deps.cases,
    defaultCorpus,
    injectionProbeChunk: deps.injectionProbeChunk,
  });
  const metrics = aggregateMetrics(results);

  return { kind: "executed", results, metrics };
}

// Three, and only three, distinct fatal-resolution categories — kept
// separate so a dataset-authoring mistake is never rendered under the same
// label as a filesystem/runtime failure (see docs/07-evaluation-plan.md).
export type EvaluationRunResolution =
  | { readonly kind: "outcome"; readonly outcome: EvaluationOutcome }
  | { readonly kind: "setup-error"; readonly category: RunbookLoadErrorCategory }
  | { readonly kind: "unexpected-error" };

// The only place that catches runEvaluation's rejections — turns a known
// RunbookLoadError into a "setup-error" resolution carrying only its fixed,
// already-safe category enum value, and any other thrown error into an
// "unexpected-error" resolution with no message at all. Neither branch ever
// reads error.message/stack/cause.
export async function resolveEvaluationRun(
  overrides: Partial<EvaluationDependencies> = {},
): Promise<EvaluationRunResolution> {
  try {
    const outcome = await runEvaluation(overrides);
    return { kind: "outcome", outcome };
  } catch (error) {
    if (error instanceof RunbookLoadError) {
      return { kind: "setup-error", category: error.category };
    }
    return { kind: "unexpected-error" };
  }
}

export function getExitCode(outcome: EvaluationOutcome): number {
  if (outcome.kind === "configuration-error") return 1;
  return outcome.metrics.failedCases > 0 ? 1 : 0;
}

export interface RenderedEvaluationOutput {
  readonly output: string;
  readonly isError: boolean;
  readonly exitCode: number;
}

// One small, pure rendering function covering every CLI resolution branch —
// testable directly, with no subprocess. It may itself throw (e.g. if
// formatEvaluationReport throws on unexpectedly-shaped data); the caller
// (main, below) is responsible for treating that as an "unexpected failure"
// too, via the same fixed message.
export function renderEvaluationResolution(resolution: EvaluationRunResolution): RenderedEvaluationOutput {
  if (resolution.kind === "unexpected-error") {
    return { output: UNEXPECTED_FAILURE_MESSAGE, isError: true, exitCode: 1 };
  }

  if (resolution.kind === "setup-error") {
    return {
      output: `OpsPilot Evaluation\n\nEvaluation setup error: could not load the runbook corpus (${resolution.category}).\n\nCases executed: 0`,
      isError: true,
      exitCode: 1,
    };
  }

  const { outcome } = resolution;
  if (outcome.kind === "configuration-error") {
    return {
      output: `OpsPilot Evaluation\n\nDataset configuration error: ${outcome.message}\n\nCases executed: 0`,
      isError: true,
      exitCode: 1,
    };
  }

  return {
    output: formatEvaluationReport(outcome.results, outcome.metrics),
    isError: false,
    exitCode: getExitCode(outcome),
  };
}

// The final application-authored error boundary around rendering itself:
// renderEvaluationResolution can in principle throw (e.g. a bug in
// formatEvaluationReport surfacing on unexpectedly-shaped data) — this
// wrapper never does. It is what makes "an evaluation resolution has
// already been produced, but rendering it then fails" fall back to the
// same single fixed UNEXPECTED_FAILURE_MESSAGE, never the underlying
// error's message/stack/cause. Directly testable with no subprocess.
export function renderEvaluationOutput(resolution: EvaluationRunResolution): RenderedEvaluationOutput {
  try {
    return renderEvaluationResolution(resolution);
  } catch {
    return { output: UNEXPECTED_FAILURE_MESSAGE, isError: true, exitCode: 1 };
  }
}

// Genuinely top-level: every operation in the entry-point path — resolving
// the run AND rendering its output — is inside this one try/catch, so no
// unexpected failure (including one from rendering itself, after a real
// evaluation outcome has already been produced) can escape as an unhandled
// rejection. Falls back to the single fixed UNEXPECTED_FAILURE_MESSAGE,
// never the underlying error's message/stack/cause.
async function main(): Promise<void> {
  let rendered: RenderedEvaluationOutput;
  try {
    const resolution = await resolveEvaluationRun();
    rendered = renderEvaluationOutput(resolution);
  } catch {
    rendered = { output: UNEXPECTED_FAILURE_MESSAGE, isError: true, exitCode: 1 };
  }

  if (rendered.isError) {
    console.error(rendered.output);
  } else {
    console.log(rendered.output);
  }
  process.exitCode = rendered.exitCode;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  // A final safety net, not the primary guard (main's own try/catch already
  // covers everything reachable above) — this only exists so main() is
  // never invoked as a bare, unguarded promise.
  main().catch(() => {
    console.error(UNEXPECTED_FAILURE_MESSAGE);
    process.exitCode = 1;
  });
}
