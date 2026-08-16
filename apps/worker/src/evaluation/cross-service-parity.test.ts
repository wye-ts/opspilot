import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CROSS_SERVICE_PROBE_TIMEOUT_MS,
  EvaluationServiceProbeError,
  probeEvaluationServiceHealth,
} from "./evaluation-service-probe";
import { createHttpEvaluationScorer } from "./evaluation-service-client";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { formatEvaluationReport } from "./evaluation-formatter";
import type { ParityFixtureV2 } from "./parity-vectors";
import {
  buildEvaluationSuiteInputV2,
  type EvaluationSuiteInputV2,
} from "./v2-types";

// ---------------------------------------------------------------------------
// The authoritative cross-service parity proof (OpsPilot #61 Phase 3): a
// REAL Python/FastAPI service consumes the exact same normalized v2 suite as
// the local TypeScript scorer, and the extracted scorer results must be
// semantically identical — check names, check order, passed, reasonCode,
// case verdict, case totals, and all six metrics. Nothing here fakes the
// Python response.
//
// Reachability is decided ONCE at module load by a fail-closed /health probe.
// In REQUIRED mode (EVALUATION_SERVICE_REQUIRED=1, set by CI and by
// `test:eval:cross-service`) any inability to prove the service is healthy —
// no URL, refused connection, timeout, non-2xx /health, or a malformed health
// body — throws, so the suite FAILS rather than silently skipping with zero
// parity assertions executed. In optional mode (a local developer run without
// the flag) an absent service skips the describe, which is the intended local
// workflow. The CI cross-service job starts the service, polls /health, then
// runs this file in required mode with EVALUATION_SERVICE_URL set, so it
// always runs for real there.
// ---------------------------------------------------------------------------

const SERVICE_URL = process.env.EVALUATION_SERVICE_URL;
const REQUIRED = process.env.EVALUATION_SERVICE_REQUIRED === "1";

const serviceIsReachable = await (async (): Promise<boolean> => {
  if (SERVICE_URL === undefined || SERVICE_URL.trim() === "") {
    if (REQUIRED) {
      throw new EvaluationServiceProbeError(
        "cross-service parity: EVALUATION_SERVICE_URL is required when EVALUATION_SERVICE_REQUIRED=1.",
      );
    }
    return false;
  }
  return probeEvaluationServiceHealth({
    serviceUrl: SERVICE_URL.trim(),
    required: REQUIRED,
    timeoutMs: CROSS_SERVICE_PROBE_TIMEOUT_MS,
  });
})();

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ts-parity-v2.json");
const fixture: ParityFixtureV2 = JSON.parse(readFileSync(fixturePath, "utf8")) as ParityFixtureV2;

// Reconstructs the exact v2 wire request from the single TS-owned fixture,
// dropping only the fixture's TS-only `expected`/`expectedMetrics` echoes —
// the same reconstruction the Python fixture_loader.py performs.
function suiteInputFromFixture(): EvaluationSuiteInputV2 {
  return buildEvaluationSuiteInputV2(
    fixture.datasetId,
    fixture.cases.map((caseFixture) => ({
      caseId: caseFixture.caseId,
      expectations: caseFixture.expectations,
      observed: caseFixture.observed,
    })),
  );
}

function remoteScorer() {
  if (SERVICE_URL === undefined) {
    throw new Error("cross-service parity test requires EVALUATION_SERVICE_URL");
  }
  return createHttpEvaluationScorer(SERVICE_URL, 30_000);
}

describe.skipIf(!serviceIsReachable)("cross-service parity — real Python/FastAPI service", () => {
  it("scores the frozen 15-case suite remotely with semantic identity to the local parity oracle", async () => {
    const suiteInput = suiteInputFromFixture();
    expect(suiteInput.cases).toHaveLength(15);
    expect(suiteInput.datasetId).toBe("opspilot-deterministic-v2");
    expect(suiteInput.contractVersion).toBe(2);

    const local = new LocalEvaluationScorer().score(suiteInput);
    const remote = await remoteScorer().score(suiteInput);

    // Same suite → same suite shape (contract + dataset) and same case order.
    expect(remote.contractVersion).toBe(local.contractVersion);
    expect(remote.datasetId).toBe(local.datasetId);
    expect(remote.cases.map((c) => c.caseId)).toEqual(local.cases.map((c) => c.caseId));

    // Per-case semantic equality: verdict, check names, check order, passed,
    // reasonCode.
    expect(remote.cases).toEqual(local.cases);

    // Case totals and all six metrics.
    expect(remote.metrics).toEqual(local.metrics);

    // Tie the remote result back to the TS-owned golden fixture directly:
    // remote === golden === local.
    expect(remote.cases.map((c) => ({ passed: c.passed, checks: c.checks }))).toEqual(
      fixture.cases.map((c) => c.expected),
    );
    expect(remote.metrics).toEqual(fixture.expectedMetrics);
  }, 60_000);

  it("renders identical CLI output for local and remote scorer results (guarantee B)", async () => {
    const suiteInput = suiteInputFromFixture();

    const local = new LocalEvaluationScorer().score(suiteInput);
    const remote = await remoteScorer().score(suiteInput);

    expect(formatEvaluationReport(remote.cases, remote.metrics)).toBe(
      formatEvaluationReport(local.cases, local.metrics),
    );
  }, 60_000);

  it("proves POST/GET persistence: the persisted resource fetched by id is semantically consistent with the POST result", async () => {
    const suiteInput = suiteInputFromFixture();
    const scorer = remoteScorer();

    const created = await scorer.createEvaluation(suiteInput);
    expect(created.id.length).toBeGreaterThan(0);

    const fetched = await scorer.fetchEvaluation(created.id);

    // Same persisted resource identity.
    expect(fetched.id).toBe(created.id);
    expect(fetched.contractVersion).toBe(created.contractVersion);
    expect(fetched.datasetId).toBe(created.datasetId);

    // Semantically consistent scoring result — not just the same id.
    expect(fetched.cases).toEqual(created.cases);
    expect(fetched.metrics).toEqual(created.metrics);
  }, 60_000);
});
