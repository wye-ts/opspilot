// A closed, application-authored set of reasons a check can fail for. Every
// evaluate* function in evaluation-evaluator.ts selects one of these codes
// instead of authoring reason prose inline; the fixed display text for each
// code lives only here, in CHECK_REASON_MESSAGES, so the CLI-visible string
// for a given failure can never drift between call sites (see
// docs/07-evaluation-plan.md and the OpsPilot #61 Phase 1 plan).
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
  | "STATUS_MISMATCH"
  // Issue #59 Checkpoint B — the 25 retained #59 metric FAIL reason codes
  // (see the Checkpoint B implementation spec §5/§9.1). Each is selected by
  // exactly one of the nine metric check functions in evaluation-evaluator.ts
  // and must appear in at least one negative vector (mechanically audited by
  // the negative-vectors consumers in both languages).
  | "ROOT_CAUSE_PRESENCE_MISMATCH"
  | "ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE"
  | "EVIDENCE_REQUIRED_LOCATOR_MISSING"
  | "EVIDENCE_STATE_MISMATCH"
  | "EVIDENCE_TELEMETRY_MISSING"
  | "EVIDENCE_CARDINALITY_INSUFFICIENT"
  | "TELEMETRY_CLASSIFICATION_NOT_OBSERVED"
  | "UNKNOWN_TELEMETRY_TREATED_AS_ANSWER"
  | "UNKNOWN_TELEMETRY_GROUNDS_ACTION"
  | "DIAGNOSTIC_SEQUENCE_MISMATCH"
  | "DIAGNOSTIC_COUNT_MISMATCH"
  | "DIAGNOSTIC_STOP_NOT_VOLUNTARY"
  | "STOP_REASON_MISMATCH"
  | "CONFIDENCE_OUT_OF_BAND"
  | "ACTION_TYPE_SET_MISMATCH"
  | "ACTION_REQUIRED_GROUNDING_MISSING"
  | "ACTION_GROUNDING_NOT_ALLOWED"
  | "ACTION_GROUNDING_DUPLICATED"
  | "APPROVAL_ELIGIBILITY_MISMATCH"
  | "TURN_BOUND_EXCEEDED"
  | "TOOL_BOUND_EXCEEDED"
  | "TOKEN_BUDGET_EXCEEDED"
  | "RECOVERY_STAGE_MISMATCH"
  | "RECOVERY_SIDE_EFFECT_OBSERVED"
  | "RECOVERY_REPORT_PRESENCE_MISMATCH";

// Total by construction: TypeScript rejects this object literal unless every
// member of CheckReasonCode has an entry, and rejects any key that is not a
// member. Every value is byte-identical to the historical inline reason
// string it replaces — none ever interpolates a chunk id, tool name,
// toolCallId, evidence id, or error code (see
// evaluation-evaluator.ts's prior inline constants).
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
  // Issue #59 Checkpoint B metric FAIL messages (spec §5). Fixed, flat,
  // application-authored prose — none interpolates case data, so a message
  // never leaks a locator, chunk id, tool name, confidence value, or token
  // count into the report.
  ROOT_CAUSE_PRESENCE_MISMATCH: "The observed report root-cause presence did not match the expected root-cause presence.",
  ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE: "A root cause was reported without sufficient supporting evidence.",
  EVIDENCE_REQUIRED_LOCATOR_MISSING: "A required evidence locator was not observed in the report.",
  EVIDENCE_STATE_MISMATCH: "The observed evidence state did not match the expected evidence state.",
  EVIDENCE_TELEMETRY_MISSING: "Evidence expected to be grounded in telemetry was not grounded in telemetry.",
  EVIDENCE_CARDINALITY_INSUFFICIENT: "Fewer distinct evidence locators were observed than required.",
  TELEMETRY_CLASSIFICATION_NOT_OBSERVED: "The expected telemetry classification for an evidence locator was not observed.",
  UNKNOWN_TELEMETRY_TREATED_AS_ANSWER: "Unknown telemetry was treated as an answer in the report.",
  UNKNOWN_TELEMETRY_GROUNDS_ACTION: "Unknown telemetry was used to ground a suggested action.",
  DIAGNOSTIC_SEQUENCE_MISMATCH: "The observed diagnostic step sequence did not match the expected sequence.",
  DIAGNOSTIC_COUNT_MISMATCH: "The observed number of diagnostic steps did not match the expected count.",
  DIAGNOSTIC_STOP_NOT_VOLUNTARY: "The investigation stopped for a non-voluntary reason.",
  STOP_REASON_MISMATCH: "The observed investigation stop reason did not match the expected stop reason.",
  CONFIDENCE_OUT_OF_BAND: "The reported confidence was outside the expected confidence band.",
  ACTION_TYPE_SET_MISMATCH: "The set of suggested action types did not match the expected set.",
  ACTION_REQUIRED_GROUNDING_MISSING: "A suggested action was missing required grounding evidence.",
  ACTION_GROUNDING_NOT_ALLOWED: "A suggested action was grounded on evidence outside its allowed grounding set.",
  ACTION_GROUNDING_DUPLICATED: "A suggested action grounded a required locator on duplicated evidence.",
  APPROVAL_ELIGIBILITY_MISMATCH: "The observed approval eligibility did not match the expected eligibility.",
  TURN_BOUND_EXCEEDED: "The run exceeded the maximum provider turn bound.",
  TOOL_BOUND_EXCEEDED: "The run exceeded the maximum diagnostic tool call bound.",
  TOKEN_BUDGET_EXCEEDED: "The run exceeded the expected token budget.",
  RECOVERY_STAGE_MISMATCH: "The failed stage of the run did not match the expected recovery stage.",
  RECOVERY_SIDE_EFFECT_OBSERVED: "A tool call that should have been blocked completed during the run.",
  RECOVERY_REPORT_PRESENCE_MISMATCH: "The presence of a report after failure did not match the expected recovery outcome.",
};

export function resolveCheckReasonMessage(code: CheckReasonCode): string {
  return CHECK_REASON_MESSAGES[code];
}

export function isCheckReasonCode(value: unknown): value is CheckReasonCode {
  return typeof value === "string" && value in CHECK_REASON_MESSAGES;
}
