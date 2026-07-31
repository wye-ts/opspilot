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
 * issue's `.input` or `.message` verbatim — those are the two places a raw
 * value or an enum's actual received string can leak. See the "safety
 * constraints" this fix was scoped under (never log raw provider content).
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
      default:
        return { path, code: issue.code };
    }
  });
}
