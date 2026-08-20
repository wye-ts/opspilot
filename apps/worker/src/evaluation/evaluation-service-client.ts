// The explicit HTTP client from the TypeScript evaluation workflow to the
// Python/FastAPI evaluation service (services/evaluation), introduced for
// OpsPilot #61 Phase 3. It serializes a normalized EvaluationSuiteInputV2,
// POSTs it to /evaluations, and returns the *persisted* evaluation resource.
// As of OpsPilot #59 Checkpoint A the active contract is v2 only — a v1
// request is never accepted (the service rejects contractVersion 1) and a
// v1 response is never parsed.
//
// Design invariants (all enforced by tests):
//   - bounded request timeout via AbortController, no retries (Phase 3);
//   - no fallback to LocalEvaluationScorer — a failed remote call is a
//     failure, never a silent local PASS;
//   - fail closed on non-2xx, network refusal, timeout, and malformed body;
//   - the persisted resource is validated by a hand-rolled runtime parser
//     (parseEvaluationRunResultV2), not a blind JSON cast — wrong primitive
//     types, missing fields, invalid status/reason-code combinations, and
//     unsupported contract versions all fail;
//   - after structural parsing, the resource is also checked for SEMANTIC
//     self-consistency and — for a POST response — exact correspondence to
//     the submitted request (validateSemanticConsistency): case verdicts,
//     aggregate case totals, pass rate, and all six ratio metrics must
//     recompute identically from the returned cases using the frozen local
//     scorer semantics, or the response is treated as malformed. A case
//     verdict is derived from its emitted checks as
//     `passed === checks.every(c => c.status !== "FAIL")`. A contradictory
//     remote result is never silently repaired, so it can never reach the
//     formatter, PASS/Summary rendering, or a zero exit code;
//   - Issue #59 Checkpoint B: a POST response's every returned case must
//     carry EXACTLY ONE outcome for each of the nine #59 metric checks, in
//     the fixed METRIC_CHECK_NAMES order (assertExactMetricCheckOutcomes). A
//     response that omits, duplicates, replaces, or reorders any of the nine
//     defeats the exactly-one-outcome-per-metric invariant and is rejected as
//     malformed. This is POST-only — pre-B persisted rows (GET) legitimately
//     predate the nine and stay compatible;
//   - error messages never leak raw bodies, DB errors, URLs, or payloads
//     (see evaluation-service-errors.ts).
//
// The scorer result the existing workflow consumes (EvaluationSuiteResultV2)
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
import { METRIC_CHECK_NAMES } from "./evaluation-evaluator";
import { aggregateMetrics } from "./evaluation-metrics";
import type { EvaluationScorer } from "./evaluation-scorer";
import { CHECK_REASON_MESSAGES, isCheckReasonCode, type CheckReasonCode } from "./check-reason-codes";
import { NOT_APPLICABLE_MESSAGES, isNotApplicableCode, type NotApplicableCode } from "./not-applicable-codes";
import {
  EVALUATION_CONTRACT_VERSION,
  type EvaluationCaseResultV2,
  type EvaluationCheckV2,
  type EvaluationSuiteInputV2,
  type EvaluationSuiteResultV2,
} from "./v2-types";
import type { EvaluationMetrics } from "./types";

// The persisted HTTP resource returned by POST/GET /evaluations — a strict
// superset of EvaluationSuiteResultV2 that adds the persisted `id` (see
// services/evaluation/src/opspilot_evaluation/schemas.py's
// EvaluationRunResultV2).
export interface PersistedEvaluationRunV2 {
  readonly contractVersion: typeof EVALUATION_CONTRACT_VERSION;
  readonly datasetId: string;
  readonly id: string;
  readonly cases: readonly EvaluationCaseResultV2[];
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

// Counts/tokens on the wire are non-negative integers (Checkpoint B numeric-
// domain alignment: totalCases/passedCases/failedCases and every ratio's
// numerator/denominator). Negative values are rejected here, not left for the
// recompute check to catch downstream. passRate stays a finite fraction.
function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw malformed(`expected a non-negative integer at ${path}`);
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
// check-reason-codes.ts) and not-applicable codes (see
// not-applicable-codes.ts) — the sources of truth for rejecting an unknown
// status/reasonCode combination on the wire.
const VALID_REASON_CODES: ReadonlySet<string> = new Set(Object.keys(CHECK_REASON_MESSAGES));
const VALID_NOT_APPLICABLE_CODES: ReadonlySet<string> = new Set(Object.keys(NOT_APPLICABLE_MESSAGES));

// The v2 three-state check: PASS (reasonCode null), FAIL (a known
// CheckReasonCode), or NOT_APPLICABLE (a known NotApplicableCode). Any other
// status string, or a status/reasonCode pairing that violates the invariant,
// is rejected — a malformed response is never silently repaired.
function parseCheck(value: unknown, path: string): EvaluationCheckV2 {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);
  const name = expectNonEmptyString(value.name, `${path}.name`);
  const status = value.status;

