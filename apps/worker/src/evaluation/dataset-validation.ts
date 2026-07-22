import type { StoredRunbookChunk } from "../rag/runbook-retriever";
import type { CorpusProfile, EvaluationCase } from "./types";

// Bounded slug format for case ids — enforced before any case executes, so
// a caseId can never carry arbitrary/oversized text into CLI output (see
// docs/07-evaluation-plan.md). All 15 approved case ids match this pattern.
export const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_CASE_ID_LENGTH = 128;

function isValidCaseId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_CASE_ID_LENGTH && CASE_ID_PATTERN.test(id);
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
