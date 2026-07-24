import { beforeAll, describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { FABRICATED_TOOL_EVIDENCE_CASE } from "./cases/evidence-grounding-cases";
import { PROTOCOL_AND_FAILURE_CASES } from "./cases/protocol-and-failure-cases";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { runEvaluationSuite } from "./evaluation-runner";
import type { EvaluationCaseResult } from "./types";

let defaultCorpus: readonly StoredRunbookChunk[];

beforeAll(async () => {
  const corpusLoad = await loadDefaultRunbookCorpus();
  defaultCorpus = corpusLoad.chunks;
});

function byCaseId(results: readonly EvaluationCaseResult[]): Map<string, EvaluationCaseResult> {
  return new Map(results.map((result) => [result.caseId, result]));
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
    expect(results[0]?.passed).toBe(true);
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
    expect(results[0]?.passed).toBe(true);
  });
});
