import { z } from "zod";

import {
  EvidenceLocatorSchema,
  countDistinctEvidenceLocators,
  type EvidenceLocator,
} from "./evidence";
import {
  EvidenceStateSchema,
  type EvidenceState,
} from "./evidence-assessment";

export const IncidentCategorySchema = z.enum([
  "SERVICE_DEGRADATION",
  "RATE_LIMITING",
  "AUTHENTICATION",
  "CONFIGURATION",
  "DATA_QUALITY",
  "UNKNOWN",
]);

// The model's closed declaration of whether the recommended resolution is a
// concrete next step (ACTIONABLE) or informational/monitoring-only (ADVISORY).
// Two-member enum rather than a boolean: matches the codebase's closed-
// vocabulary style and leaves room for future dispositions (Issue #60 §4a).
// Responsibility split: the MODEL declares the disposition; the HARNESS
// validates it against suggestedActions cardinality and never semantically
// parses recommendedResolution prose.
export const RecommendationDispositionSchema = z.enum(["ACTIONABLE", "ADVISORY"]);

export type RecommendationDisposition = z.infer<typeof RecommendationDispositionSchema>;

// Issue #55 (narrow scope): the closed set of report claims an evidence
// entry may declare it backs. `summary` is deliberately NOT a linkable claim
// (docs/reviews/24-issue-55-structured-evidence-plan.md §2.1) — it restates
// the other fields rather than standing as an independent conclusion.
export const EvidenceClaimSchema = z.enum([
  "ROOT_CAUSE",
  "CUSTOMER_IMPACT",
  "RECOMMENDED_RESOLUTION",
]);

export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

// The report's evidence entry = the low-level locator primitive + finding
// prose + the per-claim links it declares. Built from the locator via
// `.extend()` (Issue #58, Revision 3 P1-1): the locator carries no
// superRefine, so `.extend()` is safe here, and it preserves `.strict()`.
//
// `supports` carries no `.default([])` here — this is the WRITE shape (Issue
// #55 §2.1), mirroring the #60 groundedBy write/read split: a producer must
// always supply the key explicitly (an empty array is a valid, honest
// declaration — see the "supports: [] is valid on write" decision below),
// and the read-side StoredResolutionReportSchema below overrides this field
// with `.default([])` for legacy stored rows that never carried it.
//
// Decision (HQ recommendation, owner-confirmed): `supports: []` is valid on
// write. `evidence` itself carries no `.min(1)` requirement for a truthful
// zero-evidence report (#58 P1-3); forcing every entry to name a claim would
// impose a stricter rule on this one field than the rest of the contract
// uses anywhere else, and would penalize honestly-contextual evidence that
// doesn't back one specific claim.
export const EvidenceReferenceSchema = EvidenceLocatorSchema.extend({
  finding: z.string().min(1).max(500),
  supports: z.array(EvidenceClaimSchema).max(3),
}).superRefine((entry, ctx) => {
  // `supports` is a SET, not a list: duplicate claim values within one
  // entry are rejected (e.g. ["ROOT_CAUSE", "ROOT_CAUSE"]). Expressed as an
  // addIssue-based superRefine addition, matching the style already used for
  // groundedBy duplicate detection elsewhere in this file — not a chained
  // `.refine()` on the array in isolation.
  if (new Set(entry.supports).size !== entry.supports.length) {
    ctx.addIssue({
      code: "custom",
      path: ["supports"],
      message: "supports must not repeat the same claim value.",
    });
  }
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

// The READ-side evidence entry: `supports` normalizes a missing legacy key
// to `[]` (Issue #55 §2.3), the same normalization pattern already used for
// `groundedBy` on suggested actions (#60). A pre-this-change stored row has
// no `supports` key at all and must keep reading as "no claim links
// recorded" rather than failing to read. The duplicate-value superRefine
// still applies — it has no legacy-compatibility hazard (an absent key
// normalizes to `[]`, which is trivially non-duplicate).
const StoredEvidenceReferenceSchema = EvidenceLocatorSchema.extend({
  finding: z.string().min(1).max(500),
  supports: z.array(EvidenceClaimSchema).max(3).default([]),
}).superRefine((entry, ctx) => {
  if (new Set(entry.supports).size !== entry.supports.length) {
    ctx.addIssue({
      code: "custom",
      path: ["supports"],
      message: "supports must not repeat the same claim value.",
    });
  }
});

// Issue #60 §4b: the three payload shapes are single-sourced here and shared by
// the structurally-distinct write and read action schemas below — one source of
// truth, never hand-copied between the two variants.
const UpdateTicketStatusPayloadSchema = z
  .object({
    status: z.enum([
      "OPEN",
      "IN_PROGRESS",
      "WAITING_ON_CUSTOMER",
      "RESOLVED",
    ]),
    reason: z.string().min(1).max(500),
  })
  .strict();

const CreateEscalationPayloadSchema = z
  .object({
    team: z.string().min(1).max(100),
    reason: z.string().min(1).max(500),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  })
  .strict();

const DraftCustomerReplyPayloadSchema = z
  .object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
  })
  .strict();

