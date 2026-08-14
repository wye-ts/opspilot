// The explicit HTTP client from the TypeScript evaluation workflow to the
// Python/FastAPI evaluation service (services/evaluation), introduced for
// OpsPilot #61 Phase 3. It serializes a normalized EvaluationSuiteInputV1,
// POSTs it to /evaluations, and returns the *persisted* evaluation resource.
//
// Design invariants (all enforced by tests):
//   - bounded request timeout via AbortController, no retries (Phase 3);
//   - no fallback to LocalEvaluationScorer — a failed remote call is a
//     failure, never a silent local PASS;
//   - fail closed on non-2xx, network refusal, timeout, and malformed body;
//   - the persisted resource is validated by a hand-rolled runtime parser
//     (parseEvaluationRunResultV1), not a blind JSON cast — wrong primitive
//     types, missing fields, invalid reason codes, and unsupported contract
//     versions all fail;
//   - after structural parsing, the resource is also checked for SEMANTIC
//     self-consistency and — for a POST response — exact correspondence to
//     the submitted request (validateSemanticConsistency): case verdicts,
//     aggregate case totals, pass rate, and all six ratio metrics must
//     recompute identically from the returned cases using the frozen local
//     scorer semantics, or the response is treated as malformed. A
//     contradictory remote result is never silently repaired, so it can never
//     reach the formatter, PASS/Summary rendering, or a zero exit code;
//   - error messages never leak raw bodies, DB errors, URLs, or payloads
//     (see evaluation-service-errors.ts).
//
// The scorer result the existing workflow consumes (EvaluationSuiteResultV1)
// is extracted from the persisted resource; the persisted `id` is exposed
// separately via HttpEvaluationScorer.persistedEvaluationId /
// fetchEvaluation(id) so the POST/GET persistence proof can be exercised
// without polluting the CLI result shape.
import {
  EvaluationServiceError,
  EvaluationServiceHttpError,
  EvaluationServiceMalformedResponseError,
  EvaluationServiceTimeoutError,
  EvaluationServiceUnavailableError,
  EvaluationServiceUnsupportedVersionError,
} from "./evaluation-service-errors";
import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationScorer } from "./evaluation-scorer";
import { CHECK_REASON_MESSAGES, type CheckReasonCode } from "./check-reason-codes";
import {
  EVALUATION_CONTRACT_VERSION,
  type EvaluationCaseResultV1,
  type EvaluationCheckV1,
  type EvaluationSuiteInputV1,
  type EvaluationSuiteResultV1,
} from "./v1-types";
import type { EvaluationMetrics } from "./types";

// The persisted HTTP resource returned by POST/GET /evaluations — a strict
// superset of EvaluationSuiteResultV1 that adds the persisted `id` (see
// services/evaluation/src/opspilot_evaluation/schemas.py's
// EvaluationRunResultV1).
export interface PersistedEvaluationRunV1 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly id: string;
  readonly cases: readonly EvaluationCaseResultV1[];
  readonly metrics: EvaluationMetrics;
}

function malformed(reason: string): EvaluationServiceMalformedResponseError {
  return new EvaluationServiceMalformedResponseError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(`expected a non-empty string at ${path}`);
  }
  return value;
}

function expectStrictBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw malformed(`expected a boolean at ${path}`);
  }
  return value;
}

function expectInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw malformed(`expected an integer at ${path}`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformed(`expected a finite number at ${path}`);
  }
  return value;
}

// The frozen, application-authored check-failure codes (see
// check-reason-codes.ts) — the source of truth for rejecting an unknown
// reasonCode string on the wire.
const VALID_REASON_CODES: ReadonlySet<string> = new Set(Object.keys(CHECK_REASON_MESSAGES));

function parseCheck(value: unknown, path: string): EvaluationCheckV1 {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);
  const name = expectNonEmptyString(value.name, `${path}.name`);
  const passed = expectStrictBoolean(value.passed, `${path}.passed`);

  if (passed) {
    if (value.reasonCode !== null) {
      throw malformed(`${path}.reasonCode must be null for a passing check`);
    }
    return { name, passed: true, reasonCode: null };
  }

  const reasonCode = value.reasonCode;
  if (typeof reasonCode !== "string" || !VALID_REASON_CODES.has(reasonCode)) {
    throw malformed(`${path}.reasonCode must be a known reason code for a failing check`);
  }
  return { name, passed: false, reasonCode: reasonCode as CheckReasonCode };
}

function parseCaseResult(value: unknown, path: string): EvaluationCaseResultV1 {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);
  const caseId = expectNonEmptyString(value.caseId, `${path}.caseId`);
  const passed = expectStrictBoolean(value.passed, `${path}.passed`);

  if (!Array.isArray(value.checks)) {
    throw malformed(`expected an array at ${path}.checks`);
  }
  const checks = value.checks.map((check, index) => parseCheck(check, `${path}.checks[${index}]`));

  return { caseId, passed, checks };
}

