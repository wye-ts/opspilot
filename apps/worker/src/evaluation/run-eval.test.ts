import { describe, expect, it, vi } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { RunbookLoadError } from "../rag/markdown-runbook-loader";
import {
  getExitCode,
  renderEvaluationOutput,
  renderEvaluationResolution,
  resolveEvaluationRun,
  runEvaluation,
  type EvaluationOutcome,
  type EvaluationRunResolution,
} from "./run-eval";
import type { EvaluationCase, EvaluationCaseResult } from "./types";

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

function passingResult(caseId: string): EvaluationCaseResult {
  return {
    caseId,
    passed: true,
    checks: [{ name: "status", passed: true, expected: "failed", observed: "failed" }],
    observed: {
      runStatus: "failed",
      retrievalCompletedObserved: false,
      retrievedChunkIds: [],
      requestedTools: [],
      executedTools: [],
      completedToolCallIds: [],
      evidenceIds: [],
      errorCode: "TOOL_NOT_FOUND",
    },
  };
}

function failingResult(caseId: string): EvaluationCaseResult {
  return {
    caseId,
    passed: false,
    checks: [
      { name: "status", passed: false, expected: "failed", observed: "completed", reason: "mismatch" },
    ],
    observed: {
      runStatus: "completed",
      retrievalCompletedObserved: false,
      retrievedChunkIds: [],
      requestedTools: [],
      executedTools: [],
      completedToolCallIds: [],
      evidenceIds: [],
    },
  };
}

describe("runEvaluation", () => {
  it("returns an 'executed' outcome with zero failed cases when the injected runSuite stub reports all cases passing", async () => {
    const runSuite = vi.fn().mockResolvedValue([passingResult("synthetic-1")]);

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
    });

    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") throw new Error("unreachable");
    expect(outcome.metrics.failedCases).toBe(0);
    expect(getExitCode(outcome)).toBe(0);
    expect(runSuite).toHaveBeenCalledTimes(1);
  });

  it("returns an 'executed' outcome with a nonzero exit code when the injected runSuite stub reports a failing case", async () => {
    const runSuite = vi.fn().mockResolvedValue([failingResult("synthetic-1")]);

    const outcome = await runEvaluation({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
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
    const runSuite = vi.fn().mockResolvedValue([passingResult("synthetic-1")]);
    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
    });

    expect(resolution.kind).toBe("outcome");
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