// WRITE actions (provider/new-write contract): groundedBy is STRUCTURALLY
// required with 1..10 locators — no `.default([])` on the write variant, so the
// provider's generated strict tool schema carries groundedBy in each branch's
// `required` array rather than relying on a default making the input key
// optional (Issue #60 §4b).
const UpdateTicketStatusWriteActionSchema = z
  .object({
    type: z.literal("UPDATE_TICKET_STATUS"),
    payload: UpdateTicketStatusPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).min(1).max(10),
  })
  .strict();

const CreateEscalationWriteActionSchema = z
  .object({
    type: z.literal("CREATE_ESCALATION"),
    payload: CreateEscalationPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).min(1).max(10),
  })
  .strict();

const DraftCustomerReplyWriteActionSchema = z
  .object({
    type: z.literal("DRAFT_CUSTOMER_REPLY"),
    payload: DraftCustomerReplyPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).min(1).max(10),
  })
  .strict();

// STORED/READ actions (web/API read consumers): a missing legacy groundedBy is
// accepted and structurally normalized to `[]` (0..10 after normalization).
// Distinctness/subset enforcement is NOT done here — those are report-level
// superRefine checks that run for every parsed action regardless of the #60
// marker (§4c). The `.default([])` structural normalization alone is never the
// end of the read check: a modern row carrying recommendationDisposition still
// fails the report-level non-empty-grounding rule when groundedBy ends up empty.
const UpdateTicketStatusReadActionSchema = z
  .object({
    type: z.literal("UPDATE_TICKET_STATUS"),
    payload: UpdateTicketStatusPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).max(10).default([]),
  })
  .strict();

const CreateEscalationReadActionSchema = z
  .object({
    type: z.literal("CREATE_ESCALATION"),
    payload: CreateEscalationPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).max(10).default([]),
  })
  .strict();

const DraftCustomerReplyReadActionSchema = z
  .object({
    type: z.literal("DRAFT_CUSTOMER_REPLY"),
    payload: DraftCustomerReplyPayloadSchema,
    groundedBy: z.array(EvidenceLocatorSchema).max(10).default([]),
  })
  .strict();

// The NEW provider/new-write action contract: groundedBy structurally required,
// 1..10. Exported so a producer that wants the write action contract standalone
// can import it explicitly (Issue #60 §4e).
export const SuggestedActionWriteSchema = z.discriminatedUnion("type", [
  UpdateTicketStatusWriteActionSchema,
  CreateEscalationWriteActionSchema,
  DraftCustomerReplyWriteActionSchema,
]);

export type SuggestedActionWrite = z.infer<typeof SuggestedActionWriteSchema>;

// The STORED/READ normalized action contract — this is what the long-standing
// public name keeps meaning. `groundedBy` is normalized (missing → []) and
// never ambiguous with the write contract above (Issue #60 §4e).
export const SuggestedActionSchema = z.discriminatedUnion("type", [
  UpdateTicketStatusReadActionSchema,
  CreateEscalationReadActionSchema,
  DraftCustomerReplyReadActionSchema,
]);

export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

