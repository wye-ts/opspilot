import { describe, expect, it, vi } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { RunbookLoadError } from "../rag/markdown-runbook-loader";
import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationScorer } from "./evaluation-scorer";
import {
  EvaluationServiceUnavailableError,
  EvaluationServiceTimeoutError,
  type EvaluationServiceErrorCategory,
} from "./evaluation-service-errors";
import {
  getExitCode,
  renderEvaluationOutput,
  renderEvaluationResolution,
  renderScorerConfigError,
  resolveEvaluationRun,
  runEvaluation,
  type EvaluationOutcome,
  type EvaluationRunResolution,
} from "./run-eval";
import type { EvaluationCase } from "./types";
import type { EvaluationCaseInputV2, EvaluationCaseResultV2 } from "./v2-types";

const FIXTURE_CORPUS: readonly StoredRunbookChunk[] = [
  { chunkId: "fixture-chunk-1", runbookId: "fixture-runbook", title: "Fixture", content: "fixture content" },
];

const FIXTURE_INJECTION_PROBE_CHUNK: StoredRunbookChunk = {
  chunkId: "fixture-injection-probe",
  runbookId: "fixture-runbook",
  title: "Fixture Probe",
  content: "fixture probe content",
};

function validCase(id: string): EvaluationCase {
  return {
    id,
    description: "synthetic",
    ticketContext: { ticketId: "T-1", summary: "s" },
    retrievalQuery: "q",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: { id, turns: [] },
    expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } },
  };
}

// The content of the normalized case input doesn't matter for the
// runEvaluation-level tests below — scoring is stubbed separately via
// stubScorer(), which ignores its input and returns a canned suite result.
// This is only here so deps.runSuite has something type-correct to resolve
// to.
function dummyCaseInput(id: string): EvaluationCaseInputV2 {
  return {
    caseId: id,
    expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } },
    observed: {
      runStatus: "failed",
      errorCode: "TOOL_NOT_FOUND",
      retrieval: { completed: false, chunkIds: [] },
      tools: { requested: [], executed: [], completed: [] },
      report: null,
      investigation: {
        providerTurnsUsed: 0,
        diagnosticRequestCount: 0,
        forcedFinalization: false,
        stopReason: null,
        assessments: [],
        toolFailures: [],
        bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
        usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
      },
      failedStage: "DIAGNOSTIC_EXECUTION",
    },
  };
}

function stubScorer(cases: readonly EvaluationCaseResultV2[]): EvaluationScorer {
  return {
    score: (input) => ({
      contractVersion: input.contractVersion,
      datasetId: input.datasetId,
      cases,
      metrics: aggregateMetrics(cases),
    }),
  };
}

function passingResult(caseId: string): EvaluationCaseResultV2 {
  return { caseId, passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] };
}

function failingResult(caseId: string): EvaluationCaseResultV2 {
  return { caseId, passed: false, checks: [{ name: "status", status: "FAIL", reasonCode: "STATUS_MISMATCH" }] };
}

describe("runEvaluation", () => {
  it("returns an 'executed' outcome with zero failed cases when the injected scorer reports all cases passing", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: stubScorer([passingResult("synthetic-1")]),
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.metrics.failedCases).toBe(0);
    expect(getExitCode(outcome)).toBe(0);
    expect(runSuite).toHaveBeenCalledTimes(1);
  });

  it("returns an 'executed' outcome with a nonzero exit code when the injected scorer reports a failing case", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: stubScorer([failingResult("synthetic-1")]),
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.metrics.failedCases).toBe(1);
    expect(getExitCode(outcome)).toBe(1);
  });

  it("returns a 'configuration-error' outcome and never calls runSuite, when dataset validation fails", async () => {
    const runSuite = vi.fn();
    const invalidCase: EvaluationCase = {
      ...validCase("invalid"),
      expectations: { runStatus: "completed" }, // no behavioral expectation beyond runStatus
    };

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [invalidCase],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
    });

    expect(outcome.kind).toBe("configuration-error");
    if (outcome.kind !== "configuration-error") throw new Error("unreachable");
    expect(outcome.message.length).toBeGreaterThan(0);
    expect(getExitCode(outcome)).toBe(1);
    expect(runSuite).not.toHaveBeenCalled();
  });

  it("propagates a RunbookLoadError thrown by loadCorpus, uncaught", async () => {
    const loadCorpus = async (): Promise<never> => {
      throw new RunbookLoadError("DIRECTORY_NOT_FOUND", "Runbooks directory not found.");
    };

    await expect(
      runEvaluation({ loadCorpus, cases: [validCase("synthetic-1")], injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK }),
    ).rejects.toBeInstanceOf(RunbookLoadError);
  });

  it("uses the real LocalEvaluationScorer (default scorerSelection) end-to-end when no scorer override is given", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    // dummyCaseInput's expectations/observed agree (failed/TOOL_NOT_FOUND),
    // so the real local scorer marks it passed.
    expect(outcome.results).toEqual([{ caseId: "synthetic-1", passed: true, checks: expect.any(Array) }]);
  });
});

