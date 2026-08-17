import {
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  type EvidenceLocator,
} from "@opspilot/contracts";
import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
import type { CorpusProfile, EvaluationCase } from "./types";

// The fixed, deterministic (sourceType, evidenceId) identity used by the
// Issue #59 Checkpoint B locator-classification rules (spec §6 rules 6-8).
const locatorKey = (locator: { readonly sourceType: string; readonly evidenceId: string }): string =>
  `${locator.sourceType}:${locator.evidenceId}`;

const TOOL_EXECUTION = "TOOL_EXECUTION" as const;

// Bounded slug format for case ids — enforced before any case executes, so
// a caseId can never carry arbitrary/oversized text into CLI output (see
// docs/07-evaluation-plan.md). All 20 approved case ids match this pattern.
export const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_CASE_ID_LENGTH = 128;

function isValidCaseId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_CASE_ID_LENGTH && CASE_ID_PATTERN.test(id);
}

// Checkpoint B numeric-domain invariant: every count/token field (distinct
// locator cardinality, token budgets) is a non-negative integer — never
// fractional, never negative. Zero is valid where the semantics allow it
// (e.g. a token budget of 0). This must match the Python service's strict
// non-negative-int request schema exactly, so the local and service scorers
// accept and reject the same thresholds.
function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

// Shared by evaluation-runner.ts (execution) and this module (static
// resolution only, for corpus-membership checks) — pure and synchronous.
export function resolveCorpus(
  profile: CorpusProfile,
  defaultCorpus: readonly StoredRunbookChunk[],
  injectionProbeChunk: StoredRunbookChunk,
): readonly StoredRunbookChunk[] {
  switch (profile) {
    case "default":
      return defaultCorpus;
    case "injection-probe":
      return [injectionProbeChunk];
  }
}