function parseMetricRatio(value: unknown, path: string): { readonly numerator: number; readonly denominator: number } {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);
  const numerator = expectInteger(value.numerator, `${path}.numerator`);
  const denominator = expectInteger(value.denominator, `${path}.denominator`);
  return { numerator, denominator };
}

// The six numerator/denominator aggregate metrics, in the frozen
// EvaluationMetrics field order (see types.ts / evaluation-metrics.ts). Shared
// by the structural parser below and the semantic recompute-and-compare check.
const METRIC_RATIO_NAMES = [
  "retrievalTop1",
  "retrievalHitAt3",
  "schemaHandlingCorrectness",
  "evidenceGroundingCorrectness",
  "toolCorrectness",
  "expectedStatusCorrectness",
] as const;

type MetricRatioName = (typeof METRIC_RATIO_NAMES)[number];

function parseMetrics(value: unknown, path: string): EvaluationMetrics {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);

  const totalCases = expectInteger(value.totalCases, `${path}.totalCases`);
  const passedCases = expectInteger(value.passedCases, `${path}.passedCases`);
  const failedCases = expectInteger(value.failedCases, `${path}.failedCases`);
  const passRate = expectFiniteNumber(value.passRate, `${path}.passRate`);

  const metricRatios = {} as Record<MetricRatioName, { readonly numerator: number; readonly denominator: number }>;

  for (const ratioName of METRIC_RATIO_NAMES) {
    metricRatios[ratioName] = parseMetricRatio(value[ratioName], `${path}.${ratioName}`);
  }

  return { totalCases, passedCases, failedCases, passRate, ...metricRatios };
}

// The single strict entry point for any /evaluations response body. Every
// structural guarantee of the frozen v1 result contract is re-checked here
// (nothing is blindly cast): top-level required fields, contract version,
// per-case/check shapes, reason-code closure, and all six metric ratios.
export function parseEvaluationRunResultV1(value: unknown): PersistedEvaluationRunV1 {
  if (!isRecord(value)) throw malformed("expected an object at the response root");

  const contractVersion = value.contractVersion;
  if (typeof contractVersion !== "number") {
    throw malformed("contractVersion must be a number");
  }
  if (contractVersion !== EVALUATION_CONTRACT_VERSION) {
    throw new EvaluationServiceUnsupportedVersionError(
      `unsupported evaluation contract version: ${contractVersion}`,
    );
  }

  const datasetId = expectNonEmptyString(value.datasetId, "datasetId");
  const id = expectNonEmptyString(value.id, "id");

  if (!Array.isArray(value.cases)) {
    throw malformed("expected an array at cases");
  }
  if (value.cases.length === 0) {
    throw malformed("expected at least one case at cases");
  }
  const cases = value.cases.map((caseValue, index) => parseCaseResult(caseValue, `cases[${index}]`));

  const metrics = parseMetrics(value.metrics, "metrics");

  return { contractVersion, datasetId, id, cases, metrics };
}

// ---------------------------------------------------------------------------
// Semantic validation of a structurally-valid persisted resource (OpsPilot
// #61 Phase 3, final targeted fixes). The runtime parser above proves the
// wire SHAPE; this proves the resource is internally SELF-CONSISTENT and —
// for a POST response — corresponds exactly to the submitted request. Any
// contradiction throws EvaluationServiceMalformedResponseError; the remote
// response is never silently repaired, so a contradictory result can never
// reach the formatter, PASS/Summary rendering, or exit code 0.
// ---------------------------------------------------------------------------

function validateSemanticConsistency(
  resource: PersistedEvaluationRunV1,
  submitted?: EvaluationSuiteInputV1,
): void {
  // A. Request/resource identity — POST responses only (a GET by id has no
  // submitted request to compare against).
  if (submitted !== undefined) {
    if (resource.datasetId !== submitted.datasetId) {
      throw malformed("response datasetId does not match the submitted request datasetId");
    }
    const submittedCaseIds = submitted.cases.map((caseInput) => caseInput.caseId);
    const returnedCaseIds = resource.cases.map((caseResult) => caseResult.caseId);
    // Exact ordered equality: no missing case, no extra case, no reorder.
    if (
      returnedCaseIds.length !== submittedCaseIds.length ||
      returnedCaseIds.some((caseId, index) => caseId !== submittedCaseIds[index])
    ) {
      throw malformed("response cases do not exactly match the submitted case IDs and order");
    }
  }

  // B. Case verdict consistency — a case's `passed` must equal the logical
  // verdict its emitted checks imply. The frozen local scorer semantics are
  // preserved exactly: a case passes iff every emitted check passes (vacuously
  // true for zero checks — see evaluation-evaluator.ts's evaluateCase and
  // v1-types.ts).
  for (let index = 0; index < resource.cases.length; index += 1) {
    const caseResult = resource.cases[index]!;
    const impliedVerdict = caseResult.checks.every((check) => check.passed);
    if (caseResult.passed !== impliedVerdict) {
      throw malformed(`case "${caseResult.caseId}" verdict contradicts its emitted checks`);
    }
  }

  // C/D/E. Aggregate case totals, pass rate, and all six ratio metrics must
  // recompute identically from the returned cases using the frozen local
  // scorer semantics (aggregateMetrics). This is strictly stronger than
  // bounds-checking: a returned metric that differs from the recomputed value
  // — negative counts, numerator > denominator, a passRate outside [0,1], an
  // inconsistent total, a miscounted ratio — is a contradiction.
  assertMetricsMatch(resource.metrics, aggregateMetrics(resource.cases));
}

