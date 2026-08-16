import { beforeAll, describe, expect, it } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { runEvaluationSuite } from "./evaluation-runner";

let defaultCorpus: readonly StoredRunbookChunk[];

beforeAll(async () => {
  const corpusLoad = await loadDefaultRunbookCorpus();
  defaultCorpus = corpusLoad.chunks;
});

// Suite determinism is a Harness self-check, not a metric and not in the CLI
// path (OpsPilot #59 Revision 5 plan §D.4). runEvaluationSuite is exercised
// twice over the full dataset and the two resulting EvaluationCaseInputV2[]
// arrays must be deep-equal — the active v2 input type, not a regeneration of
// the committed parity fixture — so determinism holds across time, not merely
// within a single process. The parity-vectors regeneration test independently
// proves the same inputs still reproduce the committed ts-parity-v2.json
// byte-identically.
describe("evaluation determinism — runEvaluationSuite is a stable function of its inputs", () => {
  it("returns deep-equal EvaluationCaseInputV2[] arrays across two full-dataset runs", async () => {
    const first = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    const second = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });

    expect(second).toEqual(first);
    expect(second).toHaveLength(EVALUATION_CASES.length);
  });
});
