import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AgentOrchestratorResult } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";
import { evaluateCase } from "./evaluation-evaluator";
import {
  createEvaluationScorer,
  DEFAULT_EVALUATION_SCORER_SELECTION,
  InvalidEvaluationScorerSelectionError,
  LocalEvaluationScorer,
  resolveEvaluationScorerSelection,
  UnknownEvaluationScorerModeError,
  type EvaluationScorer,
} from "./evaluation-scorer";
import { HttpEvaluationScorer } from "./evaluation-service-client";
import { aggregateMetrics } from "./evaluation-metrics";
import { buildObservedFacts } from "./observed-facts";
import type { EvaluationCase } from "./types";
import {
  buildEvaluationCaseInputV1,
  buildEvaluationSuiteInputV1,
  toEvaluationCaseResultV1,
  type EvaluationSuiteInputV1,
  type EvaluationSuiteResultV1,
} from "./v1-types";

const VALID_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "summary",
  rootCause: "root cause",
  customerImpact: "impact",
  recommendedResolution: "resolution",
  confidence: 0.5,
  evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "finding" }],
  evidenceState: "SUFFICIENT",
  suggestedActions: [],
};

function buildCase(): EvaluationCase {
  return {
    id: "synthetic-case",
    description: "synthetic",
    ticketContext: { ticketId: "T-1", summary: "summary" },
    retrievalQuery: "query",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: { id: "synthetic-case", turns: [] },
    expectations: { runStatus: "completed", report: { schemaExpectation: "VALID" } },
  };
}

const agentResult: AgentOrchestratorResult = { status: "completed", report: VALID_REPORT, trace: [] };

describe("LocalEvaluationScorer", () => {
  it("produces the exact same per-case result (mapped to wire shape) as calling evaluateCase directly", () => {
    const evaluationCase = buildCase();
    const observed = buildObservedFacts(agentResult, []);
    const caseInput = buildEvaluationCaseInputV1(evaluationCase.id, evaluationCase.expectations, observed);
    const suiteInput = buildEvaluationSuiteInputV1("test-dataset", [caseInput]);

    const direct = evaluateCase(caseInput);
    const viaScorer = new LocalEvaluationScorer().score(suiteInput);

    expect(viaScorer.cases).toEqual([toEvaluationCaseResultV1(direct)]);
    expect(viaScorer.metrics).toEqual(aggregateMetrics([toEvaluationCaseResultV1(direct)]));
    expect(viaScorer.contractVersion).toBe(suiteInput.contractVersion);
    expect(viaScorer.datasetId).toBe("test-dataset");
  });

  it("accepts only the normalized EvaluationSuiteInputV1 shape — no AgentOrchestratorResult, trace, or tool-recorder parameter exists on score()", () => {
    // Structural proof for correction 1/5: score() takes exactly one
    // parameter. There is no second/third parameter a caller could use to
    // smuggle a raw runtime object past the normalized boundary.
    expect(LocalEvaluationScorer.prototype.score).toHaveLength(1);

    const evaluationCase = buildCase();
    const observed = buildObservedFacts(agentResult, []);
    const caseInput = buildEvaluationCaseInputV1(evaluationCase.id, evaluationCase.expectations, observed);
    const suiteInput = buildEvaluationSuiteInputV1("test-dataset", [caseInput]);

    // The only fields score() can read are exactly these — contractVersion/
    // datasetId/cases[caseId/expectations/observed].
    expect(Object.keys(suiteInput).sort()).toEqual(["cases", "contractVersion", "datasetId"]);
    expect(Object.keys(suiteInput.cases[0]!).sort()).toEqual(["caseId", "expectations", "observed"]);

    expect(() => new LocalEvaluationScorer().score(suiteInput)).not.toThrow();
  });

  it("EvaluationCaseInputV1.observed is the exact nested v1 shape — not the pre-correction flat shape", () => {
    const evaluationCase = buildCase();
    const observed = buildObservedFacts(agentResult, []);
    const caseInput = buildEvaluationCaseInputV1(evaluationCase.id, evaluationCase.expectations, observed);

    expect(Object.keys(caseInput.observed).sort()).toEqual([
      "errorCode",
      "report",
      "retrieval",
      "runStatus",
      "tools",
    ]);
    expect(caseInput.observed).not.toHaveProperty("retrievalCompletedObserved");
    expect(caseInput.observed).not.toHaveProperty("retrievedChunkIds");
    expect(caseInput.observed).not.toHaveProperty("requestedTools");
    expect(caseInput.observed).not.toHaveProperty("executedTools");
    expect(caseInput.observed).not.toHaveProperty("completedTools");
  });

  it("LocalEvaluationScorer scores identically whether observed came from buildObservedFacts or was reconstructed from parsed JSON — proving it depends only on the nested shape, not on runtime object identity", () => {
    const evaluationCase = buildCase();
    const observed = buildObservedFacts(agentResult, []);
    const caseInput = buildEvaluationCaseInputV1(evaluationCase.id, evaluationCase.expectations, observed);
    const suiteInput = buildEvaluationSuiteInputV1("test-dataset", [caseInput]);

    // Round-trip through JSON — simulates "loaded from the parity fixture"
    // or "received over HTTP", with no TypeScript class/runtime object left.
    const roundTripped: EvaluationSuiteInputV1 = JSON.parse(JSON.stringify(suiteInput));

    expect(new LocalEvaluationScorer().score(suiteInput)).toEqual(
      new LocalEvaluationScorer().score(roundTripped),
    );
  });
});