function assertMetricsMatch(returned: EvaluationMetrics, recomputed: EvaluationMetrics): void {
  const contradict = (path: string): never => {
    throw malformed(`metrics.${path} contradicts the returned cases`);
  };

  if (returned.totalCases !== recomputed.totalCases) contradict("totalCases");
  if (returned.passedCases !== recomputed.passedCases) contradict("passedCases");
  if (returned.failedCases !== recomputed.failedCases) contradict("failedCases");
  if (returned.passRate !== recomputed.passRate) contradict("passRate");

  for (const ratioName of METRIC_RATIO_NAMES) {
    const returnedRatio = returned[ratioName];
    const recomputedRatio = recomputed[ratioName];
    if (returnedRatio.numerator !== recomputedRatio.numerator) {
      contradict(`${ratioName}.numerator`);
    }
    if (returnedRatio.denominator !== recomputedRatio.denominator) {
      contradict(`${ratioName}.denominator`);
    }
  }
}

function normalizeBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, "");
}

function buildRequestInit(
  method: "POST" | "GET",
  body: unknown,
  controller: AbortController,
): RequestInit {
  const init: RequestInit = { method, signal: controller.signal };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json", accept: "application/json" };
    init.body = JSON.stringify(body);
  }
  return init;
}

async function requestJson(
  url: string,
  method: "POST" | "GET",
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, buildRequestInit(method, body, controller));
    if (!response.ok) {
      // Never leak the error body; the status code is all the caller needs.
      throw new EvaluationServiceHttpError(response.status);
    }

    const text = await response.text();
    if (text.length === 0) {
      throw malformed("expected a JSON response body");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw malformed("response body is not valid JSON");
    }
  } catch (error) {
    if (error instanceof EvaluationServiceError) {
      throw error;
    }
    if (controller.signal.aborted) {
      // Our own timeout fired and aborted the in-flight request.
      throw new EvaluationServiceTimeoutError();
    }
    // Network refusal / DNS / TLS — the service is unreachable.
    throw new EvaluationServiceUnavailableError();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export class HttpEvaluationScorer implements EvaluationScorer {
  private readonly serviceUrl: string;
  private readonly timeoutMs: number;
  private latestEvaluationId: string | undefined;

  constructor(serviceUrl: string, timeoutMs: number) {
    this.serviceUrl = normalizeBaseUrl(serviceUrl);
    this.timeoutMs = timeoutMs;
  }

  // The most recently persisted evaluation id from a successful score() call
  // (undefined until the first success). Kept out of the CLI result shape so
  // user-visible output stays scorer-mode-agnostic (see the Phase 3 task's
  // "CLI behavior" section).
  get persistedEvaluationId(): string | undefined {
    return this.latestEvaluationId;
  }

  async score(input: EvaluationSuiteInputV1): Promise<EvaluationSuiteResultV1> {
    const resource = await this.createEvaluation(input);
    return {
      contractVersion: resource.contractVersion,
      datasetId: resource.datasetId,
      cases: resource.cases,
      metrics: resource.metrics,
    };
  }

  async createEvaluation(input: EvaluationSuiteInputV1): Promise<PersistedEvaluationRunV1> {
    const body = await requestJson(
      `${this.serviceUrl}/evaluations`,
      "POST",
      input,
      this.timeoutMs,
    );
    const resource = parseEvaluationRunResultV1(body);
    // Semantic validation WITH the submitted request: datasetId and the
    // exact ordered case IDs must match, and the whole resource must be
    // internally self-consistent. A contradictory response is malformed.
    validateSemanticConsistency(resource, input);
    this.latestEvaluationId = resource.id;
    return resource;
  }

  // Persisted-result query proof: fetch the same resource back by id and
  // return it (validated exactly like the POST response; there is no
  // submitted request to compare identity against on a GET-by-id, so only
  // internal self-consistency is enforced here).
  async fetchEvaluation(id: string): Promise<PersistedEvaluationRunV1> {
    const body = await requestJson(
      `${this.serviceUrl}/evaluations/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      this.timeoutMs,
    );
    const resource = parseEvaluationRunResultV1(body);
    validateSemanticConsistency(resource);
    return resource;
  }
}

export function createHttpEvaluationScorer(serviceUrl: string, timeoutMs: number): HttpEvaluationScorer {
  return new HttpEvaluationScorer(serviceUrl, timeoutMs);
}
