import { z } from "zod";

import type { ReportValidationIssue } from "./resolution-report-validation";

/**
 * The closed vocabulary of resolution-report contract invariants, as persisted
 * on a terminal REPORT_VALIDATION_FAILED event (Issue #105).
 *
 * WHY A CLOSED ENUM RATHER THAN THE SCHEMA'S OWN MESSAGES:
 *
 * Not safety. resolution-report-validation.ts already records that every
 * `custom` issue literal on ResolutionReportSchema is a fixed, hand-written
 * string with no interpolated report data, so forwarding those messages would
 * leak nothing the summarizer does not already surface.
 *
 * The reason is CONTRACT GOVERNANCE, the persisted-data analogue of the
 * prompt-governance argument Issue #101 made for its remedy map. Those
 * literals are validation-engine output written for humans reading a log. If
 * they were persisted verbatim, every future edit to a schema message would
 * silently become a change to a stored, queried vocabulary — with no schema
 * version, no migration, and no way to group historical rows against current
 * ones. Authoring the identifiers here makes the persisted surface
 * deliberate, and keeps investigation-event.ts's existing stance (see
 * RunFailedEventSchema: "THERE IS NO free-form failureMessage field,
 * deliberately") intact.
 *
 * MEMBERSHIP IS WRITE-PATH REACHABILITY, not every invariant in the schema.
 * ResolutionReportSchema's write shape requires `evidenceState`, so the three
 * legacy/read-compat branches that key on `evidenceState === undefined`
 * (the impossible-hybrid check and the two "Legacy report without
 * evidenceState ..." rules) cannot be produced by the orchestrator's report
 * submission path at all. They are deliberately absent; were one ever to
 * appear it degrades to OTHER, which is true but less specific.
 */
export const ReportInvariantSchema = z.enum([
  // ── Evidence-entry invariants ──
  "EVIDENCE_SUPPORTS_DUPLICATE_CLAIM",
  "ROOT_CAUSE_SUPPORT_WITHOUT_ROOT_CAUSE",
  "ROOT_CAUSE_WITHOUT_SUPPORTING_EVIDENCE",
  "NON_SUFFICIENT_WITH_ROOT_CAUSE",
  "SUFFICIENT_REQUIRES_EVIDENCE",
  "CONFLICTING_REQUIRES_TWO_EVIDENCE",
  // ── Disposition/action-cardinality invariants ──
  "ACTIONABLE_REQUIRES_ACTION",
  "ADVISORY_FORBIDS_ACTIONS",
  // ── Action-grounding invariants ──
  "ACTION_GROUNDING_EMPTY",
  "GROUNDED_BY_DUPLICATE_LOCATOR",
  "GROUNDED_BY_NOT_IN_EVIDENCE",
  // ── Enforced outside Zod, by the orchestrator's own evidence check ──
  "EVIDENCE_NOT_AVAILABLE_IN_RUN",
  // ── Fallbacks. Distinguished on purpose: a structurally malformed payload
  //    (wrong type, out of bounds, unknown key) is a different problem class
  //    from a structurally valid report that violates a semantic rule, and
  //    collapsing both into one bucket would hide that difference in exactly
  //    the distribution this field exists to measure.
  "STRUCTURAL",
  "OTHER",
]);

export type ReportInvariant = z.infer<typeof ReportInvariantSchema>;

export const REPORT_INVARIANT_VALUES = ReportInvariantSchema.options;

/**
 * Maps each write-reachable `custom` invariant message to its identifier.
 *
 * Keyed on the message literal from resolution-report.ts. That coupling is
 * deliberate and safe in ONE DIRECTION only, exactly as Issue #101's remedy
 * map documents: an unrecognized key falls through to OTHER, so a future
 * schema-message edit degrades this to a less specific but still true
 * classification — it can never produce a WRONG one. Keeping the mapping here
 * rather than refactoring fifteen `addIssue` call sites in the repo's most
 * safety-critical schema is the deliberately smaller change; the behavioral
 * tests in report-invariant.test.ts pin each mapping against the real schema,
 * so drift surfaces as a red test rather than as silently degraded data.
 */
const CUSTOM_MESSAGE_TO_INVARIANT: ReadonlyMap<string, ReportInvariant> = new Map([
  ["supports must not repeat the same claim value.", "EVIDENCE_SUPPORTS_DUPLICATE_CLAIM"],
  [
    "An evidence entry may not declare ROOT_CAUSE support when rootCause is null.",
    "ROOT_CAUSE_SUPPORT_WITHOUT_ROOT_CAUSE",
  ],
  [
    "A non-null rootCause requires at least one evidence entry to declare ROOT_CAUSE support.",
    "ROOT_CAUSE_WITHOUT_SUPPORTING_EVIDENCE",
  ],
  [
    "Non-sufficient evidence cannot carry a definitive rootCause; submit null.",
    "NON_SUFFICIENT_WITH_ROOT_CAUSE",
  ],
  [
    "SUFFICIENT evidence requires at least one distinct grounded evidence entry.",
    "SUFFICIENT_REQUIRES_EVIDENCE",
  ],
  [
    "CONFLICTING requires at least two distinct grounded evidence entries.",
    "CONFLICTING_REQUIRES_TWO_EVIDENCE",
  ],
  ["ACTIONABLE requires at least one suggested action.", "ACTIONABLE_REQUIRES_ACTION"],
  ["ADVISORY requires exactly zero suggested actions.", "ADVISORY_FORBIDS_ACTIONS"],
  [
    "Each suggested action must cite at least one evidence locator present in report.evidence.",
    "ACTION_GROUNDING_EMPTY",
  ],
  [
    "groundedBy must not repeat the same (sourceType, evidenceId) locator.",
    "GROUNDED_BY_DUPLICATE_LOCATOR",
  ],
  [
    "suggestedActions[].groundedBy entries must each appear in report.evidence.",
    "GROUNDED_BY_NOT_IN_EVIDENCE",
  ],
]);

/**
 * Classifies sanitized validation issues into the closed invariant vocabulary.
 *
 * Reads ONLY the sanitized summaries (code + the `custom` message literal),
 * never the submitted report, so nothing the model produced can reach the
 * ledger through this path — the same constraint Issue #101 applies to the
 * corrective-guidance text.
 *
 * De-duplicated and ordered by first appearance, because one malformed report
 * routinely trips the same invariant on several actions at once (two of the
 * four real LIVE runs on 2026-09-14 produced two identical F5 issues). The
 * result is therefore bounded by the vocabulary size, never by the issue
 * count.
 */
export function classifyReportInvariants(
  issues: readonly ReportValidationIssue[],
): ReportInvariant[] {
  const classified: ReportInvariant[] = [];

  for (const issue of issues) {
    const invariant: ReportInvariant =
      issue.code === "custom"
        ? (issue.message !== undefined
            ? CUSTOM_MESSAGE_TO_INVARIANT.get(issue.message)
            : undefined) ?? "OTHER"
        : "STRUCTURAL";

    if (!classified.includes(invariant)) {
      classified.push(invariant);
    }
  }

  return classified;
}