// Shared report shape, used by both the strict new-write schema and the
// read-compat stored schema — a single source of truth so the two cannot
// drift (required by the `.extend()`-throws finding, §2). Deliberately NOT
// coupled to category (P1-1): a model may know the category (e.g.
// SERVICE_DEGRADATION) while still lacking enough evidence to name a specific
// root cause — category and root-cause certainty are separate claims, so
// nothing here forces category to UNKNOWN. And a SUFFICIENT conclusion need
// not be causal: a grounded "no fault observed / healthy" result is SUFFICIENT
// with rootCause null (P1-1 — the converse is deliberately not enforced).
const RESOLUTION_REPORT_SHAPE = {
  category: IncidentCategorySchema, // UNCHANGED — no link to evidenceState (P1-1)
  summary: z.string().min(1).max(1000),
  // NULLABLE. The one-way anti-fabrication fix (P1-1): non-sufficient evidence
  // may never carry a definitive root cause, but sufficient evidence is never
  // forced to invent one.
  rootCause: z.string().min(1).max(1500).nullable(),
  customerImpact: z.string().min(1).max(1000),
  recommendedResolution: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  // No .min(1): a truthful zero-evidence INSUFFICIENT report must be able to
  // exist (P1-3). Cardinality is conditional on evidenceState below.
  evidence: z.array(EvidenceReferenceSchema).max(10),
  // WRITE element (structurally-required groundedBy). The read schema below
  // overrides this with the legacy-normalizing read element via
  // spread-and-override, matching the #58 evidenceState pattern (Issue #60 §4c).
  suggestedActions: z.array(SuggestedActionWriteSchema).max(3),
  evidenceState: EvidenceStateSchema,
  // WRITE-required / read-optional, exactly the #58 evidenceState pattern:
  // when present it is the #60-era marker that switches read revalidation from
  // legacy compatibility to modern fail-closed (Issue #60 §4a).
  recommendationDisposition: RecommendationDispositionSchema,
};

