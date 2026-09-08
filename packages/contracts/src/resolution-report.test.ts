import { describe, expect, it } from "vitest";

import { ResolutionReportSchema, StoredResolutionReportSchema } from "./resolution-report";
import { summarizeReportValidationIssues } from "./resolution-report-validation";

// A grounded, causal SUFFICIENT report — the pre-#58 "happy path" plus the #58
// required evidenceState field and the #60 recommendationDisposition +
// groundedBy fields.
const causalSufficientReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause:
    "The notification service is degraded after repeated upstream rate-limit responses.",
  customerImpact:
    "Some password-reset and account-verification emails are delayed.",
  recommendedResolution:
    "Monitor the upstream provider, reduce retry pressure, and escalate if degradation continues.",
  confidence: 0.9,
  evidence: [
    {
      evidenceId: "rag-chunk-001",
      sourceType: "RAG_CHUNK",
      finding:
        "The runbook identifies upstream rate limiting as a known cause of delayed notifications.",
      // Issue #55: at least one entry must declare ROOT_CAUSE support
      // whenever rootCause is non-null (2.2b) — this is that entry.
      supports: ["ROOT_CAUSE"],
    },
    {
      evidenceId: "tool-execution-001",
      sourceType: "TOOL_EXECUTION",
      finding: "The notification service currently reports DEGRADED.",
      supports: [],
    },
  ],
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Messaging Platform",
        reason: "Sustained upstream rate limiting is affecting customers.",
        priority: "HIGH",
      },
      groundedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
    },
  ],
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ACTIONABLE",
} as const;

// A #58-era stored row that never saw #60: disposition absent, action
// groundedBy absent. Used as the base for the G1/G1b/G2/G3 read-path cases.
const storedRowBase = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause: "The notification service is degraded after repeated upstream rate-limit responses.",
  customerImpact: "Some password-reset and account-verification emails are delayed.",
  recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
  confidence: 0.9,
  evidenceState: "SUFFICIENT",
  evidence: [
    {
      evidenceId: "tool-execution-001",
      sourceType: "TOOL_EXECUTION",
      finding: "The notification service currently reports DEGRADED.",
    },
  ],
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
    },
  ],
};

const groundedUpdateTicketAction = {
  type: "UPDATE_TICKET_STATUS",
  payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
  groundedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
};

const groundedDraftReplyAction = {
  type: "DRAFT_CUSTOMER_REPLY",
  payload: {
    subject: "Update on your ticket",
    body: "We are still investigating the delayed notifications.",
  },
  groundedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
};

// B — an ADVISORY report: informational/monitoring-only, zero actions.
const advisoryReport = {
  ...causalSufficientReport,
  recommendedResolution: "No action required; monitor for regression.",
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// C — no sufficiency gate: INSUFFICIENT evidence can still be ACTIONABLE when
// a grounded communication action is appropriate.
const insufficientActionableDraftReply = {
  ...causalSufficientReport,
  category: "UNKNOWN",
  evidenceState: "INSUFFICIENT",
  rootCause: null,
  evidence: causalSufficientReport.evidence.slice(1),
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [groundedDraftReplyAction],
};

// D — no sufficiency gate: CONFLICTING evidence can still be ACTIONABLE when a
// grounded escalation/adjudication action is appropriate. The escalation does
// not assert either conflicting side as resolved.
const conflictingActionableEscalation = {
  ...causalSufficientReport,
  category: "UNKNOWN",
  evidenceState: "CONFLICTING",
  rootCause: null,
  evidence: [
    {
      evidenceId: "call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "Probe reported DEGRADED.",
      supports: [],
    },
    {
      evidenceId: "call-2",
      sourceType: "TOOL_EXECUTION",
      finding: "Probe reported OPERATIONAL for the same claim.",
      supports: [],
    },
  ],
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Messaging Platform",
        reason: "Evidence conflicts; escalate for adjudication.",
        priority: "HIGH",
      },
      groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
    },
  ],
};

