// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): a byte-for-byte
// snapshot of the historical v1 check-failure vocabulary, preserved so the
// offline v1 regression oracle (parity-v1.test.ts) keeps reproducing the
// frozen ts-parity-v1.json fixture forever. The active contract's reason
// codes live in ../check-reason-codes.ts; this module is unwired from the
// active runtime and must never change.
//
// A closed, application-authored set of reasons a check can fail for. Every
// evaluate* function in evaluator-v1.ts selects one of these codes instead of
// authoring reason prose inline; the fixed display text for each code lives
// only here, in CHECK_REASON_MESSAGES, so the CLI-visible string for a given
// failure can never drift between call sites.
export type CheckReasonCode =
  | "RETRIEVAL_NOT_OBSERVED"
  | "RETRIEVAL_TOP1_MISMATCH"
  | "RETRIEVAL_HIT3_MISMATCH"
  | "RETRIEVAL_NO_RESULTS_MISMATCH"
  | "RETRIEVAL_FORBIDDEN_MISMATCH"
  | "TOOL_REQUESTED_MISMATCH"
  | "TOOL_EXECUTED_MISMATCH"
  | "TOOL_COMPLETED_MISMATCH"
  | "TOOL_FORBIDDEN_EXECUTED_MISMATCH"
  | "TOOL_FORBIDDEN_COMPLETED_MISMATCH"
  | "SCHEMA_HANDLING_MISMATCH"
  | "EVIDENCE_GROUNDING_MISMATCH"
  | "PAYLOAD_NOT_AVAILABLE"
  | "EVIDENCE_TYPES_MISMATCH"
  | "EVIDENCE_IDS_MISMATCH"
  | "ACTION_TYPES_MISMATCH"
  | "FAILURE_CODE_RUN_COMPLETED"
  | "FAILURE_CODE_MISMATCH"
  | "STATUS_MISMATCH";

export const CHECK_REASON_MESSAGES: Record<CheckReasonCode, string> = {
  RETRIEVAL_NOT_OBSERVED: "No retrieval result was observed for this case.",
  RETRIEVAL_TOP1_MISMATCH: "The expected top-ranked chunk was not observed.",
  RETRIEVAL_HIT3_MISMATCH: "One or more expected chunks were absent from the top three results.",
  RETRIEVAL_NO_RESULTS_MISMATCH: "Retrieval returned results when none were expected.",
  RETRIEVAL_FORBIDDEN_MISMATCH: "A forbidden chunk id was observed in the retrieval results.",
  TOOL_REQUESTED_MISMATCH: "The expected tool request was not observed.",
  TOOL_EXECUTED_MISMATCH: "The expected tool execution attempt was not observed.",
  TOOL_COMPLETED_MISMATCH: "The expected tool execution did not complete.",
  TOOL_FORBIDDEN_EXECUTED_MISMATCH: "A forbidden tool was executed in this run.",
  TOOL_FORBIDDEN_COMPLETED_MISMATCH: "A forbidden tool call was observed as completed.",
  SCHEMA_HANDLING_MISMATCH: "The report's schema-validation outcome did not match the expected outcome.",
  EVIDENCE_GROUNDING_MISMATCH: "The report's evidence-grounding outcome did not match the expected outcome.",
  PAYLOAD_NOT_AVAILABLE: "The run did not complete, so no report was available to check.",
  EVIDENCE_TYPES_MISMATCH: "The submitted report did not contain all required evidence types.",
  EVIDENCE_IDS_MISMATCH:
    "The submitted report did not satisfy the required or forbidden evidence id expectations.",
  ACTION_TYPES_MISMATCH: "The submitted report did not contain all required suggested-action types.",
  FAILURE_CODE_RUN_COMPLETED: "The run completed, but a failure was expected.",
  FAILURE_CODE_MISMATCH: "The observed failure code did not match the expected failure code.",
  STATUS_MISMATCH: "The observed run status did not match the expected run status.",
};

export function resolveCheckReasonMessage(code: CheckReasonCode): string {
  return CHECK_REASON_MESSAGES[code];
}