describe("resolveEvaluationRun", () => {
  it("wraps a simulated RunbookLoadError into a 'setup-error' resolution, carrying only the fixed category enum", async () => {
    const loadCorpus = async (): Promise<never> => {
      throw new RunbookLoadError(
        "DIRECTORY_NOT_FOUND",
        "Runbooks directory not found at /some/real/absolute/path.",
      );
    };

    const resolution = await resolveEvaluationRun({ loadCorpus, cases: [validCase("synthetic-1")] });

    expect(resolution).toEqual({ kind: "setup-error", category: "DIRECTORY_NOT_FOUND" });
  });

  it("wraps an unexpected non-RunbookLoadError into an 'unexpected-error' resolution carrying no message at all", async () => {
    const loadCorpus = async (): Promise<never> => {
      throw new Error("simulated unexpected internal failure: connection refused at 10.0.0.9");
    };

    const resolution = await resolveEvaluationRun({ loadCorpus, cases: [validCase("synthetic-1")] });

    expect(resolution).toEqual({ kind: "unexpected-error" });
  });

  it("passes through an 'outcome' resolution for a normal run", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);
    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: stubScorer([passingResult("synthetic-1")]),
    });

    expect(resolution.kind).toBe("outcome");
  });

  it("maps an EvaluationServiceError from the scorer into a 'scoring-error' resolution carrying only the category", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);
    const failingScorer: EvaluationScorer = {
      score: async () => {
        throw new EvaluationServiceUnavailableError();
      },
    };

    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: failingScorer,
    });

    expect(resolution).toEqual({ kind: "scoring-error", category: "SERVICE_UNAVAILABLE" });
  });

  it("maps a timeout to the TIMEOUT scoring-error category, distinct from SERVICE_UNAVAILABLE", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);
    const failingScorer: EvaluationScorer = {
      score: async () => {
        throw new EvaluationServiceTimeoutError();
      },
    };

    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: failingScorer,
    });

    expect(resolution).toEqual({ kind: "scoring-error", category: "TIMEOUT" });
  });

  it("never leaks the raw EvaluationServiceError message into the scoring-error resolution", async () => {
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);
    const failingScorer: EvaluationScorer = {
      score: async () => {
        throw new EvaluationServiceUnavailableError("secret postgres password in the error message");
      },
    };

    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorer: failingScorer,
    });

    expect(resolution).toEqual({ kind: "scoring-error", category: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(resolution)).not.toContain("password");
  });
});

describe("renderEvaluationResolution — three distinct CLI error categories", () => {
  it("renders a dataset validation failure as 'Dataset configuration error:', reporting zero executed cases", () => {
    const resolution: EvaluationRunResolution = {
      kind: "outcome",
      outcome: { kind: "configuration-error", message: "Every evaluation case must have a non-empty id." },
    };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toContain("Dataset configuration error: Every evaluation case must have a non-empty id.");
    expect(rendered.output).toContain("Cases executed: 0");
    expect(rendered.output).not.toContain("Evaluation setup error");
    expect(rendered.output).not.toContain("Evaluation failed unexpectedly");
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
  });

  it("renders a RunbookLoadError (setup failure) as 'Evaluation setup error:', not as a dataset configuration error", () => {
    const resolution: EvaluationRunResolution = { kind: "setup-error", category: "DIRECTORY_NOT_FOUND" };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toContain("Evaluation setup error: could not load the runbook corpus (DIRECTORY_NOT_FOUND).");
    expect(rendered.output).toContain("Cases executed: 0");
    expect(rendered.output).not.toContain("Dataset configuration error");
    expect(rendered.output).not.toContain("Evaluation failed unexpectedly");
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
  });

  it("renders an unexpected error as the single fixed 'Evaluation failed unexpectedly.' message, distinct from the other two categories", () => {
    const resolution: EvaluationRunResolution = { kind: "unexpected-error" };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toBe("OpsPilot Evaluation\n\nEvaluation failed unexpectedly.");
    expect(rendered.output).not.toContain("Dataset configuration error");
    expect(rendered.output).not.toContain("Evaluation setup error");
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
  });

  it("renders an all-passing executed outcome as the formatted report with exit code 0", () => {
    const resolution: EvaluationRunResolution = {
      kind: "outcome",
      outcome: {
        kind: "executed",
        results: [passingResult("synthetic-1")],
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
          expectedStatusCorrectness: { numerator: 1, denominator: 1 },
        },
      },
    };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toContain("PASS synthetic-1");
    expect(rendered.isError).toBe(false);
    expect(rendered.exitCode).toBe(0);
  });

  it("renders an executed outcome containing a failing case with exit code 1", () => {
    const resolution: EvaluationRunResolution = {
      kind: "outcome",
      outcome: {
        kind: "executed",
        results: [failingResult("synthetic-1")],
        metrics: {
          totalCases: 1,
          passedCases: 0,
          failedCases: 1,
          passRate: 0,
          retrievalTop1: { numerator: 0, denominator: 0 },
          retrievalHitAt3: { numerator: 0, denominator: 0 },
          schemaHandlingCorrectness: { numerator: 0, denominator: 0 },
          evidenceGroundingCorrectness: { numerator: 0, denominator: 0 },
          toolCorrectness: { numerator: 0, denominator: 0 },
          expectedStatusCorrectness: { numerator: 0, denominator: 1 },
        },
      },
    };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toContain("FAIL synthetic-1");
    expect(rendered.exitCode).toBe(1);
  });
});