// E — SUFFICIENT non-causal conclusion: rootCause null, ADVISORY, zero actions.
// Issue #55: evidence's `supports` is explicitly re-stripped to [] here
// (never inherited from causalSufficientReport's ROOT_CAUSE-supporting
// entry) — 2.2a forbids ROOT_CAUSE support whenever rootCause is null.
const sufficientNonCausalAdvisory = {
  ...causalSufficientReport,
  rootCause: null,
  evidence: causalSufficientReport.evidence.map((entry) => ({ ...entry, supports: [] })),
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

describe("ResolutionReportSchema (strict new-write contract)", () => {
  it("accepts a valid grounded SUFFICIENT report with a causal rootCause (A)", () => {
    expect(ResolutionReportSchema.safeParse(causalSufficientReport).success).toBe(true);
  });

  it("accepts an ADVISORY report with zero suggested actions (B)", () => {
    expect(ResolutionReportSchema.safeParse(advisoryReport).success).toBe(true);
  });

  it("accepts INSUFFICIENT + ACTIONABLE grounded DRAFT_CUSTOMER_REPLY — no sufficiency gate (C)", () => {
    expect(ResolutionReportSchema.safeParse(insufficientActionableDraftReply).success).toBe(true);
  });

  it("accepts CONFLICTING + ACTIONABLE grounded CREATE_ESCALATION — no sufficiency gate (D)", () => {
    expect(ResolutionReportSchema.safeParse(conflictingActionableEscalation).success).toBe(true);
  });

  it("accepts SUFFICIENT non-causal + ADVISORY with zero actions (E)", () => {
    expect(ResolutionReportSchema.safeParse(sufficientNonCausalAdvisory).success).toBe(true);
  });

  it("accepts SUFFICIENT + rootCause null (a grounded non-causal conclusion)", () => {
    // P1-1: the invariant is one-way — sufficient evidence may carry a null
    // rootCause for a "no fault observed / healthy" verdict. Issue #55:
    // supports is stripped to [] since 2.2a forbids ROOT_CAUSE support when
    // rootCause is null.
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        rootCause: null,
        evidence: causalSufficientReport.evidence.map((entry) => ({ ...entry, supports: [] })),
      }).success,
    ).toBe(true);
  });

  it("accepts INSUFFICIENT + rootCause null + one evidence entry", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: causalSufficientReport.evidence.slice(1),
      }).success,
    ).toBe(true);
  });

  it("accepts a truthful zero-evidence INSUFFICIENT report (C0)", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: [],
        recommendationDisposition: "ADVISORY",
        suggestedActions: [],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-SUFFICIENT report with a non-null rootCause (P1-1)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      evidenceState: "INSUFFICIENT",
      rootCause: "A definitive root cause despite insufficient evidence.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CONFLICTING + non-null rootCause", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidenceState: "CONFLICTING",
        rootCause: "One definitive root cause while evidence conflicts.",
      }).success,
    ).toBe(false);
  });

  it("rejects SUFFICIENT with an empty evidence array (P1-3 cardinality)", () => {
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it("rejects CONFLICTING with fewer than two distinct evidence locators", () => {
    // Same (sourceType, evidenceId) twice is one distinct locator, so the
    // conflict shape guarantee (>= 2 distinct grounded locators) fails.
    const single = causalSufficientReport.evidence[1];
    expect(
      ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidenceState: "CONFLICTING",
        rootCause: null,
        evidence: [single, { ...single, finding: "A second observation of the same call." }],
      }).success,
    ).toBe(false);
  });

  it("rejects a missing evidenceState key", () => {
    const { evidenceState: _evidenceState, ...withoutEvidenceState } = causalSufficientReport;
    expect(ResolutionReportSchema.safeParse(withoutEvidenceState).success).toBe(false);
  });

  it("rejects confidence outside the zero-to-one range", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      confidence: 1.5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported suggested action types", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [
        {
          type: "RESTART_PRODUCTION_SERVICE",
          payload: {
            service: "notification-service",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than three suggested actions", () => {
    const action = {
      type: "UPDATE_TICKET_STATUS",
      payload: {
        status: "IN_PROGRESS",
        reason: "Investigation is continuing.",
      },
      groundedBy: [{ evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" }],
    } as const;

    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [action, action, action, action],
    });

    expect(result.success).toBe(false);
  });

  // Issue #60 disposition ↔ action cardinality negatives (write path, F-negatives).
  it("rejects ACTIONABLE with an empty suggestedActions array (F1)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual({
        path: ["suggestedActions"],
        code: "custom",
        message: "ACTIONABLE requires at least one suggested action.",
      });
    }
  });

  it("rejects ADVISORY with non-empty suggested actions (F2)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...advisoryReport,
      suggestedActions: [groundedUpdateTicketAction],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual({
        path: ["suggestedActions"],
        code: "custom",
        message: "ADVISORY requires exactly zero suggested actions.",
      });
    }
  });

  it("rejects a new-write action with a missing groundedBy key (F3)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual(
        expect.objectContaining({ path: ["suggestedActions", 0, "groundedBy"] }),
      );
    }
  });

  it("rejects a new-write action with an empty groundedBy array (F3 — min(1))", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [{ ...groundedUpdateTicketAction, groundedBy: [] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual(
        expect.objectContaining({ path: ["suggestedActions", 0, "groundedBy"] }),
      );
    }
  });

  it("rejects a groundedBy with a duplicated locator (F4)", () => {
    const duplicate = { evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" } as const;
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [{ ...groundedUpdateTicketAction, groundedBy: [duplicate, duplicate] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual({
        path: ["suggestedActions", 0, "groundedBy"],
        code: "custom",
        message: "groundedBy must not repeat the same (sourceType, evidenceId) locator.",
      });
    }
  });

  it("rejects a groundedBy locator absent from report.evidence (F5)", () => {
    const result = ResolutionReportSchema.safeParse({
      ...causalSufficientReport,
      suggestedActions: [
        {
          ...groundedUpdateTicketAction,
          groundedBy: [{ evidenceId: "call-99", sourceType: "TOOL_EXECUTION" }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual({
        path: ["suggestedActions", 0, "groundedBy", 0],
        code: "custom",
        message: "suggestedActions[].groundedBy entries must each appear in report.evidence.",
      });
    }
  });

  // Issue #55 §2/§4 — the structured, per-claim evidence contract (narrow
  // scope): supports distinctness, 2.2a (negative), and 2.2b (positive,
  // write-only).
  describe("evidence.supports (Issue #55)", () => {
    it("accepts an entry declaring multiple distinct claims", () => {
      const result = ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: [
          { ...causalSufficientReport.evidence[0]!, supports: ["ROOT_CAUSE", "CUSTOMER_IMPACT"] },
          causalSufficientReport.evidence[1]!,
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects an entry with a duplicated claim value in supports", () => {
      const result = ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: [
          { ...causalSufficientReport.evidence[0]!, supports: ["ROOT_CAUSE", "ROOT_CAUSE"] },
          causalSufficientReport.evidence[1]!,
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(summarizeReportValidationIssues(result.error)).toContainEqual(
          expect.objectContaining({ path: ["evidence", 0, "supports"] }),
        );
      }
    });

    it("rejects more than three claims in supports", () => {
      const result = ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: [
          {
            ...causalSufficientReport.evidence[0]!,
            // Only three claims exist in the closed vocabulary, so a fourth
            // (repeated) entry is the only way to exceed max(3) alongside
            // the distinctness rule; assert max(3) alone with three real,
            // distinct values plus one duplicate padding entry is instead
            // covered by the duplicate test above. This asserts the bound
            // directly via a raw four-entry array bypassing the type.
            supports: ["ROOT_CAUSE", "CUSTOMER_IMPACT", "RECOMMENDED_RESOLUTION", "ROOT_CAUSE"] as unknown as (
              | "ROOT_CAUSE"
              | "CUSTOMER_IMPACT"
              | "RECOMMENDED_RESOLUTION"
            )[],
          },
          causalSufficientReport.evidence[1]!,
        ],
      });
      expect(result.success).toBe(false);
    });

    it("2.2a — rejects an entry declaring ROOT_CAUSE support when rootCause is null", () => {
      const result = ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        rootCause: null,
        evidence: [
          { ...causalSufficientReport.evidence[0]!, supports: ["ROOT_CAUSE"] },
          causalSufficientReport.evidence[1]!,
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(summarizeReportValidationIssues(result.error)).toContainEqual(
          expect.objectContaining({ path: ["evidence", 0, "supports"] }),
        );
      }
    });

    it("2.2a — enforced on the read (Stored) schema too", () => {
      const result = StoredResolutionReportSchema.safeParse({
        category: "SERVICE_DEGRADATION",
        summary: "Notification delivery is delayed for some customers.",
        customerImpact: "Some password-reset and account-verification emails are delayed.",
        recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
        confidence: 0.9,
        suggestedActions: [],
        rootCause: null,
        evidenceState: "INSUFFICIENT",
        evidence: [
          { evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION", finding: "x", supports: ["ROOT_CAUSE"] },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("2.2b — write requires at least one ROOT_CAUSE-supporting entry when rootCause is non-null", () => {
      const result = ResolutionReportSchema.safeParse({
        ...causalSufficientReport,
        evidence: causalSufficientReport.evidence.map((entry) => ({ ...entry, supports: [] })),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(summarizeReportValidationIssues(result.error)).toContainEqual(
          expect.objectContaining({ path: ["evidence"] }),
        );
      }
    });

    it("2.2b — REQUIRED: is NOT enforced on read — a legacy stored row with non-null rootCause and no supports key normalizes to [] and stays readable", () => {
      // The exact BLOCKER-fix scenario from the plan (§2.2/§2.3/acceptance
      // criterion 4): a pre-#55 stored row with a non-null rootCause and no
      // `supports` key at all on any evidence entry must remain readable.
      const legacyReportNoSupportsKey = {
        category: "SERVICE_DEGRADATION",
        summary: "Notification delivery is delayed for some customers.",
        rootCause: "The notification service is degraded after repeated upstream rate-limit responses.",
        customerImpact: "Some password-reset and account-verification emails are delayed.",
        recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
        confidence: 0.9,
        evidence: [
          {
            evidenceId: "tool-execution-001",
            sourceType: "TOOL_EXECUTION",
            finding: "The notification service currently reports DEGRADED.",
            // `supports` deliberately ABSENT — the exact pre-#55 shape.
          },
        ],
        suggestedActions: [],
      };
      const result = StoredResolutionReportSchema.safeParse(legacyReportNoSupportsKey);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.evidence.every((entry) => entry.supports.length === 0)).toBe(true);
      }
    });
  });
});

describe("StoredResolutionReportSchema (fail-closed legacy read compat)", () => {
  // A pre-#58 stored report had NO evidenceState and always carried a non-null
  // string rootCause with >= 1 evidence entry. It must keep reading exactly.
  const legacyReport = {
    category: "SERVICE_DEGRADATION",
    summary: "Notification delivery is delayed for some customers.",
    rootCause: "The notification service is degraded after repeated upstream rate-limit responses.",
    customerImpact: "Some password-reset and account-verification emails are delayed.",
    recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
    confidence: 0.9,
    evidence: [
      {
        evidenceId: "tool-execution-001",
        sourceType: "TOOL_EXECUTION",
        finding: "The notification service currently reports DEGRADED.",
      },
    ],
    suggestedActions: [],
  };

  it("accepts a valid pre-#58 legacy report (non-null rootCause + >= 1 evidence)", () => {
    expect(StoredResolutionReportSchema.safeParse(legacyReport).success).toBe(true);
  });

  it("rejects a corrupt legacy report with rootCause null (Stage-0 fail-closed)", () => {
    expect(
      StoredResolutionReportSchema.safeParse({ ...legacyReport, rootCause: null }).success,
    ).toBe(false);
  });

  it("rejects a corrupt legacy report with an empty evidence array (Stage-0 fail-closed)", () => {
    expect(
      StoredResolutionReportSchema.safeParse({ ...legacyReport, evidence: [] }).success,
    ).toBe(false);
  });

  it("applies the new-write #58 rules to stored reports that DO carry evidenceState", () => {
    // INSUFFICIENT + null rootCause + zero evidence round-trips on the read side.
    expect(
      StoredResolutionReportSchema.safeParse({
        ...legacyReport,
        category: "UNKNOWN",
        evidenceState: "INSUFFICIENT",
        rootCause: null,
        evidence: [],
      }).success,
    ).toBe(true);
    // SUFFICIENT + null rootCause + >= 1 evidence round-trips on the read side.
    expect(
      StoredResolutionReportSchema.safeParse({
        ...legacyReport,
        evidenceState: "SUFFICIENT",
        rootCause: null,
      }).success,
    ).toBe(true);
  });

  // G1 — #58-era stored row, disposition absent, action without groundedBy:
  // legacy read compatibility, missing grounding normalizes to [].
  it("normalizes a legacy action's missing groundedBy to [] and leaves disposition undefined (G1)", () => {
    const result = StoredResolutionReportSchema.safeParse(storedRowBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestedActions[0]?.groundedBy).toEqual([]);
      expect(result.data.recommendationDisposition).toBeUndefined();
    }
  });

  // G1b — legacy row with explicit non-empty corrupt grounding: duplicate/subset
  // checks run for every parsed action REGARDLESS of the #60 marker, so a legacy
  // row never escapes grounding validation.
  it("rejects a legacy row with a duplicated groundedBy locator (G1b)", () => {
    const duplicate = { evidenceId: "tool-execution-001", sourceType: "TOOL_EXECUTION" };
    const result = StoredResolutionReportSchema.safeParse({
      ...storedRowBase,
      suggestedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
          groundedBy: [duplicate, duplicate],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a legacy row with an out-of-report groundedBy locator (G1b)", () => {
    const result = StoredResolutionReportSchema.safeParse({
      ...storedRowBase,
      suggestedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
          groundedBy: [{ evidenceId: "call-99", sourceType: "TOOL_EXECUTION" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // G2 — #60-era stored row (disposition present, evidenceState present) with an
  // ungrounded action: structural [] normalization alone never lets it pass.
  it("rejects a modern row whose action grounding is missing (G2)", () => {
    const result = StoredResolutionReportSchema.safeParse({
      ...storedRowBase,
      recommendationDisposition: "ACTIONABLE",
      suggestedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(summarizeReportValidationIssues(result.error)).toContainEqual(
        expect.objectContaining({ path: ["suggestedActions", 0, "groundedBy"] }),
      );
    }
  });

  it("rejects a modern row with an explicitly empty groundedBy array (G2)", () => {
    const result = StoredResolutionReportSchema.safeParse({
      ...storedRowBase,
      recommendationDisposition: "ACTIONABLE",
      suggestedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          payload: { status: "IN_PROGRESS", reason: "Investigation is continuing." },
          groundedBy: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // G3 — impossible hybrid: recommendationDisposition present + evidenceState
  // absent cannot be produced by any valid #60 write path and is rejected
  // directly and unconditionally. The strong fixture is ADVISORY + [] with
  // otherwise legacy-valid rootCause/evidence, so the marker combination alone
  // is the ONLY reason for rejection.
  it("rejects the impossible hybrid — disposition present without evidenceState — unconditionally (G3)", () => {
    const strongHybrid = {
      category: "SERVICE_DEGRADATION",
      summary: "Notification delivery is delayed for some customers.",
      rootCause: "The notification service is degraded after repeated upstream rate-limit responses.",
      customerImpact: "Some password-reset and account-verification emails are delayed.",
      recommendedResolution: "Monitor the upstream provider and reduce retry pressure.",
      confidence: 0.9,
      evidence: [
        {
          evidenceId: "tool-execution-001",
          sourceType: "TOOL_EXECUTION",
          finding: "The notification service currently reports DEGRADED.",
        },
      ],
      suggestedActions: [],
      recommendationDisposition: "ADVISORY",
      // evidenceState deliberately ABSENT.
    };

    const result = StoredResolutionReportSchema.safeParse(strongHybrid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the impossible hybrid to be rejected");
    expect(summarizeReportValidationIssues(result.error)).toEqual([
      {
        path: ["evidenceState"],
        code: "custom",
        message:
          "recommendationDisposition present without evidenceState is impossible through any valid write path.",
      },
    ]);
  });
});
