import { describe, expect, it } from "vitest";

import { ResolutionReportSchema } from "./resolution-report";
import { summarizeReportValidationIssues } from "./resolution-report-validation";
import {
  REPORT_INVARIANT_VALUES,
  ReportInvariantSchema,
  classifyReportInvariants,
  type ReportInvariant,
} from "./report-invariant";

// A report that satisfies the write contract. Each case below mutates exactly
// one aspect of it, so a case's classification is attributable to that mutation
// and nothing else.
const VALID_REPORT = {
  category: "AUTHENTICATION",
  summary: "Login failures began after the identity provider rotated its certificate.",
  rootCause: "The identity provider's rotated certificate was not distributed to the auth gateway.",
  customerImpact: "Some users intermittently cannot log in.",
  recommendedResolution: "Redistribute the rotated certificate to the auth gateway fleet.",
  confidence: 0.8,
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ACTIONABLE",
  evidence: [
    {
      evidenceId: "toolu_01AAAA",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-gateway reported DEGRADED with certificate validation errors.",
      supports: ["ROOT_CAUSE"],
    },
  ],
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Root cause identified; remediation is understood." },
      groundedBy: [{ evidenceId: "toolu_01AAAA", sourceType: "TOOL_EXECUTION" }],
    },
  ],
} as const;

/**
 * Runs a candidate payload through the REAL schema and classifier.
 *
 * Deliberately not hand-constructed ReportValidationIssue fixtures: the whole
 * point of this module is that it keys on message literals owned by
 * resolution-report.ts, so a test feeding its own hand-written literals would
 * pass even if every real message had been reworded. This is the same
 * discipline the repo applies to negative-path fixtures generally — verify
 * against the real schema, never against a hand-reasoned approximation.
 */
function classifyRealRejection(payload: unknown): {
  invariants: ReportInvariant[];
  messages: (string | undefined)[];
} {
  const parsed = ResolutionReportSchema.safeParse(payload, { reportInput: true });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("unreachable");

  const issues = summarizeReportValidationIssues(parsed.error);
  return {
    invariants: classifyReportInvariants(issues),
    messages: issues.map((issue) => issue.message),
  };
}

describe("classifyReportInvariants — against the real schema", () => {
  it("the baseline fixture is genuinely VALID, so every case below is attributable", () => {
    // Load-bearing. The first version of this fixture was missing three
    // required fields, so every mutation below failed on a cheap structural
    // rule and classified as STRUCTURAL — the tests went red for the wrong
    // reason, and had the classifier been broken they would have gone green
    // for the wrong reason too. This guard makes that failure mode impossible
    // to reintroduce silently.
    expect(ResolutionReportSchema.safeParse(VALID_REPORT, { reportInput: true }).success).toBe(true);
  });

  it("classifies F5, the invariant every attributable real LIVE failure hit", () => {
    // The action cites a locator that is absent from evidence — the exact
    // shape observed in production on 2026-09-14/15.
    const { invariants, messages } = classifyRealRejection({
      ...VALID_REPORT,
      suggestedActions: [
        {
          ...VALID_REPORT.suggestedActions[0],
          groundedBy: [{ evidenceId: "toolu_NEVER_LISTED", sourceType: "TOOL_EXECUTION" }],
        },
      ],
    });

    expect(invariants).toEqual(["GROUNDED_BY_NOT_IN_EVIDENCE"]);
    // Pin the coupling itself: if this literal is reworded in
    // resolution-report.ts without updating the map, the mapping silently
    // degrades to OTHER, and this assertion is what catches it.
    expect(messages).toContain(
      "suggestedActions[].groundedBy entries must each appear in report.evidence.",
    );
  });

  it("classifies the ACTIONABLE/zero-action contradiction distinctly from F5", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      suggestedActions: [],
    });

    // Distinctness is the point of the whole issue: these two invariants want
    // different fixes, so they must never collapse into one bucket.
    expect(invariants).toEqual(["ACTIONABLE_REQUIRES_ACTION"]);
  });

  it("classifies ADVISORY carrying actions", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      recommendationDisposition: "ADVISORY",
    });

    expect(invariants).toEqual(["ADVISORY_FORBIDS_ACTIONS"]);
  });

  it("classifies a duplicated groundedBy locator", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      suggestedActions: [
        {
          ...VALID_REPORT.suggestedActions[0],
          groundedBy: [
            { evidenceId: "toolu_01AAAA", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "toolu_01AAAA", sourceType: "TOOL_EXECUTION" },
          ],
        },
      ],
    });

    expect(invariants).toContain("GROUNDED_BY_DUPLICATE_LOCATOR");
  });

  it("classifies a non-SUFFICIENT report carrying a definitive rootCause", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      evidenceState: "INSUFFICIENT",
    });

    expect(invariants).toContain("NON_SUFFICIENT_WITH_ROOT_CAUSE");
  });

  it("classifies ROOT_CAUSE support declared against a null rootCause", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      rootCause: null,
      evidenceState: "INSUFFICIENT",
    });

    expect(invariants).toContain("ROOT_CAUSE_SUPPORT_WITHOUT_ROOT_CAUSE");
  });

  it("classifies a structurally malformed payload as STRUCTURAL, not OTHER", () => {
    // Wrong type on a required field — a Zod structural failure, not a
    // semantic invariant. The two are separated on purpose: they are different
    // problem classes and must stay distinguishable in the distribution.
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      confidence: "high",
    });

    expect(invariants).toEqual(["STRUCTURAL"]);
  });

  it("de-duplicates one invariant tripped by several actions at once", () => {
    // Two of the four real LIVE runs on 2026-09-14 produced two identical F5
    // issues; the persisted field must not repeat the identifier.
    const { invariants, messages } = classifyRealRejection({
      ...VALID_REPORT,
      suggestedActions: [
        {
          ...VALID_REPORT.suggestedActions[0],
          groundedBy: [
            { evidenceId: "toolu_MISSING_1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "toolu_MISSING_2", sourceType: "TOOL_EXECUTION" },
          ],
        },
      ],
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(invariants).toEqual(["GROUNDED_BY_NOT_IN_EVIDENCE"]);
  });

  it("never returns an identifier outside the declared vocabulary", () => {
    const { invariants } = classifyRealRejection({
      ...VALID_REPORT,
      confidence: "high",
      suggestedActions: [],
    });

    for (const invariant of invariants) {
      expect(REPORT_INVARIANT_VALUES).toContain(invariant);
      expect(ReportInvariantSchema.safeParse(invariant).success).toBe(true);
    }
  });

  it("falls back to OTHER for an unrecognized custom invariant rather than throwing", () => {
    // Simulates a future schema message that the map does not know. This is
    // the one case that cannot be driven through the real schema, because by
    // construction no such literal exists yet — so it is fed directly, and the
    // assertion is that the degradation is to a less specific but still true
    // classification.
    expect(
      classifyReportInvariants([
        { path: ["evidence"], code: "custom", message: "A rule invented after this map was written." },
      ]),
    ).toEqual(["OTHER"]);
  });

  it("classifies a custom issue carrying no message as OTHER", () => {
    expect(classifyReportInvariants([{ path: ["evidence"], code: "custom" }])).toEqual(["OTHER"]);
  });
});
