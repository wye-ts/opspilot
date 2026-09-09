import { beforeAll, describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { FABRICATED_TOOL_EVIDENCE_CASE } from "./cases/evidence-grounding-cases";
import { PROTOCOL_AND_FAILURE_CASES } from "./cases/protocol-and-failure-cases";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { resolveTools, runEvaluationSuite } from "./evaluation-runner";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { adversarialToolOutputTool } from "./fixtures/adversarial-tool-output-tool";
import { buildEvaluationSuiteInputV2, EVALUATION_DATASET_ID, type EvaluationCaseInputV2 } from "./v2-types";

let defaultCorpus: readonly StoredRunbookChunk[];

beforeAll(async () => {
  const corpusLoad = await loadDefaultRunbookCorpus();
  defaultCorpus = corpusLoad.chunks;
});

function byCaseId(results: readonly EvaluationCaseInputV2[]): Map<string, EvaluationCaseInputV2> {
  return new Map(results.map((result) => [result.caseId, result]));
}

function scoreAll(caseInputs: readonly EvaluationCaseInputV2[]) {
  const suiteInput = buildEvaluationSuiteInputV2(EVALUATION_DATASET_ID, caseInputs);
  return new LocalEvaluationScorer().score(suiteInput);
}

describe("runEvaluationSuite — order preservation", () => {
  it("returns results in exactly the supplied forward order", async () => {
    const results = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    expect(results.map((result) => result.caseId)).toEqual(EVALUATION_CASES.map((c) => c.id));
  });

  it("returns results in exactly the supplied reversed order", async () => {
    const reversedCases = [...EVALUATION_CASES].reverse();
    const results = await runEvaluationSuite({
      cases: reversedCases,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    expect(results.map((result) => result.caseId)).toEqual(reversedCases.map((c) => c.id));
  });

  it("does not sort cases — an arbitrary subset order is preserved exactly", async () => {
    const subset = [EVALUATION_CASES[5]!, EVALUATION_CASES[0]!, EVALUATION_CASES[10]!];
    const results = await runEvaluationSuite({
      cases: subset,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    expect(results.map((result) => result.caseId)).toEqual(subset.map((c) => c.id));
  });
});

describe("runEvaluationSuite — isolation", () => {
  it("produces equivalent per-case outcomes for forward and reversed runs, once normalized by caseId", async () => {
    const forward = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    const reversed = await runEvaluationSuite({
      cases: [...EVALUATION_CASES].reverse(),
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });

    const forwardById = byCaseId(forward);
    const reversedById = byCaseId(reversed);

    expect(reversedById.size).toBe(forwardById.size);
    for (const [caseId, result] of forwardById) {
      expect(reversedById.get(caseId)).toEqual(result);
    }
  });

  it("case fabricated-tool-evidence passes when run alone — no leakage of another case's tool-execution id", async () => {
    const results = await runEvaluationSuite({
      cases: [FABRICATED_TOOL_EVIDENCE_CASE],
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    expect(results).toHaveLength(1);
    expect(scoreAll(results).cases[0]?.passed).toBe(true);
  });

  it("case invalid-tool-input passes when run alone", async () => {
    const invalidToolInputCase = PROTOCOL_AND_FAILURE_CASES.find((c) => c.id === "invalid-tool-input");
    if (!invalidToolInputCase) throw new Error("unreachable");

    const results = await runEvaluationSuite({
      cases: [invalidToolInputCase],
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    expect(results).toHaveLength(1);
    expect(scoreAll(results).cases[0]?.passed).toBe(true);
  });
});

// Issue #77 §2.1 (Codex-review round-2 MAJOR fix): FakeAgentScenario never
// reads actual tool output to decide anything, so a wiring mistake — e.g.
// resolveTools() accidentally returning the REAL getServiceStatusTool
// instead of adversarialToolOutputTool, both sharing the tool name
// "get_service_status" — would be invisible to any case's own pass/fail
// outcome (TOOL_REQUESTED/TOOL_COMPLETED trace events look identical either
// way). This identity test is the only thing that actually proves the
// wiring resolves to the adversarial fixture, independent of and prior to
// running any scripted case through it.
describe("resolveTools — with-adversarial-tool-output identity", () => {
  it("resolves to the adversarialToolOutputTool instance BY IDENTITY, not merely a same-named tool", () => {
    const tools = resolveTools("with-adversarial-tool-output");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(adversarialToolOutputTool);
  });
});