  if (status === "PASS") {
    if (value.reasonCode !== null) {
      throw malformed(`${path}.reasonCode must be null for a PASS check`);
    }
    return { name, status: "PASS", reasonCode: null };
  }

  if (status === "FAIL") {
    const reasonCode = value.reasonCode;
    if (typeof reasonCode !== "string" || !VALID_REASON_CODES.has(reasonCode)) {
      throw malformed(`${path}.reasonCode must be a known reason code for a FAIL check`);
    }
    return { name, status: "FAIL", reasonCode: reasonCode as CheckReasonCode };
  }

  if (status === "NOT_APPLICABLE") {
    const reasonCode = value.reasonCode;
    if (typeof reasonCode !== "string" || !VALID_NOT_APPLICABLE_CODES.has(reasonCode)) {
      throw malformed(`${path}.reasonCode must be a known not-applicable code for a NOT_APPLICABLE check`);
    }
    return { name, status: "NOT_APPLICABLE", reasonCode: reasonCode as NotApplicableCode };
  }

  throw malformed(`${path}.status must be one of PASS/FAIL/NOT_APPLICABLE`);
}

function parseCaseResult(value: unknown, path: string): EvaluationCaseResultV2 {
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
  const numerator = expectNonNegativeInteger(value.numerator, `${path}.numerator`);
  const denominator = expectNonNegativeInteger(value.denominator, `${path}.denominator`);
  return { numerator, denominator };
}

// The fifteen numerator/denominator aggregate metrics (six existing + nine
// Issue #59 Checkpoint B ratios), in the frozen EvaluationMetrics field order
// (see types.ts / evaluation-metrics.ts). Shared by the structural parser
// below and the semantic recompute-and-compare check.
const METRIC_RATIO_NAMES = [
  "retrievalTop1",
  "retrievalHitAt3",
  "schemaHandlingCorrectness",
  "evidenceGroundingCorrectness",
  "toolCorrectness",
  "expectedStatusCorrectness",
  "rootCauseDiscipline",
  "evidenceSupport",
  "unknownHandling",
  "diagnosticJustification",
  "confidenceCalibration",
  "actionGrounding",
  "approvalGate",
  "boundsRespected",
  "deterministicRecovery",
] as const;

type MetricRatioName = (typeof METRIC_RATIO_NAMES)[number];

function parseMetrics(value: unknown, path: string): EvaluationMetrics {
  if (!isRecord(value)) throw malformed(`expected an object at ${path}`);

  const totalCases = expectNonNegativeInteger(value.totalCases, `${path}.totalCases`);
  const passedCases = expectNonNegativeInteger(value.passedCases, `${path}.passedCases`);
  const failedCases = expectNonNegativeInteger(value.failedCases, `${path}.failedCases`);
  const passRate = expectFiniteNumber(value.passRate, `${path}.passRate`);

  const metricRatios = {} as Record<MetricRatioName, { readonly numerator: number; readonly denominator: number }>;

  for (const ratioName of METRIC_RATIO_NAMES) {
    metricRatios[ratioName] = parseMetricRatio(value[ratioName], `${path}.${ratioName}`);
  }

  return { totalCases, passedCases, failedCases, passRate, ...metricRatios };
}

