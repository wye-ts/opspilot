import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHttpEvaluationScorer,
  HttpEvaluationScorer,
  type PersistedEvaluationRunV2,
} from "./evaluation-service-client";
import {
  EvaluationServiceHttpError,
  EvaluationServiceMalformedResponseError,
  EvaluationServiceTimeoutError,
  EvaluationServiceUnavailableError,
  EvaluationServiceUnsupportedVersionError,
} from "./evaluation-service-errors";
import type { EvaluationSuiteInputV2, EvaluationSuiteResultV2 } from "./v2-types";

// ---------------------------------------------------------------------------
// A tiny, dependency-free HTTP server harness for the client unit tests.
// Every test spins up a real 127.0.0.1 server so the client exercises actual
// fetch()/abort/timeout behavior — no fetch mocking, no faked responses.
// ---------------------------------------------------------------------------

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: RequestHandler): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const activeServers: Server[] = [];
afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(stopServer));
});

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The v2 active wire contract (see v2-types.ts): contractVersion 2, the
// canonical v2 dataset id, and a failed-branch ObservedFacts carrying the v2
// investigation facts and a real failedStage.
const MINIMAL_INPUT: EvaluationSuiteInputV2 = {
  contractVersion: 2,
  datasetId: "opspilot-deterministic-v2",
  cases: [
    {
      caseId: "c1",
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
    },
  ],
};

const EVALUATION_ID = "11111111-2222-3333-4444-555555555555";

// Loose, fully-mutable fixture type. Tests deliberately build broken variants
// (wrong primitives, bogus reason codes, missing fields) that would not
// typecheck against PersistedEvaluationRunV2 — the client must reject those
// at runtime, so the fixtures are intentionally untyped at the leaves. The
// client only ever sees the raw JSON, never these fixtures.
interface MutableResource {
  contractVersion: unknown;
  datasetId: unknown;
  id: unknown;
  cases: Array<{
    caseId: unknown;
    passed: unknown;
    checks: Array<{ name: unknown; status: unknown; reasonCode: unknown }>;
  }>;
  metrics: unknown;
}

