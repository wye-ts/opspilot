import { z } from "zod";

// Low-level evidence primitives only (Issue #58, Revision 3 P1-1). This file
// is dependency-low-level: it imports nothing from @opspilot/contracts, and
// nothing in the repo imports it in reverse. Both evidence-assessment.ts and
// resolution-report.ts depend on this file, which keeps the contracts module
// graph acyclic at runtime (evidence.ts ← zod only; evidence-assessment.ts →
// evidence.ts; resolution-report.ts → evidence.ts + evidence-assessment.ts).
// Because the locator primitive carries no superRefine, resolution-report.ts
// can safely build EvidenceReferenceSchema from it via `.extend()`.

export const EvidenceSourceTypeSchema = z.enum(["RAG_CHUNK", "TOOL_EXECUTION"]);

export const EvidenceLocatorSchema = z
  .object({
    evidenceId: z.string().min(1).max(128),
    sourceType: EvidenceSourceTypeSchema,
  })
  .strict();

export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

// Shared by the assessment (evidence-assessment.ts) and the report
// (resolution-report.ts): counts DISTINCT (sourceType, evidenceId) pairs.
// Written against a structural Pick so it also accepts EvidenceReference[]
// (the report's own evidence array) unchanged — one distinctness rule, two
// callers, matching P1-3's "define distinctness deterministically" instruction
// exactly once. Never claims semantic contradiction — only counts what the
// harness can actually determine (P2-2).
export function countDistinctEvidenceLocators(
  locators: readonly Pick<EvidenceLocator, "evidenceId" | "sourceType">[],
): number {
  return new Set(locators.map((l) => `${l.sourceType}:${l.evidenceId}`)).size;
}
