// The closed, application-authored set of reasons a v2 check can be
// structurally NOT_APPLICABLE for (see v2-types.ts's EvaluationCheckV2). At
// Checkpoint A the active scorer emits PASS/FAIL only — this vocabulary is
// the structural support the v2 contract requires so a future check can
// declare a case/situation inapplicable without inventing a metric-specific
// reason code (those belong to Issue #59 Checkpoint B). The fixed display
// text for each code lives only here, in NOT_APPLICABLE_MESSAGES, so the
// CLI-visible string for a given not-applicable outcome can never drift
// between call sites (mirroring check-reason-codes.ts).
export type NotApplicableCode =
  | "NA_RUN_DID_NOT_COMPLETE"
  | "NA_EXPECTATION_NOT_DECLARED"
  | "NA_NO_RECOVERY_PATH_EXERCISED";

// Total by construction: TypeScript rejects this object literal unless every
// member of NotApplicableCode has an entry, and rejects any key that is not
// a member. Every value is a fixed, application-authored sentence — never
// interpolates case data.
export const NOT_APPLICABLE_MESSAGES: Record<NotApplicableCode, string> = {
  NA_RUN_DID_NOT_COMPLETE: "The run did not complete, so this check cannot be evaluated.",
  NA_EXPECTATION_NOT_DECLARED: "No expectation was declared for this check.",
  NA_NO_RECOVERY_PATH_EXERCISED: "No recovery path was exercised in this run.",
};

export function resolveNotApplicableMessage(code: NotApplicableCode): string {
  return NOT_APPLICABLE_MESSAGES[code];
}

export function isNotApplicableCode(value: unknown): value is NotApplicableCode {
  return typeof value === "string" && value in NOT_APPLICABLE_MESSAGES;
}