// Every message below is a fixed, application-authored template. None ever
// interpolates a raw case id, chunk id, tool name, toolCallId, evidence id,
// or profile value from the case data itself — only a safe 1-based case
// ordinal (e.g. "Case 4") identifies which case a message concerns (see
// docs/07-evaluation-plan.md).
function validateCase(
  evaluationCase: EvaluationCase,
  ordinal: number,
  defaultCorpus: readonly StoredRunbookChunk[],
  injectionProbeChunk: StoredRunbookChunk,
): readonly string[] {
  const messages: string[] = [];
  const prefix = `Case ${ordinal}:`;
  const { expectations } = evaluationCase;

  if (evaluationCase.corpusProfile !== "default" && evaluationCase.corpusProfile !== "injection-probe") {
    messages.push(`${prefix} corpusProfile must be "default" or "injection-probe".`);
  }
  if (
    evaluationCase.toolProfile !== "default" &&
    evaluationCase.toolProfile !== "with-always-fails-tool"
  ) {
    messages.push(`${prefix} toolProfile must be "default" or "with-always-fails-tool".`);
  }

  if (!expectations.retrieval && !expectations.tool && !expectations.report && !expectations.failure) {
    messages.push(
      `${prefix} must declare at least one behavioral expectation (retrieval, tool, report, or failure).`,
    );
  }

  if (expectations.runStatus === "failed" && expectations.failure?.expectedCode === undefined) {
    messages.push(`${prefix} runStatus "failed" requires failure.expectedCode.`);
  }
  if (expectations.runStatus === "completed" && expectations.failure !== undefined) {
    messages.push(`${prefix} runStatus "completed" must not declare a failure expectation.`);
  }

  const hasPayloadExpectation =
    expectations.report?.requiredEvidenceTypes !== undefined ||
    expectations.report?.requiredEvidenceIds !== undefined ||
    expectations.report?.forbiddenEvidenceIds !== undefined ||
    expectations.report?.requiredActionTypes !== undefined;
  if (hasPayloadExpectation && expectations.runStatus !== "completed") {
    messages.push(
      `${prefix} report payload expectations (requiredEvidenceTypes/requiredEvidenceIds/forbiddenEvidenceIds/requiredActionTypes) require runStatus "completed".`,
    );
  }

  const expectedCode = expectations.failure?.expectedCode;
  if (expectations.report?.schemaExpectation === "INVALID" && expectedCode !== "REPORT_SCHEMA_INVALID") {
    messages.push(
      `${prefix} report.schemaExpectation "INVALID" requires failure.expectedCode "REPORT_SCHEMA_INVALID".`,
    );
  }
  if (expectations.report?.schemaExpectation === "VALID" && expectedCode === "REPORT_SCHEMA_INVALID") {
    messages.push(
      `${prefix} report.schemaExpectation "VALID" must not be paired with failure.expectedCode "REPORT_SCHEMA_INVALID".`,
    );
  }
  if (
    expectations.report?.groundingExpectation === "INVALID" &&
    expectedCode !== "REPORT_EVIDENCE_INVALID"
  ) {
    messages.push(
      `${prefix} report.groundingExpectation "INVALID" requires failure.expectedCode "REPORT_EVIDENCE_INVALID".`,
    );
  }
  if (
    expectations.report?.groundingExpectation === "VALID" &&
    expectedCode === "REPORT_EVIDENCE_INVALID"
  ) {
    messages.push(
      `${prefix} report.groundingExpectation "VALID" must not be paired with failure.expectedCode "REPORT_EVIDENCE_INVALID".`,
    );
  }

  const retrieval = expectations.retrieval;
  if (
    retrieval?.expectedNoResults &&
    (retrieval.expectedTop1 !== undefined || retrieval.expectedInTopK !== undefined)
  ) {
    messages.push(
      `${prefix} retrieval.expectedNoResults must not be combined with expectedTop1 or expectedInTopK.`,
    );
  }

  if (retrieval?.expectedInTopK !== undefined && retrieval.expectedInTopK.length === 0) {
    messages.push(`${prefix} retrieval.expectedInTopK must be non-empty when present.`);
  }

  const hasValidCorpusProfile =
    evaluationCase.corpusProfile === "default" || evaluationCase.corpusProfile === "injection-probe";

  if (retrieval && hasValidCorpusProfile) {
    const effectiveCorpus = resolveCorpus(evaluationCase.corpusProfile, defaultCorpus, injectionProbeChunk);
    const corpusIds = new Set(effectiveCorpus.map((chunk) => chunk.chunkId));
    const claimedIds = [
      ...(retrieval.expectedTop1 !== undefined ? [retrieval.expectedTop1] : []),
      ...(retrieval.expectedInTopK ?? []),
    ];

    if (claimedIds.some((id) => !corpusIds.has(id))) {
      messages.push(
        `${prefix} a retrieval expectation references a chunk id that is not present in the effective corpus.`,
      );
    }

    const forbiddenChunkIds = new Set(retrieval.forbiddenChunkIds ?? []);
    if (claimedIds.some((id) => forbiddenChunkIds.has(id))) {
      messages.push(`${prefix} retrieval.forbiddenChunkIds overlaps a declared expected chunk id.`);
    }
  }

  const tool = expectations.tool;
  if (tool) {
    const executedNames = new Set((tool.expectedExecuted ?? []).map((entry) => entry.toolName));
    const forbiddenExecutedNames = new Set(tool.forbiddenExecutedToolNames ?? []);
    if ([...executedNames].some((name) => forbiddenExecutedNames.has(name))) {
      messages.push(
        `${prefix} tool.expectedExecuted and forbiddenExecutedToolNames reference the same tool name.`,
      );
    }

    const completedIds = new Set((tool.expectedCompleted ?? []).map((entry) => entry.toolCallId));
    const forbiddenCompletedIds = new Set(tool.forbiddenCompletedToolCallIds ?? []);
    if ([...completedIds].some((id) => forbiddenCompletedIds.has(id))) {
      messages.push(
        `${prefix} tool.expectedCompleted and forbiddenCompletedToolCallIds reference the same toolCallId.`,
      );
    }
  }

  const report = expectations.report;
  if (report?.requiredEvidenceIds !== undefined && report.forbiddenEvidenceIds !== undefined) {
    const forbiddenEvidenceIds = new Set(report.forbiddenEvidenceIds);
    if (report.requiredEvidenceIds.some((id) => forbiddenEvidenceIds.has(id))) {
      messages.push(
        `${prefix} report.requiredEvidenceIds and forbiddenEvidenceIds reference the same evidence id.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Issue #59 Checkpoint B dataset-validation rules (spec §6). Fixed
  // application-authored messages, keyed only by the safe 1-based ordinal.
  // -------------------------------------------------------------------------

  // Rule 1: expectedConfidence.min and .max are finite JSON numbers in [0, 1]
  // with min <= max. The relational comparison runs only after both values are
  // proven finite numbers — JS coercion must never turn a boolean, numeric
  // string, or NaN/±Infinity into a valid band (the Python service's strict
  // schema rejects the same shapes, keeping the two scorers in agreement).
  // Confidence stays a continuous/fractional quantity: valid JSON integers
  // (0, 1) and fractions (0.25, 0.75) are all accepted.
  const expectedConfidence = expectations.expectedConfidence;
  if (expectedConfidence !== undefined) {
    const { min, max } = expectedConfidence;
    const minIsFinite = typeof min === "number" && Number.isFinite(min);
    const maxIsFinite = typeof max === "number" && Number.isFinite(max);
    if (!minIsFinite || !maxIsFinite) {
      messages.push(`${prefix} expectedConfidence.min and expectedConfidence.max must be finite numbers.`);
    } else if (!(min >= 0 && min <= max && max <= 1)) {
      messages.push(`${prefix} expectedConfidence must satisfy 0 <= min <= max <= 1.`);
    }
  }

  // Rule 2: expectedRootCause PRESENT → expectedEvidence.state SUFFICIENT.
  const expectedRootCause = expectations.expectedRootCause;
  const expectedEvidence = expectations.expectedEvidence;
  if (expectedRootCause === "PRESENT") {
    if (expectedEvidence === undefined || expectedEvidence.state !== "SUFFICIENT") {
      messages.push(`${prefix} expectedRootCause PRESENT requires expectedEvidence with state SUFFICIENT.`);
    }
  }

  // Rule 3 + Rule 4: every expectedAction has non-empty requiredGrounding and
  // requiredGrounding ⊆ allowedGrounding.
  const expectedActions = expectations.expectedActions;
  if (expectedActions !== undefined) {
    for (const action of expectedActions) {
      if (action.requiredGrounding.length === 0) {
        messages.push(`${prefix} every expectedActions entry must declare a non-empty requiredGrounding.`);
        break;
      }
    }
    for (const action of expectedActions) {
      const allowedKeys = new Set(action.allowedGrounding.map(locatorKey));
      const hasRequiredOutsideAllowed = action.requiredGrounding.some(
        (locator) => !allowedKeys.has(locatorKey(locator)),
      );
      if (hasRequiredOutsideAllowed) {
        messages.push(
          `${prefix} each expectedActions entry's requiredGrounding must be a subset of its allowedGrounding.`,
        );
        break;
      }
    }
  }

  // Rule 5: expectedApproval ELIGIBLE → completed run + non-empty expectedActions.
  const expectedApproval = expectations.expectedApproval;
  if (expectedApproval === "ELIGIBLE") {
    if (expectations.runStatus !== "completed") {
      messages.push(`${prefix} expectedApproval ELIGIBLE requires a completed run.`);
    }
    if (expectedActions === undefined || expectedActions.length === 0) {
      messages.push(`${prefix} expectedApproval ELIGIBLE requires at least one expectedActions entry.`);
    }
  }

  // Rules 6-8: expectedTelemetryEvidence disjoint/distinct/TOOL_EXECUTION-only,
  // complete classification of referenced TOOL_EXECUTION locators, and no
  // nonProbative locator in action.requiredGrounding.
  const expectedTelemetry = expectations.expectedTelemetryEvidence;
  const referencedToolLocatorKeys = new Set<string>();
  if (expectedEvidence !== undefined) {
    for (const locator of expectedEvidence.requiredLocators) {
      if (locator.sourceType === TOOL_EXECUTION) referencedToolLocatorKeys.add(locatorKey(locator));
    }
  }
  if (expectedActions !== undefined) {
    for (const action of expectedActions) {
      for (const locator of [...action.requiredGrounding, ...action.allowedGrounding]) {
        if (locator.sourceType === TOOL_EXECUTION) referencedToolLocatorKeys.add(locatorKey(locator));
      }
    }
  }
  if (expectedTelemetry !== undefined) {
    const probative = expectedTelemetry.probative;
    const nonProbative = expectedTelemetry.nonProbative;
    const probativeKeys = new Set(probative.map(locatorKey));
    const nonProbativeKeys = new Set(nonProbative.map(locatorKey));
    const allTelemetryLocators: readonly EvidenceLocator[] = [...probative, ...nonProbative];
    const disjointAndDistinct =
      probativeKeys.size === probative.length &&
      nonProbativeKeys.size === nonProbative.length &&
      [...probativeKeys].every((key) => !nonProbativeKeys.has(key));
    const toolExecutionOnly = allTelemetryLocators.every(
      (locator) => locator.sourceType === TOOL_EXECUTION,
    );
    if (!disjointAndDistinct || !toolExecutionOnly) {
      messages.push(
        `${prefix} expectedTelemetryEvidence probative and nonProbative must be disjoint, internally distinct, TOOL_EXECUTION-only locators.`,
      );
    }

    // Rule 8: no nonProbative locator in action.requiredGrounding.
    if (expectedActions !== undefined) {
      for (const action of expectedActions) {
        const requiredUsesNonProbative = action.requiredGrounding.some((locator) =>
          nonProbativeKeys.has(locatorKey(locator)),
        );
        if (requiredUsesNonProbative) {
          messages.push(
            `${prefix} expectedActions requiredGrounding must not reference a nonProbative locator.`,
          );
          break;
        }
      }
    }
  }
  if (referencedToolLocatorKeys.size > 0) {
    const classifiedKeys = new Set<string>();
    if (expectedTelemetry !== undefined) {
      for (const locator of [...expectedTelemetry.probative, ...expectedTelemetry.nonProbative]) {
        classifiedKeys.add(locatorKey(locator));
      }
    }
    const unclassifiedReference = [...referencedToolLocatorKeys].some(
      (key) => !classifiedKeys.has(key),
    );
    if (unclassifiedReference) {
      messages.push(
        `${prefix} every TOOL_EXECUTION locator referenced by expectedEvidence.requiredLocators, action requiredGrounding, or action allowedGrounding must be classified in expectedTelemetryEvidence.`,
      );
    }
  }

  // Rule 9: report-requiring expectations require runStatus "completed".
  const requiresCompletedReport =
    expectedRootCause !== undefined ||
    expectedEvidence !== undefined ||
    expectedTelemetry !== undefined ||
    expectedConfidence !== undefined ||
    expectedActions !== undefined;
  if (requiresCompletedReport && expectations.runStatus !== "completed") {
    messages.push(
      `${prefix} expectedRootCause/expectedEvidence/expectedTelemetryEvidence/expectedConfidence/expectedActions require runStatus "completed".`,
    );
  }

  // Rule 10: expectedApproval may be declared on completed or failed — no
  // constraint to enforce beyond rule 5 (applicability is terminal-only).

  // Rule 11 + Rule 12: expectedRecovery ⇔ runStatus "failed".
  const expectedRecovery = expectations.expectedRecovery;
  if (expectedRecovery !== undefined && expectations.runStatus !== "failed") {
    messages.push(`${prefix} expectedRecovery requires runStatus "failed".`);
  }
  if (expectations.runStatus === "failed" && expectedRecovery === undefined) {
    messages.push(`${prefix} runStatus "failed" requires expectedRecovery.`);
  }

  // Rule 13: expectedDiagnostics.length <= MAX_DIAGNOSTIC_TOOL_CALLS.
  if (
    expectations.expectedDiagnostics !== undefined &&
    expectations.expectedDiagnostics.length > MAX_DIAGNOSTIC_TOOL_CALLS
  ) {
    messages.push(`${prefix} expectedDiagnostics must not exceed the maximum diagnostic tool call bound.`);
  }

  // Rule 14: scripted provider turns <= MAX_PROVIDER_TURNS. Each scenario turn
  // is exactly one provider call (see the orchestrator finalization semantics).
  if (evaluationCase.scenario.turns.length > MAX_PROVIDER_TURNS) {
    messages.push(`${prefix} the scripted provider turns must not exceed the maximum provider turn bound.`);
  }

  // Rule 15 (Checkpoint B numeric-domain alignment): count/token expectation
  // fields are non-negative integers. A fractional or negative value is
  // rejected HERE so the local scorer and the Python service reject the same
  // thresholds (the service's strict schema would otherwise 422 a case the
  // local scorer happily accepted — a mode-dependent contract break).
  if (expectedEvidence?.minDistinctLocators !== undefined) {
    if (!isNonNegativeInteger(expectedEvidence.minDistinctLocators)) {
      messages.push(`${prefix} expectedEvidence.minDistinctLocators must be a non-negative integer.`);
    }
  }
  if (expectations.expectedBounds?.maxTotalTokens !== undefined) {
    if (!isNonNegativeInteger(expectations.expectedBounds.maxTotalTokens)) {
      messages.push(`${prefix} expectedBounds.maxTotalTokens must be a non-negative integer.`);
    }
  }

  // Rule 16: expectedStopReason requires expectedDiagnostics. Metric 4
  // (diagnostic-justification) is applicable only when expectedDiagnostics is
  // declared; a stop reason declared without it would never be inspected
  // (the metric returns NOT_APPLICABLE before reaching the stop-reason
  // comparison), so the expectation would be silently skipped instead of
  // enforced. Rejecting the orphan here keeps the malformed shape from ever
  // reaching scoring (see run-eval.ts — validation runs before any case).
  if (expectations.expectedStopReason !== undefined && expectations.expectedDiagnostics === undefined) {
    messages.push(`${prefix} expectedStopReason requires expectedDiagnostics.`);
  }

  return messages;
}

export function validateEvaluationDataset(input: {
  readonly cases: readonly EvaluationCase[];
  readonly defaultCorpus: readonly StoredRunbookChunk[];
  readonly injectionProbeChunk: StoredRunbookChunk;
}): readonly string[] {
  const { cases, defaultCorpus, injectionProbeChunk } = input;
  const messages: string[] = [];

  if (cases.length === 0) {
    messages.push("Evaluation dataset must contain at least one case.");
    return messages;
  }

  const seenIds = new Set<string>();
  cases.forEach((evaluationCase, index) => {
    const ordinal = index + 1;

    if (!isValidCaseId(evaluationCase.id)) {
      messages.push(`Case ${ordinal}: id is not a valid identifier.`);
      return;
    }
    if (seenIds.has(evaluationCase.id)) {
      messages.push(`Case ${ordinal}: id duplicates an earlier case.`);
    }
    seenIds.add(evaluationCase.id);
  });

  cases.forEach((evaluationCase, index) => {
    messages.push(...validateCase(evaluationCase, index + 1, defaultCorpus, injectionProbeChunk));
  });

  return messages;
}
