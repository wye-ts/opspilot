import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { renderEvaluationResolution, resolveEvaluationRun } from "./run-eval";
import type { EvaluationCase } from "./types";
import type { EvaluationCaseInputV1 } from "./v1-types";

// The critical migration invariant (OpsPilot #61 Phase 3): with the service
// scorer selected, an unreachable service FAILS the evaluation command —
// there is never a silent local fallback and never a fabricated result, even
// though the very same suite would score successfully under the local
// scorer. The negative test targets a closed ephemeral port so the
// SERVICE_UNAVAILABLE path is deterministic in any environment.

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

// Agrees with validCase's expectations (failed/TOOL_NOT_FOUND), so the local
// scorer would mark it PASSED — proving the negative result below is NOT
// because the case itself is bad.
function dummyCaseInput(id: string): EvaluationCaseInputV1 {
  return {
    caseId: id,
    expectations: { runStatus: "failed", failure: { expectedCode: "TOOL_NOT_FOUND" } },
    observed: {
      runStatus: "failed",
      errorCode: "TOOL_NOT_FOUND",
      retrieval: { completed: false, chunkIds: [] },
      tools: { requested: [], executed: [], completed: [] },
      report: null,
    },
  };
}

// Binds an ephemeral loopback port and closes it again, so nothing is
// listening at the returned URL — the deterministic "service unreachable"
// target.
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `http://127.0.0.1:${port}`;
}

// A structurally valid but semantically self-contradictory persisted result
// (OpsPilot #61 Phase 3, final targeted fixes, required test 11): the runtime
// parser accepts the shape, but the aggregate metrics claim passedCases=1 /
// failedCases=0 / passRate=1 while the only case is a verdict-consistent
// FAILED case. datasetId and caseId match the submitted request
// (EVALUATION_DATASET_ID / "synthetic-1") so the identity and verdict checks
// pass — ONLY the aggregate contradiction fires. Proving the CLI still fails
// closed (no exit code 0) demonstrates the semantic validator sits between the
// wire and the formatter/exit-code.
const CONTRADICTORY_RESOURCE = {
  contractVersion: 1,
  datasetId: "opspilot-deterministic-v1",
  id: "eval-11",
  cases: [
    {
      caseId: "synthetic-1",
      passed: false,
      checks: [{ name: "status", passed: false, reasonCode: "STATUS_MISMATCH" }],
    },
  ],
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
};

describe("EVALUATION_SCORER=service with an unreachable service", () => {
  it("fails the evaluation with a scoring-error and renders no local fallback and no fabricated result", async () => {
    const serviceUrl = await closedPortUrl();
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    const resolution = await resolveEvaluationRun({
      loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
      cases: [validCase("synthetic-1")],
      injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
      runSuite,
      scorerSelection: { scorerMode: "SERVICE", serviceUrl, timeoutMs: 2_000 },
    });

    expect(resolution).toEqual({ kind: "scoring-error", category: "SERVICE_UNAVAILABLE" });

    const rendered = renderEvaluationResolution(resolution);
    expect(rendered.isError).toBe(true);
    expect(rendered.exitCode).toBe(1);
    expect(rendered.output).toContain("No local scorer fallback; exiting without a result.");
    // A fabricated/passed result would have rendered PASS + a Summary — prove
    // neither appears.
    expect(rendered.output).not.toContain("PASS");
    expect(rendered.output).not.toContain("Summary");
  });

  it("fails the evaluation with a TIMEOUT scoring-error when the service hangs — still no local fallback", async () => {
    // A server that accepts the connection but never responds.
    const server = createServer((_req, _res) => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const serviceUrl = `http://127.0.0.1:${port}`;
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    try {
      const resolution = await resolveEvaluationRun({
        loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
        cases: [validCase("synthetic-1")],
        injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
        runSuite,
        scorerSelection: { scorerMode: "SERVICE", serviceUrl, timeoutMs: 100 },
      });

      expect(resolution).toEqual({ kind: "scoring-error", category: "TIMEOUT" });

      const rendered = renderEvaluationResolution(resolution);
      expect(rendered.isError).toBe(true);
      expect(rendered.exitCode).toBe(1);
      expect(rendered.output).toContain("No local scorer fallback; exiting without a result.");
      expect(rendered.output).not.toContain("PASS");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("EVALUATION_SCORER=service with a reachable service returning a semantically contradictory result", () => {
  it("fails the evaluation with a MALFORMED_RESPONSE scoring-error and exit code 1, never exit code 0 (required test 11)", async () => {
    // The service is reachable and returns a well-formed /evaluations POST
    // response, but the resource is semantically self-contradictory. The
    // fail-closed semantic validator must reject it so the evaluation cannot
    // be reported as PASS or exit 0.
    const server = createServer((req, res) => {
      if (req.url === "/evaluations" && req.method === "POST") {
        req.resume(); // drain the request body so the response flushes cleanly
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(CONTRADICTORY_RESOURCE));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const serviceUrl = `http://127.0.0.1:${port}`;
    const runSuite = vi.fn().mockResolvedValue([dummyCaseInput("synthetic-1")]);

    try {
      const resolution = await resolveEvaluationRun({
        loadCorpus: async () => ({ chunks: FIXTURE_CORPUS, sourceFileCount: 1 }),
        cases: [validCase("synthetic-1")],
        injectionProbeChunk: FIXTURE_INJECTION_PROBE_CHUNK,
        runSuite,
        scorerSelection: { scorerMode: "SERVICE", serviceUrl, timeoutMs: 2_000 },
      });

      expect(resolution).toEqual({ kind: "scoring-error", category: "MALFORMED_RESPONSE" });

      const rendered = renderEvaluationResolution(resolution);
      expect(rendered.isError).toBe(true);
      expect(rendered.exitCode).toBe(1);
      expect(rendered.output).toContain("No local scorer fallback; exiting without a result.");
      // A fabricated/passed result would have rendered PASS + a Summary —
      // prove neither appears, so exit code 0 is impossible.
      expect(rendered.output).not.toContain("PASS");
      expect(rendered.output).not.toContain("Summary");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