// Issue #60 §4c: the report invariants, expressed as a factory taking whether
// the schema is the write contract. The #58 evidence invariants (category
// independence P1-1, conflict-visibility P2-2, ONE-WAY rootCause P1-1, and the
// conditional evidence cardinality P1-3) are preserved UNCHANGED below — #60
// only adds the disposition/cardinality and grounding rules in front of them.
//
// Final refinement ordering (Revision 4):
//   - disposition ↔ action cardinality: marker present ONLY;
//   - non-empty groundedBy requirement: when requireGroundedActions OR the
//     #60 marker is present;
//   - duplicate groundedBy check: ALWAYS for every parsed action;
//   - groundedBy ⊆ report.evidence check: ALWAYS for every parsed action.
function applyReportEvidenceInvariants({
  requireGroundedActions,
  requirePositiveRootCauseSupport,
}: {
  requireGroundedActions: boolean;
  // Issue #55 §2.2b — WRITE-ONLY, never applied unconditionally. `true` only
  // for ResolutionReportSchema (the write contract). Every pre-#58 legacy
  // stored report with a non-null rootCause has evidence entries with no
  // `supports` key at all (normalized to `supports: []` on read by
  // StoredEvidenceReferenceSchema) — an unconditional 2.2b would reject every
  // one of those historical rows as failing StoredResolutionReportSchema,
  // making them unreadable through the API/UI. 2.2a (the negative rule) has
  // no equivalent hazard and stays enforced unconditionally below.
  requirePositiveRootCauseSupport: boolean;
}) {
  return (
    report: {
      // Optional-with-undefined under exactOptionalPropertyTypes: the shared
      // shape is used by both schemas, so the StoredResolutionReportSchema arg
      // carries `evidenceState: EvidenceState | undefined` explicitly, and the
      // read schema carries `recommendationDisposition` optionally too.
      evidenceState?: EvidenceState | undefined;
      recommendationDisposition?: RecommendationDisposition | undefined;
      rootCause: string | null;
      evidence: readonly EvidenceReference[];
      // Structural: both write and read actions expose a groundedBy array.
      suggestedActions: readonly { groundedBy: readonly EvidenceLocator[] }[];
    },
    ctx: z.RefinementCtx,
  ): void => {
    // A row is #60-era whenever the model-declared disposition marker is
    // present — always on write; on read only for rows that carry it. The
    // marker is what flips missing grounding from "legacy, may normalize to
    // []" into "corruption, reject".
    const isModern60 = report.recommendationDisposition !== undefined;
    const requiresModernActionGrounding = requireGroundedActions || isModern60;

    // 1. IMPOSSIBLE HYBRID (G3) — rejected directly and unconditionally.
    //    recommendationDisposition present + evidenceState absent cannot be
    //    produced by any valid #60 write path (#60 sits after #58, so every
    //    #60-era write carries evidenceState). Merely skipping the pre-#58
    //    early-return is not enough: an ADVISORY + [] hybrid with otherwise
    //    legacy-valid rootCause/evidence would satisfy both the #60 disposition
    //    rule and the old #58 legacy evidence rule and accidentally pass.
    if (isModern60 && report.evidenceState === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceState"],
        message: "recommendationDisposition present without evidenceState is impossible through any valid write path.",
      });
    }

    // 2. Disposition ↔ action cardinality (F1/F2) — marker present ONLY.
    if (isModern60) {
      if (report.recommendationDisposition === "ACTIONABLE" && report.suggestedActions.length < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestedActions"],
          message: "ACTIONABLE requires at least one suggested action.",
        });
      }
      if (report.recommendationDisposition === "ADVISORY" && report.suggestedActions.length !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestedActions"],
          message: "ADVISORY requires exactly zero suggested actions.",
        });
      }
    }

    // 2.5. Evidence claim-linkage invariants (Issue #55 §2.2). Applied to
    // EVERY entry regardless of legacy/#60-marker status — a `supports`
    // value is either honestly empty or names a claim that actually holds in
    // this report; there is no legacy variant of these two rules to gate.
    //
    // 2.2a — negative direction: no evidence entry may declare ROOT_CAUSE
    // support when the report's own rootCause is null. Citing support for a
    // claim that does not exist is exactly the kind of fabricated-grounding
    // case #58/#60 already treat as fail-closed. Enforced on BOTH read and
    // write — it has no legacy-compatibility hazard (a null rootCause is
    // representable identically on legacy and modern rows).
    for (const [index, entry] of report.evidence.entries()) {
      if (report.rootCause === null && entry.supports.includes("ROOT_CAUSE")) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence", index, "supports"],
          message: "An evidence entry may not declare ROOT_CAUSE support when rootCause is null.",
        });
      }
    }

    // 2.2b — positive direction, WRITE-ONLY (see requirePositiveRootCauseSupport's
    // doc comment above the factory): when rootCause is non-null, at least
    // one distinct evidence entry must declare ROOT_CAUSE support. Without
    // this, a report could assert a definitive root cause while every
    // evidence entry carries supports: [] — schema-valid, but the new
    // per-claim contract would be silently optional and the UI could
    // reproduce today's unlinked-root-cause behavior exactly.
    if (
      requirePositiveRootCauseSupport &&
      report.rootCause !== null &&
      !report.evidence.some((entry) => entry.supports.includes("ROOT_CAUSE"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A non-null rootCause requires at least one evidence entry to declare ROOT_CAUSE support.",
      });
    }

    // 3. Grounding validation — iterates every parsed action REGARDLESS of the
    //    #60 marker. Only the non-empty requirement is gated on
    //    requiresModernActionGrounding; duplicate and subset checks run for
    //    every action, so a legacy row (marker absent) with explicit non-empty
    //    corrupt grounding still fails closed (G1b). A read action missing
    //    groundedBy is already `[]` here (structural normalization), which is
    //    trivially distinct and trivially a subset — but a modern row carrying
    //    the marker still fails the non-empty check (G2).
    const reportLocatorSet = new Set(report.evidence.map((e) => `${e.sourceType}:${e.evidenceId}`));
    for (const [index, action] of report.suggestedActions.entries()) {
      if (requiresModernActionGrounding && countDistinctEvidenceLocators(action.groundedBy) < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestedActions", index, "groundedBy"],
          message: "Each suggested action must cite at least one evidence locator present in report.evidence.",
        });
      }
      if (countDistinctEvidenceLocators(action.groundedBy) !== action.groundedBy.length) {
        ctx.addIssue({
          code: "custom",
          path: ["suggestedActions", index, "groundedBy"],
          message: "groundedBy must not repeat the same (sourceType, evidenceId) locator.",
        });
      }
      for (const [gIndex, locator] of action.groundedBy.entries()) {
        if (!reportLocatorSet.has(`${locator.sourceType}:${locator.evidenceId}`)) {
          ctx.addIssue({
            code: "custom",
            path: ["suggestedActions", index, "groundedBy", gIndex],
            message: "suggestedActions[].groundedBy entries must each appear in report.evidence.",
          });
        }
      }
    }

    // 4. #58 legacy/new evidence invariants. Because the impossible hybrid was
    //    already rejected above, evidenceState absent here means BOTH markers
    //    absent — true pre-#58/pre-#60 legacy.
    //
    // LEGACY (fail-closed read compat, Checkpoint A Stage-0 micro-correction):
    // evidenceState absent => this is a pre-#58 stored report and must satisfy
    // the OLD report contract exactly — rootCause non-empty string AND
    // evidence.length >= 1. We do NOT simply skip all checks when the field is
    // absent: skipping would silently widen the historical read contract and
    // admit corrupt legacy rows (rootCause null, evidence []) that the
    // pre-#58 mapper/schema would have rejected.
    if (report.evidenceState === undefined) {
      if (report.rootCause === null) {
        ctx.addIssue({
          code: "custom",
          path: ["rootCause"],
          message: "Legacy report without evidenceState must carry a non-null string rootCause.",
        });
      }
      if (report.evidence.length < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "Legacy report without evidenceState must carry at least one evidence entry.",
        });
      }
      return;
    }

    // One-way invariant (P1-1). The converse is deliberately NOT enforced:
    // SUFFICIENT with rootCause: null is valid for a non-causal conclusion.
    if (report.evidenceState !== "SUFFICIENT" && report.rootCause !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["rootCause"],
        message: "Non-sufficient evidence cannot carry a definitive rootCause; submit null.",
      });
    }
    // Conditional cardinality (P1-3): sufficiency rests on at least one real,
    // grounded observation; a conflict keeps both sides visible; an insufficient
    // report may cite 0..10 entries — including none, when nothing was gathered.
    const distinct = countDistinctEvidenceLocators(report.evidence);
    if (report.evidenceState === "SUFFICIENT" && distinct < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "SUFFICIENT evidence requires at least one distinct grounded evidence entry.",
      });
    }
    if (report.evidenceState === "CONFLICTING" && distinct < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "CONFLICTING requires at least two distinct grounded evidence entries.",
      });
    }
  };
}

