// Strict structural validation of Codex's own `--output-schema`-constrained
// response. Codex's schema conformance is a first layer only — Harness
// independently re-validates with this TypeScript type guard rather than
// trusting the provider's own enforcement, and additionally checks that
// `verdict` isn't self-contradictory with `findings` (a schema-valid response
// can still claim READY_FOR_OWNER_REVIEW while listing findings, or
// NEEDS_FIXES with none).

import type { CodexFinding, CodexReviewPayload, CodexSeverity } from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

const SEVERITIES = new Set<CodexSeverity>(["BLOCKER", "MAJOR", "MINOR"]);

const FINDING_KEYS = [
  "severity",
  "title",
  "location",
  "reproduction",
  "whyItMatters",
  "smallestFix",
  "missingTest",
] as const;

function isCodexFinding(value: unknown): value is CodexFinding {
  if (!isObject(value) || !hasOnlyKeys(value, FINDING_KEYS)) return false;
  if (typeof value.severity !== "string" || !SEVERITIES.has(value.severity as CodexSeverity)) return false;
  return (
    typeof value.title === "string" &&
    typeof value.location === "string" &&
    typeof value.reproduction === "string" &&
    typeof value.whyItMatters === "string" &&
    typeof value.smallestFix === "string" &&
    typeof value.missingTest === "string"
  );
}

/** Strict validator for Codex's parsed `--output-last-message` JSON: unknown fields rejected, every finding independently validated. */
export function isCodexReviewPayload(value: unknown): value is CodexReviewPayload {
  if (!isObject(value) || !hasOnlyKeys(value, ["verdict", "findings"])) return false;
  if (value.verdict !== "READY_FOR_OWNER_REVIEW" && value.verdict !== "NEEDS_FIXES") return false;
  if (!Array.isArray(value.findings)) return false;
  return value.findings.every(isCodexFinding);
}

/** A schema-valid payload can still be self-contradictory: READY_FOR_OWNER_REVIEW with findings listed, or NEEDS_FIXES with none. */
export function verdictConsistentWithFindings(payload: CodexReviewPayload): boolean {
  return payload.verdict === "NEEDS_FIXES" ? payload.findings.length > 0 : payload.findings.length === 0;
}
