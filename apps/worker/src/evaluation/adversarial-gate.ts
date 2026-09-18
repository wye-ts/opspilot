import type { EvaluationCaseResultV2 } from "./v2-types";

// Issue #78 §2.1 — the declared structural adversarial case set.
//
// WHY THIS CONSTANT EXISTS. `evaluation-dataset.test.ts` already pins the exact
// case ids and their order (22 at the time of Issue #78, 26 since Issue #94),
// so deleting one of these three fails CI today —
// but only as "the pinned id list changed", indistinguishable from renaming a
// topical case, and satisfiable by an editor who simply updates the pinned list
// to match their edit. This constant plus its membership test (see
// adversarial-gate.test.ts) makes the removal of a SECURITY case fail with a
// message that says so.
//
// WHY EXACTLY THESE THREE. Each is a case whose fabrication/injection attempt is
// narratively driven by adversarial content actually present in the run:
//   - injection-probe-structural      (15) — adversarial corpus chunk
//   - fabricated-tool-output-evidence (21) — adversarial tool OUTPUT content
//   - adversarial-tool-input-shape    (22) — attacker-plausible extra tool-input field
//
// WHY CASES 7/8 ARE EXCLUDED, deliberately and not by oversight.
// `fabricated-rag-evidence` (7) and `fabricated-tool-evidence` (8) are bare
// "the scripted report cites an id that was never produced in this run" cases:
// there is no adversarial content anywhere in those runs to drive the
// fabrication. They exercise the same evidence-grounding validator, but they are
// not adversarial-content cases. This distinction is the one Issue #77's plan
// (docs/reviews/32-issue-77-adversarial-case-expansion-plan.md, "Scope
// decision") established when the set was defined as 3. Do not "correct" this
// list to 5 — see docs/reviews/34-issue-78-ci-adversarial-gate-plan.md §1.
//
// WHAT THIS IS NOT. These cases run against FakeLlmProvider, whose turns are
// pre-authored and never read the adversarial payload. They prove the
// ORCHESTRATOR'S VALIDATORS reject fabricated evidence and malformed tool input
// — a code guarantee. They prove nothing about whether a real model resists an
// injected instruction; that question belongs to the manual live-spike
// scenarios (docs/reviews/33-issue-77-adversarial-case-expansion-spike-results.md)
// and is currently blocked on Issue #85 for the RAG-channel cases. Never
// describe this set as evidence of model-behavioral adversarial robustness.
export const ADVERSARIAL_CASE_IDS = [
  "injection-probe-structural",
  "fabricated-tool-output-evidence",
  "adversarial-tool-input-shape",
] as const;

// Case ids deliberately NOT in the set above, with the reason recorded so the
// exclusion is testable rather than a comment someone can silently disagree
// with. See the "WHY CASES 7/8 ARE EXCLUDED" note above.
export const NON_ADVERSARIAL_FABRICATION_CASE_IDS = [
  "fabricated-rag-evidence",
  "fabricated-tool-evidence",
] as const;

export interface AdversarialSummary {
  // How many adversarial cases are DECLARED (always ADVERSARIAL_CASE_IDS.length).
  readonly declared: number;
  // How many of them appear in the supplied results.
  readonly present: number;
  // How many appear AND passed.
  readonly passed: number;
  // Declared ids with no result, in ADVERSARIAL_CASE_IDS order.
  readonly missingIds: readonly string[];
}

// Derives the structural-adversarial readout from a run's case results.
//
// The ratio the formatter renders is passed/DECLARED, never passed/present: a
// case absent from a caller-supplied subset must not be able to hide behind a
// shrunken denominator. On the real CLI path every declared case is always
// present (run-eval.ts always runs the full EVALUATION_CASES; both scorers
// return exactly the submitted case ids — LocalEvaluationScorer maps 1:1, and
// evaluation-service-client.ts asserts exact ordered request/response case-id
// equality), so `missingIds` is empty there. It is non-empty only for an
// in-process caller passing its own `cases` array, which several unit tests
// legitimately do — hence this is a rendering concern, NOT an exit-code gate.
// See docs/reviews/34-issue-78-ci-adversarial-gate-plan.md §0.1a.
export function summarizeAdversarialCases(
  results: readonly EvaluationCaseResultV2[],
): AdversarialSummary {
  const resultsById = new Map(results.map((result) => [result.caseId, result]));

  const missingIds = ADVERSARIAL_CASE_IDS.filter((caseId) => !resultsById.has(caseId));
  const present = ADVERSARIAL_CASE_IDS.length - missingIds.length;
  const passed = ADVERSARIAL_CASE_IDS.filter((caseId) => resultsById.get(caseId)?.passed === true).length;

  return {
    declared: ADVERSARIAL_CASE_IDS.length,
    present,
    passed,
    missingIds,
  };
}