// The strict new-write report contract: every report a producer submits must
// carry an explicit evidenceState, `rootCause` is a nullable-but-required
// key (present-as-null, never omitted), and — since #60 — a
// recommendationDisposition plus structurally-grounded suggested actions.
// This is the authoritative new-write contract; the provider derives its
// strict tool schema from it (Issue #60 §4e).
export const ResolutionReportSchema = z
  .object(RESOLUTION_REPORT_SHAPE)
  .strict()
  .superRefine(
    applyReportEvidenceInvariants({ requireGroundedActions: true, requirePositiveRootCauseSupport: true }),
  );

// Read-compat ONLY (used solely by fromReportRead): evidenceState optional
// for pre-#58 rows and recommendationDisposition optional for pre-#60 rows.
// Backward-compatible WITHOUT being more permissive than the old schema: when
// evidenceState is absent the fail-closed legacy branch above enforces the
// exact pre-#58 contract (non-null string rootCause, >= 1 evidence entry), and
// the #60 marker flips read revalidation to modern fail-closed (G1/G1b/G2/G3).
// The complete read semantics:
//
//   LEGACY       evidenceState undefined AND disposition undefined
//                -> rootCause MUST be a non-empty string
//                -> evidence.length MUST be >= 1
//                -> missing action groundedBy normalizes to []
//                   (explicit corrupt non-empty grounding still rejects, G1b)
//   IMPOSSIBLE   disposition present AND evidenceState undefined
//                -> rejected unconditionally (G3) — cannot be a valid #60 write
//   NEW          disposition present AND evidenceState present
//                -> disposition ↔ cardinality + non-empty grounding fail closed
//   NEW          evidenceState === SUFFICIENT
//                -> rootCause string OR null
//                -> >= 1 distinct evidence locator
//   NEW          evidenceState === INSUFFICIENT
//                -> rootCause MUST be null
//                -> 0..10 evidence entries
//   NEW          evidenceState === CONFLICTING
//                -> rootCause MUST be null
//                -> >= 2 distinct evidence locators
//
// Required tests:
//   legacy report: non-null rootCause + >= 1 evidence   -> accepted
//   legacy report: rootCause null                        -> rejected
//   legacy report: evidence []                           -> rejected
//   legacy action missing groundedBy                     -> normalized to [] (G1)
//   legacy explicit corrupt grounding                    -> rejected (G1b)
//   modern ungrounded action                             -> rejected (G2)
//   disposition present + evidenceState absent           -> rejected (G3)
export const StoredResolutionReportSchema = z
  .object({
    ...RESOLUTION_REPORT_SHAPE,
    evidenceState: EvidenceStateSchema.optional(),
    recommendationDisposition: RecommendationDispositionSchema.optional(),
    // Issue #55 §2.3: overrides the write-shape `evidence` field with the
    // legacy-normalizing read element (StoredEvidenceReferenceSchema), the
    // same spread-and-override pattern already used for suggestedActions
    // just below — a missing `supports` key normalizes to `[]` rather than
    // failing to read.
    evidence: z.array(StoredEvidenceReferenceSchema).max(10),
    suggestedActions: z.array(SuggestedActionSchema).max(3),
  })
  .strict()
  .superRefine(
    applyReportEvidenceInvariants({ requireGroundedActions: false, requirePositiveRootCauseSupport: false }),
  );

export type IncidentCategory = z.infer<typeof IncidentCategorySchema>;
export type ResolutionReport = z.infer<typeof ResolutionReportSchema>;
export type StoredResolutionReport = z.infer<typeof StoredResolutionReportSchema>;
