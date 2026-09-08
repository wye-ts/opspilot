import { z } from "zod";

/**
 * A sanitized description of one Zod validation issue against
 * ResolutionReportSchema — safe to log or persist because it never carries
 * the value that failed, only where it failed and what kind of mismatch it
 * was. `expectedType`/`receivedType`/`origin` are derived type-name strings
 * (e.g. "string", "array"), never the offending value itself; `bound` is our
 * own schema's static min/max constant, never anything Claude returned.
 */
export interface ReportValidationIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly origin?: string;
  readonly expectedType?: string;
  readonly receivedType?: string;
  readonly bound?: number;
  readonly count?: number;
  /**
   * Populated ONLY for code "custom" — every `custom` issue on
   * ResolutionReportSchema/StoredResolutionReportSchema is added via
   * `ctx.addIssue({ code: "custom", message: "..." })` inside this package's
   * own `applyReportEvidenceInvariants`/`EvidenceReferenceSchema` superRefine
   * bodies (resolution-report.ts). Every one of those literals is a fixed,
   * hand-written string naming WHICH invariant failed — none of them
   * interpolate report data — so surfacing this field is safe under the same
   * never-log-raw-value constraint the rest of this module enforces (verified
   * by reading every addIssue call site as of Issue #80). Without it, a
   * `custom` failure collapsed to `{ path, code: "custom" }` with no way to
   * tell which of several structurally-distinct invariants at that path
   * tripped (e.g. "duplicate groundedBy locator" vs. "groundedBy locator not
   * present in evidence" are two different addIssue calls at the same kind of
   * path) — exactly the gap Issue #80 hit when a real LIVE failure could only
   * be explained by a live debug capture, not by the persisted log line.
   * Every other issue code keeps deriving only type names/bounds/counts,
   * never a message, because Zod's own default `.message` for those CAN echo
   * the offending value.
   */
  readonly message?: string;
}

function safeTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Reduces a ResolutionReportSchema ZodError to safe-to-log issue summaries.
 *
 * Deliberately narrow: every branch below reads only issue metadata (path,
 * code, the schema's own static bound, a derived typeof) and never an
 * issue's `.input` verbatim — that is the one place a raw value or an enum's
 * actual received string can leak. The sole exception is the "custom" code's
 * own `.message`: every `custom` issue on this schema is a fixed,
 * hand-written literal with no interpolated report data (see the `message`
 * field's doc comment above), so it is exempt from the raw-value ban this
 * function otherwise enforces for every other issue code.
 */
export function summarizeReportValidationIssues(
  error: z.ZodError,
): ReportValidationIssue[] {
  return error.issues.map((issue): ReportValidationIssue => {
    const path = issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    );

    switch (issue.code) {
      case "invalid_type":
        return {
          path,
          code: issue.code,
          expectedType: issue.expected,
          receivedType: safeTypeName(issue.input),
        };
      case "too_big":
        return {
          path,
          code: issue.code,
          origin: issue.origin,
          bound: Number(issue.maximum),
        };
      case "too_small":
        return {
          path,
          code: issue.code,
          origin: issue.origin,
          bound: Number(issue.minimum),
        };
      case "invalid_value":
        return {
          path,
          code: issue.code,
          expectedType: "enum",
          receivedType: safeTypeName(issue.input),
        };
      case "unrecognized_keys":
        return {
          path,
          code: issue.code,
          count: issue.keys.length,
        };
      case "custom":
        // Safe by construction — see the `message` field's doc comment
        // above: every `custom` issue on this schema carries a fixed literal
        // naming which invariant failed, never interpolated report data. The
        // `typeof` guard is defense in depth against a hypothetical future
        // Zod version defaulting `.message` to something other than a
        // string; it is always a string for every addIssue call site today.
        return typeof issue.message === "string"
          ? { path, code: issue.code, message: issue.message }
          : { path, code: issue.code };
      default:
        return { path, code: issue.code };
    }
  });
}