describe("a future HTTP scorer can implement EvaluationScorer using only normalized types", () => {
  it("compiles and runs against nothing but EvaluationSuiteInputV1/EvaluationSuiteResultV1 — no AgentOrchestratorResult/trace/tool-recorder import required", async () => {
    // This class never imports @opspilot/agent-runtime, RecordedToolExecution,
    // or any trace-event type — it only ever touches EvaluationSuiteInputV1/
    // EvaluationSuiteResultV1. A real HttpEvaluationScorer would replace the
    // body with `fetch(url, {body: JSON.stringify(input)})` and nothing else
    // about this shape would need to change (see correction 5).
    class StubHttpEvaluationScorer implements EvaluationScorer {
      constructor(private readonly canned: EvaluationSuiteResultV1) {}
      async score(input: EvaluationSuiteInputV1): Promise<EvaluationSuiteResultV1> {
        // A real implementation would serialize `input` to JSON and POST it;
        // here we just prove the interface is satisfiable and the input is
        // JSON-serializable (no functions/classes/undefined survive it).
        JSON.parse(JSON.stringify(input));
        return this.canned;
      }
    }

    const evaluationCase = buildCase();
    const observed = buildObservedFacts(agentResult, []);
    const caseInput = buildEvaluationCaseInputV1(evaluationCase.id, evaluationCase.expectations, observed);
    const suiteInput = buildEvaluationSuiteInputV1("test-dataset", [caseInput]);

    const canned: EvaluationSuiteResultV1 = {
      contractVersion: suiteInput.contractVersion,
      datasetId: suiteInput.datasetId,
      cases: [{ caseId: "synthetic-case", passed: true, checks: [{ name: "status", passed: true, reasonCode: null }] }],
      metrics: aggregateMetrics([
        { caseId: "synthetic-case", passed: true, checks: [{ name: "status", passed: true, reasonCode: null }] },
      ]),
    };

    const scorer: EvaluationScorer = new StubHttpEvaluationScorer(canned);
    const result = await scorer.score(suiteInput);
    expect(result).toEqual(canned);
  });
});

describe("createEvaluationScorer", () => {
  it("returns a LocalEvaluationScorer for scorerMode LOCAL", () => {
    expect(createEvaluationScorer({ scorerMode: "LOCAL" })).toBeInstanceOf(LocalEvaluationScorer);
  });

  it("returns an HttpEvaluationScorer for a valid SERVICE selection — and never a LocalEvaluationScorer", () => {
    const scorer = createEvaluationScorer({
      scorerMode: "SERVICE",
      serviceUrl: "http://127.0.0.1:8001",
      timeoutMs: 20_000,
    });
    expect(scorer).toBeInstanceOf(HttpEvaluationScorer);
    expect(scorer).not.toBeInstanceOf(LocalEvaluationScorer);
  });
});

