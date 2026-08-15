import { z } from "zod";

import {
  EvidenceLocatorSchema,
  countDistinctEvidenceLocators,
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

// The report's evidence entry = the low-level locator primitive + finding
// prose. Built from the locator via `.extend()` (Issue #58, Revision 3 P1-1):
// the locator carries no superRefine, so `.extend()` is safe here, and it
// preserves `.strict()` — the emitted shape is byte-identical to today's
// EvidenceReferenceSchema (evidenceId/sourceType/finding, strict).
export const EvidenceReferenceSchema = EvidenceLocatorSchema.extend({
  finding: z.string().min(1).max(500),
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

const UpdateTicketStatusActionSchema = z
  .object({
    type: z.literal("UPDATE_TICKET_STATUS"),
    payload: z
      .object({
        status: z.enum([
          "OPEN",
          "IN_PROGRESS",
          "WAITING_ON_CUSTOMER",
          "RESOLVED",
        ]),
        reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const CreateEscalationActionSchema = z
  .object({
    type: z.literal("CREATE_ESCALATION"),
    payload: z
      .object({
        team: z.string().min(1).max(100),
        reason: z.string().min(1).max(500),
        priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
      })
      .strict(),
  })
  .strict();

const DraftCustomerReplyActionSchema = z
  .object({
    type: z.literal("DRAFT_CUSTOMER_REPLY"),
    payload: z
      .object({
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(4000),
      })
      .strict(),
  })
  .strict();

export const SuggestedActionSchema = z.discriminatedUnion("type", [
  UpdateTicketStatusActionSchema,
  CreateEscalationActionSchema,
  DraftCustomerReplyActionSchema,
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
  suggestedActions: z.array(SuggestedActionSchema).max(3),
  evidenceState: EvidenceStateSchema,
};

// The ONLY invariants this issue enforces on the report — deliberately not
// coupled to category (P1-1), deliberately not claiming to have verified a
// conflict, only that it stays visible (P2-2), and deliberately ONE-WAY on
// rootCause: non-sufficient evidence may never carry a definitive root cause,
// but sufficient evidence is never forced to invent one (P1-1).
function applyReportEvidenceInvariants(
  report: {
    // Optional-with-undefined under exactOptionalPropertyTypes: the shared
    // shape is used by both schemas, so the StoredResolutionReportSchema arg
    // carries `evidenceState: EvidenceState | undefined` explicitly.
    evidenceState?: EvidenceState | undefined;
    rootCause: string | null;
    evidence: readonly EvidenceReference[];
  },
  ctx: z.RefinementCtx,
): void {
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
}

// The strict new-write report contract: every report a producer submits must
// carry an explicit evidenceState, and `rootCause` is a nullable-but-required
// key (present-as-null, never omitted).
export const ResolutionReportSchema = z
  .object(RESOLUTION_REPORT_SHAPE)
  .strict()
  .superRefine(applyReportEvidenceInvariants);

// Read-compat ONLY (used solely by fromReportRead): evidenceState optional
// for pre-#58 rows. Backward-compatible WITHOUT being more permissive than the
// old schema: when evidenceState is absent the fail-closed legacy branch above
// enforces the exact pre-#58 contract (non-null string rootCause, >= 1
// evidence entry), so the following are the complete read semantics:
//
//   LEGACY       evidenceState === undefined
//                -> rootCause MUST be a non-empty string
//                -> evidence.length MUST be >= 1
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
export const StoredResolutionReportSchema = z
  .object({ ...RESOLUTION_REPORT_SHAPE, evidenceState: EvidenceStateSchema.optional() })
  .strict()
  .superRefine(applyReportEvidenceInvariants);

export type IncidentCategory = z.infer<typeof IncidentCategorySchema>;
export type ResolutionReport = z.infer<typeof ResolutionReportSchema>;
export type StoredResolutionReport = z.infer<typeof StoredResolutionReportSchema>;