// The single strict entry point for any /evaluations response body. Every
// structural guarantee of the frozen v2 result contract is re-checked here
// (nothing is blindly cast): top-level required fields, contract version,
// per-case/check shapes, status/reason-code closure, and all six metric
// ratios. A response carrying contractVersion 1 is rejected as
// UNSUPPORTED_VERSION — v1 is unwired from the active path.
export function parseEvaluationRunResultV2(value: unknown): PersistedEvaluationRunV2 {
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
// #61 Phase 3, final targeted fixes; OpsPilot #59 Checkpoint A advances the
// verdict derivation to the v2 status model). The runtime parser above proves
// the wire SHAPE; this proves the resource is internally SELF-CONSISTENT and —
// for a POST response — corresponds exactly to the submitted request. Any
// contradiction throws EvaluationServiceMalformedResponseError; the remote
// response is never silently repaired, so a contradictory result can never
// reach the formatter, PASS/Summary rendering, or exit code 0.
// ---------------------------------------------------------------------------

function validateSemanticConsistency(
  resource: PersistedEvaluationRunV2,
  submitted?: EvaluationSuiteInputV2,
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

    // A2. POST completeness — Issue #59 Checkpoint B. Every returned case must
    // carry exactly one outcome for each of the nine #59 metric checks, in the
    // fixed METRIC_CHECK_NAMES order. POST-only: pre-B persisted rows (GET)
    // legitimately predate the nine and remain compatible.
    for (const caseResult of resource.cases) {
      assertExactMetricCheckOutcomes(caseResult.checks, caseResult.caseId);
    }
  }

  // B. Case verdict consistency — a case's `passed` must equal the logical
  // verdict its emitted checks imply. The frozen local scorer semantics are
  // preserved exactly: a case passes iff no emitted check has status === "FAIL"
  // (vacuously true for zero checks — see evaluation-evaluator.ts's
  // evaluateCase and v2-types.ts). A NOT_APPLICABLE check never fails a case.
  for (let index = 0; index < resource.cases.length; index += 1) {
    const caseResult = resource.cases[index]!;
    const impliedVerdict = caseResult.checks.every((check) => check.status !== "FAIL");
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

// Issue #59 Checkpoint B POST completeness invariant: a POST response's every
// returned case must contain exactly one outcome for each of the nine #59
// metric checks, in the fixed METRIC_CHECK_NAMES order (the scorer emits them
// contiguously at the end of each case's check array — see
// evaluation-evaluator.ts evaluateCase and the METRIC_CHECK_NAMES contract
// comment). Any deviation — all nine absent, any one missing, a duplicate, an
// unexpected #59 name replacing one, or a reorder — is a malformed response
// that would otherwise let the entire Checkpoint-B evaluation be skipped
// while the worker renders PASS. Enforced ONLY on the POST response path
// (validateSemanticConsistency with a submitted request); pre-B persisted
// rows (GET) legitimately predate the nine and must stay compatible.
function assertExactMetricCheckOutcomes(checks: readonly EvaluationCheckV2[], caseId: string): void {
  const metricCheckNames = METRIC_CHECK_NAMES as readonly string[];
  const metricOutcomes = checks.filter((check) => metricCheckNames.includes(check.name));
  if (metricOutcomes.length !== METRIC_CHECK_NAMES.length) {
    throw malformed(
      `case "${caseId}" must contain exactly one outcome for each of the nine #59 metric checks; found ${metricOutcomes.length}`,
    );
  }
  for (let index = 0; index < METRIC_CHECK_NAMES.length; index += 1) {
    if (metricOutcomes[index]!.name !== METRIC_CHECK_NAMES[index]) {
      throw malformed(
        `case "${caseId}" #59 metric checks are missing, duplicated, replaced, or out of the required order`,
      );
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

  async score(input: EvaluationSuiteInputV2): Promise<EvaluationSuiteResultV2> {
    const resource = await this.createEvaluation(input);
    return {
      contractVersion: resource.contractVersion,
      datasetId: resource.datasetId,
      cases: resource.cases,
      metrics: resource.metrics,
    };
  }

  async createEvaluation(input: EvaluationSuiteInputV2): Promise<PersistedEvaluationRunV2> {
    const body = await requestJson(
      `${this.serviceUrl}/evaluations`,
      "POST",
      input,
      this.timeoutMs,
    );
    const resource = parseEvaluationRunResultV2(body);
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
  async fetchEvaluation(id: string): Promise<PersistedEvaluationRunV2> {
    const body = await requestJson(
      `${this.serviceUrl}/evaluations/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      this.timeoutMs,
    );
    const resource = parseEvaluationRunResultV2(body);
    validateSemanticConsistency(resource);
    return resource;
  }
}

export function createHttpEvaluationScorer(serviceUrl: string, timeoutMs: number): HttpEvaluationScorer {
  return new HttpEvaluationScorer(serviceUrl, timeoutMs);
}