describe("resolveEvaluationScorerSelection — SERVICE mode fail closed", () => {
  it("accepts a valid SERVICE selection with a bounded timeout", () => {
    expect(
      resolveEvaluationScorerSelection({
        scorerMode: "SERVICE",
        serviceUrl: "http://127.0.0.1:8001",
        timeoutMs: 20_000,
      }),
    ).toEqual({ scorerMode: "SERVICE", serviceUrl: "http://127.0.0.1:8001", timeoutMs: 20_000 });
  });

  it("rejects a SERVICE selection missing its serviceUrl", () => {
    expect(() =>
      resolveEvaluationScorerSelection({ scorerMode: "SERVICE", timeoutMs: 20_000 }),
    ).toThrow(InvalidEvaluationScorerSelectionError);
  });

  it("rejects a SERVICE selection with an empty serviceUrl", () => {
    expect(() =>
      resolveEvaluationScorerSelection({ scorerMode: "SERVICE", serviceUrl: "", timeoutMs: 20_000 }),
    ).toThrow(InvalidEvaluationScorerSelectionError);
  });

  it("rejects a SERVICE selection with a non-integer or out-of-bounds timeout", () => {
    for (const timeoutMs of [500, 999_999, 1.5, Number.NaN]) {
      expect(() =>
        resolveEvaluationScorerSelection({
          scorerMode: "SERVICE",
          serviceUrl: "http://127.0.0.1:8001",
          timeoutMs,
        }),
      ).toThrow(InvalidEvaluationScorerSelectionError);
    }
  });
});

describe("resolveEvaluationScorerSelection — fail closed", () => {
  it("defaults to LOCAL when no configuration is supplied", () => {
    expect(resolveEvaluationScorerSelection(undefined)).toEqual(DEFAULT_EVALUATION_SCORER_SELECTION);
  });

  it("accepts an explicit {scorerMode: 'LOCAL'} selection", () => {
    expect(resolveEvaluationScorerSelection({ scorerMode: "LOCAL" })).toEqual({ scorerMode: "LOCAL" });
  });

  it("throws, rather than silently falling back to local, for an unrecognized scorerMode string", () => {
    expect(() => resolveEvaluationScorerSelection({ scorerMode: "REMOTE" })).toThrow(
      UnknownEvaluationScorerModeError,
    );
  });

  it("throws for a non-object configuration value", () => {
    expect(() => resolveEvaluationScorerSelection("LOCAL")).toThrow(UnknownEvaluationScorerModeError);
    expect(() => resolveEvaluationScorerSelection(42)).toThrow(UnknownEvaluationScorerModeError);
    expect(() => resolveEvaluationScorerSelection(null)).toThrow(UnknownEvaluationScorerModeError);
  });

  it("throws for an object missing scorerMode entirely", () => {
    expect(() => resolveEvaluationScorerSelection({})).toThrow(UnknownEvaluationScorerModeError);
  });
});

describe("no provider/LIVE call is possible from the scorer module", () => {
  it("evaluation-scorer.ts contains no network/HTTP call surface", () => {
    const scorerSourcePath = join(dirname(fileURLToPath(import.meta.url)), "evaluation-scorer.ts");
    const source = readFileSync(scorerSourcePath, "utf8");

    for (const forbidden of ["fetch(", "http.request", "https.request", "XMLHttpRequest", "node-fetch", "axios"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("evaluation-scorer.ts never imports @opspilot/agent-runtime or RecordedToolExecution (only mentions them in explanatory comments)", () => {
    const scorerSourcePath = join(dirname(fileURLToPath(import.meta.url)), "evaluation-scorer.ts");
    const source = readFileSync(scorerSourcePath, "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "));

    expect(importLines.join("\n")).not.toContain("@opspilot/agent-runtime");
    expect(importLines.join("\n")).not.toContain("RecordedToolExecution");
  });
});