function validResourceJson(id: string = EVALUATION_ID): MutableResource {
  return {
    contractVersion: 2,
    datasetId: "opspilot-deterministic-v2",
    id,
    cases: [
      {
        caseId: "c1",
        passed: true,
        checks: [{ name: "status", status: "PASS", reasonCode: null }],
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
}

// A semantically CONSISTENT failing variant of validResourceJson: the case
// is failed, its check is failed (with a known reason code), and every metric
// is recomputed to match — passedCases=0, failedCases=1, passRate=0, and
// expectedStatusCorrectness {0,1}. The prior fixture mutated only the case and
// left the aggregate metrics claiming all-passed, which the semantic
// validation now correctly rejects (see the semantic-consistency describe).
function failingResourceJson(): MutableResource {
  return {
    contractVersion: 2,
    datasetId: "opspilot-deterministic-v2",
    id: EVALUATION_ID,
    cases: [
      {
        caseId: "c1",
        passed: false,
        checks: [{ name: "status", status: "FAIL", reasonCode: "STATUS_MISMATCH" }],
      },
    ],
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
  };
}

// The scorer result that score() is expected to extract from the persisted
// resource above (the persisted id is stripped, not included).
function expectedScorerResult(): EvaluationSuiteResultV2 {
  return {
    contractVersion: 2,
    datasetId: "opspilot-deterministic-v2",
    cases: [
      { caseId: "c1", passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] },
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
}

async function withServer(
  handler: RequestHandler,
  run: (scorer: HttpEvaluationScorer) => Promise<void>,
): Promise<void> {
  const { server, url } = await startServer(handler);
  activeServers.push(server);
  const scorer = createHttpEvaluationScorer(url, 2_000);
  await run(scorer);
}

describe("HttpEvaluationScorer — valid responses", () => {
  it("posts the normalized suite, validates the persisted resource, and returns the extracted scorer result", async () => {
    await withServer((_req, res) => respondJson(res, 201, validResourceJson()), async (scorer) => {
      const result = await scorer.score(MINIMAL_INPUT);

      expect(result).toEqual(expectedScorerResult());
      expect(result.contractVersion).toBe(2);
      expect(result.datasetId).toBe("opspilot-deterministic-v2");
    });
  });

  it("exposes the persisted evaluation id separately from the scorer result", async () => {
    await withServer((_req, res) => respondJson(res, 201, validResourceJson()), async (scorer) => {
      expect(scorer.persistedEvaluationId).toBeUndefined();

      const result = await scorer.score(MINIMAL_INPUT);

      expect(scorer.persistedEvaluationId).toBe(EVALUATION_ID);
      // The id is never part of the scorer result shape.
      expect(result).not.toHaveProperty("id");
    });
  });

  it("fetches the same persisted resource back by id via GET /evaluations/{id}", async () => {
    const handler: RequestHandler = (req, res) => {
      if (req.method === "GET" && req.url === `/evaluations/${EVALUATION_ID}`) {
        respondJson(res, 200, validResourceJson());
        return;
      }
      respondJson(res, 404, { detail: "not found" });
    };

    await withServer(handler, async (scorer) => {
      const fetched = await scorer.fetchEvaluation(EVALUATION_ID);
      expect(fetched.id).toBe(EVALUATION_ID);
      expect(fetched.cases[0]!.caseId).toBe("c1");
      // Semantically consistent with the POST result shape.
      expect(fetched).toMatchObject(expectedScorerResult());
    });
  });

  it("accepts a valid failing check carrying a known reason code, with semantically consistent metrics", async () => {
    await withServer((_req, res) => respondJson(res, 201, failingResourceJson()), async (scorer) => {
      const result = await scorer.score(MINIMAL_INPUT);
      expect(result.cases[0]!.passed).toBe(false);
      expect(result.cases[0]!.checks[0]).toEqual({ name: "status", status: "FAIL", reasonCode: "STATUS_MISMATCH" });
      expect(result.metrics.passedCases).toBe(0);
      expect(result.metrics.failedCases).toBe(1);
    });
  });
});

describe("HttpEvaluationScorer — fail closed on malformed responses", () => {
  it("treats a successful status with an empty body as MALFORMED_RESPONSE", async () => {
    await withServer((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end();
    }, async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("treats a successful status with non-JSON body as MALFORMED_RESPONSE", async () => {
    await withServer((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{not json");
    }, async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a response missing a required top-level field", async () => {
    const resource = validResourceJson();
    delete (resource as { metrics?: unknown }).metrics;

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a wrong primitive type in a required field (passed as a string)", async () => {
    const resource = validResourceJson();
    (resource.cases[0] as { passed: unknown }).passed = "true";

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects an unknown/invalid reason code", async () => {
    const resource = validResourceJson();
    resource.cases[0]!.passed = false;
    resource.cases[0]!.checks[0] = { name: "status", status: "FAIL", reasonCode: "BOGUS_CODE" };

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a passing check that contradicts the discriminated union by carrying a reason code", async () => {
    const resource = validResourceJson();
    resource.cases[0]!.checks[0] = { name: "status", status: "PASS", reasonCode: "STATUS_MISMATCH" };

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a non-2 contract version (v1) as UNSUPPORTED_VERSION", async () => {
    const resource = validResourceJson();
    (resource as { contractVersion: unknown }).contractVersion = 1;

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceUnsupportedVersionError);
    });
  });

  it("treats a wrong primitive contract version ('2' as a string) as malformed, not as supported", async () => {
    const resource = validResourceJson();
    (resource as { contractVersion: unknown }).contractVersion = "2";

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });
});

// A two-case request so identity/ordering violations can be exercised; the
// response below is structurally valid and internally consistent, only its
// case order disagrees with this request.
function twoCaseInput(): EvaluationSuiteInputV2 {
  return {
    ...MINIMAL_INPUT,
    cases: [MINIMAL_INPUT.cases[0]!, { ...MINIMAL_INPUT.cases[0]!, caseId: "c2" }],
  };
}

function twoCaseAllPassedResource(): Record<string, unknown> {
  return {
    contractVersion: 2,
    datasetId: "opspilot-deterministic-v2",
    id: EVALUATION_ID,
    cases: [
      { caseId: "c1", passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] },
      { caseId: "c2", passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] },
    ],
    metrics: {
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      passRate: 1,
      retrievalTop1: { numerator: 0, denominator: 0 },
      retrievalHitAt3: { numerator: 0, denominator: 0 },
      schemaHandlingCorrectness: { numerator: 0, denominator: 0 },
      evidenceGroundingCorrectness: { numerator: 0, denominator: 0 },
      toolCorrectness: { numerator: 0, denominator: 0 },
      expectedStatusCorrectness: { numerator: 2, denominator: 2 },
    },
  };
}

describe("HttpEvaluationScorer — fail closed on semantically inconsistent persisted resources", () => {
  it("rejects the aggregate-says-all-passed contradiction: case failed but metrics claim passedCases=1/failedCases=0/passRate=1 (required test 1)", async () => {
    const resource = failingResourceJson();
    resource.metrics = {
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
    };

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a case marked passed while one of its checks fails (required test 2)", async () => {
    const resource = failingResourceJson();
    resource.cases[0]!.passed = true; // contradicts the failing status check below

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a negative case count (required test 3)", async () => {
    const resource = validResourceJson();
    (resource.metrics as { totalCases: number }).totalCases = -1;

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a ratio with numerator greater than denominator (required test 4)", async () => {
    const resource = validResourceJson();
    (resource.metrics as { expectedStatusCorrectness: { numerator: number; denominator: number } })
      .expectedStatusCorrectness = { numerator: 2, denominator: 1 };

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a ratio value outside [0,1] (negative numerator) (required test 5)", async () => {
    const resource = validResourceJson();
    (resource.metrics as { retrievalTop1: { numerator: number; denominator: number } }).retrievalTop1 = {
      numerator: -1,
      denominator: 2,
    };

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects aggregate totals inconsistent with the returned case count (required test 6)", async () => {
    const resource = validResourceJson();
    (resource.metrics as { totalCases: number }).totalCases = 2; // response has one case

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a response datasetId that differs from the submitted request (required test 7)", async () => {
    const resource = validResourceJson();
    resource.datasetId = "some-other-dataset";

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects a returned case ID that differs from the submitted request (required test 8)", async () => {
    const resource = validResourceJson();
    resource.cases[0]!.caseId = "other-case";

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceMalformedResponseError);
    });
  });

  it("rejects returned cases reordered relative to the request (required test 9)", async () => {
    // The response is structurally valid and internally consistent, but the
    // case order [c2, c1] disagrees with the submitted [c1, c2].
    const resource = twoCaseAllPassedResource();
    resource.cases = [
      { caseId: "c2", passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] },
      { caseId: "c1", passed: true, checks: [{ name: "status", status: "PASS", reasonCode: null }] },
    ];

    await withServer((_req, res) => respondJson(res, 201, resource), async (scorer) => {
      await expect(scorer.score(twoCaseInput())).rejects.toBeInstanceOf(
        EvaluationServiceMalformedResponseError,
      );
    });
  });
});