describe("renderEvaluationResolution — remote scoring failures", () => {
  it("renders a scoring-error as 'Evaluation scoring error:', with no local fallback, zero executed cases, and exit code 1", () => {
    const resolution: EvaluationRunResolution = { kind: "scoring-error", category: "SERVICE_UNAVAILABLE" };

    const rendered = renderEvaluationResolution(resolution);

    expect(rendered.output).toContain(
      "Evaluation scoring error: the evaluation service is unreachable.",
    );
    expect(rendered.output).toContain("No local scorer fallback; exiting without a result.");
    expect(rendered.output).toContain("Cases executed: 0");
    expect(rendered.output).not.toContain("Dataset configuration error");
    expect(rendered.output).not.toContain("Evaluation setup error");
    expect(rendered.output).not.toContain("Evaluation failed unexpectedly");
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
  });

  it("renders each remote-scoring failure category with its fixed safe copy", () => {
    const expectations: Record<EvaluationServiceErrorCategory, string> = {
      SERVICE_UNAVAILABLE: "the evaluation service is unreachable",
      TIMEOUT: "the evaluation service request timed out",
      HTTP_ERROR: "the evaluation service returned an error status",
      MALFORMED_RESPONSE: "the evaluation service returned a malformed response",
      UNSUPPORTED_VERSION: "the evaluation service returned an unsupported contract version",
    };

    for (const [category, copy] of Object.entries(expectations)) {
      const resolution: EvaluationRunResolution = {
        kind: "scoring-error",
        category: category as EvaluationServiceErrorCategory,
      };
      const rendered = renderEvaluationResolution(resolution);
      expect(rendered.output).toContain(`Evaluation scoring error: ${copy}.`);
      expect(rendered.output).toContain("No local scorer fallback; exiting without a result.");
      expect(rendered.isError).toBe(true);
      expect(rendered.exitCode).toBe(1);
    }
  });
});

describe("renderScorerConfigError — fail-closed scorer configuration", () => {
  it("renders an invalid scorer configuration as an 'Evaluation configuration error:', zero executed cases, exit code 1", () => {
    const rendered = renderScorerConfigError(
      "EVALUATION_SERVICE_URL is required when EVALUATION_SCORER=service.",
    );

    expect(rendered.output).toContain(
      "Evaluation configuration error: EVALUATION_SERVICE_URL is required when EVALUATION_SCORER=service.",
    );
    expect(rendered.output).toContain("Cases executed: 0");
    expect(rendered.output).not.toContain("Evaluation failed unexpectedly");
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
  });
});

describe("renderEvaluationOutput — final top-level rendering guard", () => {
  it("passes through normally for every resolution kind when rendering does not throw", () => {
    const resolution: EvaluationRunResolution = { kind: "unexpected-error" };
    expect(renderEvaluationOutput(resolution)).toEqual(renderEvaluationResolution(resolution));
  });

  it("falls back to the single fixed unexpected-failure message when rendering itself throws, after an outcome has already been produced, without leaking the raw thrown error", () => {
    // Deliberately malformed: metrics is missing every field formatEvaluationReport
    // reads, so formatEvaluationReport throws partway through rendering — this
    // simulates an injected formatter/rendering failure that occurs strictly
    // after a real evaluation resolution has been produced.
    const malformedOutcome = {
      kind: "executed",
      results: [],
      metrics: undefined,
    } as unknown as EvaluationOutcome;
    const resolution: EvaluationRunResolution = { kind: "outcome", outcome: malformedOutcome };

    expect(() => renderEvaluationResolution(resolution)).toThrow();

    const rendered = renderEvaluationOutput(resolution);

    expect(rendered).toEqual({
      output: "OpsPilot Evaluation\n\nEvaluation failed unexpectedly.",
      isError: true,
      exitCode: 1,
    });
    expect(rendered.output).not.toContain("Cannot read properties");
    expect(rendered.output).not.toContain("undefined");
  });
});
