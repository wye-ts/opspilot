import { describe, expect, it } from "vitest";
import {
  ResolutionReportSchema,
  summarizeReportValidationIssues,
  classifyReportInvariants,
} from "@opspilot/contracts";

/**
 * Issue #115 (implemented as #114) auto-completes evidence when
 * GROUNDED_BY_NOT_IN_EVIDENCE (F5) is the SOLE violated invariant.
 *
 * A local completion-rate measurement (docs/reviews/48-...) produced a real
 * REPORT_SCHEMA_INVALID whose issue list was:
 *
 *   - suggestedActions[].groundedBy entries must each appear in report.evidence.  (x2)
 *   - SUFFICIENT evidence requires at least one distinct grounded evidence entry.
 *
 * i.e. F5 co-occurring with SUFFICIENT_REQUIRES_EVIDENCE, so auto-completion
 * declined by design and the run failed.
 *
 * These tests characterize WHY that pair co-occurs, because the two are not
 * independent: SUFFICIENT_REQUIRES_EVIDENCE fires on
 * `countDistinctEvidenceLocators(report.evidence) < 1`, so an EMPTY evidence
 * array with a grounded suggested action necessarily trips BOTH. That shape —
 * "the model grounded its action but never listed the evidence separately" —
 * is precisely the shape #115 exists to heal, so the eligibility rule excludes
 * its own motivating case whenever the omission is total rather than partial.
 *
 * These tests assert current behavior. They do not assert that the eligibility
 * rule should change — that is an owner decision recorded in the results doc.
 */

const REAL_TOOL_EXEC = "call-1";
const SECOND_TOOL_EXEC = "call-2";

/**
 * Shaped after the known-good fixture in report-stage-ledger.test.ts so the
 * only thing these cases vary is the evidence/groundedBy relationship — not
 * incidental structural validity.
 */
function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "SERVICE_DEGRADATION",
    summary: "Billing service returned elevated 5xx responses to API callers.",
    rootCause: null,
    customerImpact: "A subset of billing API calls failed.",
    recommendedResolution: "No action required; monitor for regression.",
    confidence: 0.6,
    evidenceState: "SUFFICIENT",
    recommendationDisposition: "ADVISORY",
    evidence: [
      {
        evidenceId: REAL_TOOL_EXEC,
        sourceType: "TOOL_EXECUTION",
        finding: "get_service_status returned a status for the billing service.",
        supports: [],
      },
    ],
    suggestedActions: [],
    ...overrides,
  };
}

const GROUNDED_ACTION = {
  type: "CREATE_ESCALATION",
  payload: {
    team: "Billing",
    reason: "The billing error rate needs an owner decision on rollback.",
    priority: "MEDIUM",
  },
  groundedBy: [{ evidenceId: REAL_TOOL_EXEC, sourceType: "TOOL_EXECUTION" }],
};

function invariantIdsFor(payload: unknown): readonly string[] {
  const parsed = ResolutionReportSchema.safeParse(payload);
  if (parsed.success) return [];
  const issues = summarizeReportValidationIssues(parsed.error);
  // Exactly what agent-orchestrator.ts feeds the eligibility check.
  return classifyReportInvariants(issues);
}

describe("#115 eligibility vs. a totally-omitted evidence array", () => {
  it("a grounded action with an EMPTY evidence array trips F5 AND SUFFICIENT_REQUIRES_EVIDENCE together", () => {
    const ids = invariantIdsFor(
      baseReport({
        recommendationDisposition: "ACTIONABLE",
        evidence: [],
        suggestedActions: [GROUNDED_ACTION],
      }),
    );

    // Both fire from ONE underlying mistake: evidence was never listed.
    expect(ids).toContain("GROUNDED_BY_NOT_IN_EVIDENCE");
    expect(ids).toContain("SUFFICIENT_REQUIRES_EVIDENCE");
    // ...which is why #115's "F5 must be the sole invariant" rule cannot apply.
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  it("the same omission under INSUFFICIENT trips F5 alone, so #115 can apply", () => {
    const ids = invariantIdsFor(
      baseReport({
        evidenceState: "INSUFFICIENT",
        recommendationDisposition: "ACTIONABLE",
        evidence: [],
        suggestedActions: [GROUNDED_ACTION],
      }),
    );

    expect([...new Set(ids)]).toEqual(["GROUNDED_BY_NOT_IN_EVIDENCE"]);
  });

  it("a PARTIAL omission under SUFFICIENT trips F5 alone — the case #115 does heal", () => {
    const ids = invariantIdsFor(
      baseReport({
        recommendationDisposition: "ACTIONABLE",
        // One real entry present, so distinct >= 1 and SUFFICIENT is satisfied...
        suggestedActions: [
          {
            ...GROUNDED_ACTION,
            // ...while the action grounds on a SECOND locator that is absent.
            groundedBy: [
              { evidenceId: REAL_TOOL_EXEC, sourceType: "TOOL_EXECUTION" },
              { evidenceId: SECOND_TOOL_EXEC, sourceType: "TOOL_EXECUTION" },
            ],
          },
        ],
      }),
    );

    expect([...new Set(ids)]).toEqual(["GROUNDED_BY_NOT_IN_EVIDENCE"]);
  });

  it("listing the omitted entry clears BOTH invariants, so the pair has one root cause", () => {
    const ids = invariantIdsFor(
      baseReport({
        recommendationDisposition: "ACTIONABLE",
        suggestedActions: [GROUNDED_ACTION],
      }),
    );

    expect(ids).toEqual([]);
  });
});