describe("HttpEvaluationScorer — HTTP and transport failures", () => {
  it("treats a non-2xx response as HTTP_ERROR carrying the status code, never leaking the body", async () => {
    await withServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "internal postgres password: hunter2" }));
    }, async (scorer) => {
      const error = await scorer.score(MINIMAL_INPUT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EvaluationServiceHttpError);
      if (error instanceof EvaluationServiceHttpError) {
        expect(error.statusCode).toBe(500);
      }
      expect(String(error)).not.toContain("hunter2");
      expect(String(error)).not.toContain("detail");
    });
  });

  it("times out on a hanging server, distinguishing timeout from an ordinary non-2xx failure", async () => {
    // Never responds — the request hangs until the bounded timeout aborts it.
    const { server, url } = await startServer((_req, _res) => {});
    activeServers.push(server);

    const scorer = createHttpEvaluationScorer(url, 100);
    await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceTimeoutError);
  });

  it("treats a refused connection as SERVICE_UNAVAILABLE", async () => {
    // Bind an ephemeral port, then close it so nothing is listening there.
    const { server, url } = await startServer((_req, _res) => {});
    await stopServer(server);

    const scorer = createHttpEvaluationScorer(url, 2_000);
    await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceUnavailableError);
  });

  it("performs no retry and no fallback — a failed call rejects, fabricates nothing, and leaves persistedEvaluationId undefined", async () => {
    let hits = 0;
    const { server, url } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
    });
    activeServers.push(server);

    const scorer = createHttpEvaluationScorer(url, 2_000);
    await expect(scorer.score(MINIMAL_INPUT)).rejects.toBeInstanceOf(EvaluationServiceHttpError);

    // Exactly one POST attempt — no retry.
    expect(hits).toBe(1);
    expect(scorer.persistedEvaluationId).toBeUndefined();
  });
});
