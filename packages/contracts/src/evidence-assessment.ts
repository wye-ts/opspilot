import { z } from "zod";

import {
  EvidenceLocatorSchema,
  countDistinctEvidenceLocators,
} from "./evidence";

// The state of the evidence BEFORE the diagnostic a request accompanies —
// Issue #58's model-declared judgment, recorded as structured, closed-vocabulary
// data rather than free-form prose (P2-3).
export const EvidenceStateSchema = z.enum([
  "SUFFICIENT",
  "INSUFFICIENT",
  "CONFLICTING",
]);

export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

// Why ONE more diagnostic is justified. Closed vocabulary.
export const ContinuationReasonSchema = z.enum([
  "NO_EVIDENCE_YET", // nothing has been gathered at all — no tool result, no RAG chunk
  "STATUS_UNRESOLVED", // gathered evidence (tool and/or contextual) did not establish the needed fact
  "SCOPE_NOT_COVERED", // gathered evidence concerns a different subject than the ticket
  "CONFLICT_UNRESOLVED", // sources disagree; a further check may adjudicate
]);

export type ContinuationReason = z.infer<typeof ContinuationReasonSchema>;

export const EvidenceAssessmentSchema = z
  .object({
    // The state of the evidence BEFORE the diagnostic this assessment accompanies.
    evidenceState: EvidenceStateSchema,
    continuationReason: ContinuationReasonSchema,
    // No .finding text: a hypothesis or rationale can never ride on this array
    // (P2-3) — only closed-vocabulary state plus real evidence locators.
    supportedBy: z.array(EvidenceLocatorSchema).max(10),
  })
  .strict()
  .readonly()
  .superRefine((v, ctx) => {
    // A request for MORE evidence cannot rest on a claim that evidence is already sufficient.
    if (v.evidenceState === "SUFFICIENT") {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceState"],
        message: "SUFFICIENT evidence cannot accompany a request for another diagnostic.",
      });
    }
    // Distinctness is deterministic, by (sourceType, evidenceId) — not raw length (P1-3).
    const distinct = countDistinctEvidenceLocators(v.supportedBy);
    if (distinct !== v.supportedBy.length) {
      ctx.addIssue({
        code: "custom",
        path: ["supportedBy"],
        message: "supportedBy must not repeat the same (sourceType, evidenceId) locator.",
      });
    }
    if (v.evidenceState === "CONFLICTING" && distinct < 2) {
      // HQ P2-1 keeps this, drops only the CONFLICTING => CONFLICT_UNRESOLVED
      // implication (a model may have conflicting evidence and continue for a
      // different reason). Conflict stays visible by >= 2 distinct locators.
      ctx.addIssue({
        code: "custom",
        path: ["supportedBy"],
        message: "CONFLICTING requires at least two distinct grounded evidence locators.",
      });
    }
    if (v.continuationReason === "CONFLICT_UNRESOLVED" && v.evidenceState !== "CONFLICTING") {
      // The one direction the harness can decide safely (P2-1): the reason
      // names a conflict, so the state must be CONFLICTING.
      ctx.addIssue({
        code: "custom",
        path: ["continuationReason"],
        message: "CONFLICT_UNRESOLVED may only accompany evidenceState CONFLICTING.",
      });
    }
    if (v.continuationReason === "NO_EVIDENCE_YET" && v.supportedBy.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["continuationReason"],
        message: "NO_EVIDENCE_YET must cite no evidence locators.",
      });
    }
  });

export type EvidenceAssessment = z.infer<typeof EvidenceAssessmentSchema>;

// The three derived stop reasons and their semantics (Issue #58 §9.2, P2-3):
//   - BOUND_EXHAUSTED is a genuine harness-owned fact from forced finalization
//     (REPORT_GENERATION_STARTED present), independent of model judgment.
//   - SUFFICIENT_EVIDENCE means the model explicitly declared evidenceState
//     SUFFICIENT — not that the harness independently proved sufficiency.
//   - NO_JUSTIFIED_DIAGNOSTIC is the model-declared / protocol-implied stop
//     judgment: a voluntary non-sufficient report means "no further allowed
//     diagnostic is justified". It is not a proof that no useful diagnostic
//     existed. Whether the judgment is good is #59's evaluation job.
export type InvestigationStopReason =
  | "SUFFICIENT_EVIDENCE"
  | "NO_JUSTIFIED_DIAGNOSTIC"
  | "BOUND_EXHAUSTED";

export function deriveInvestigationStopReason(args: {
  // undefined for pre-#58 stored reports.
  evidenceState: EvidenceState | undefined;
  // Ledger fact: REPORT_GENERATION_STARTED present.
  forcedFinalization: boolean;
}): InvestigationStopReason | null {
  if (args.forcedFinalization) return "BOUND_EXHAUSTED";
  if (args.evidenceState === "SUFFICIENT") return "SUFFICIENT_EVIDENCE";
  if (args.evidenceState === "INSUFFICIENT" || args.evidenceState === "CONFLICTING") {
    return "NO_JUSTIFIED_DIAGNOSTIC";
  }
  return null; // undefined (legacy run) and no forced finalization
}
