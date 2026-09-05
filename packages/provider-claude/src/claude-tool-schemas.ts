import type Anthropic from "@anthropic-ai/sdk";
import type { DiagnosticToolDefinition } from "@opspilot/agent-runtime";
import { EvidenceAssessmentSchema, ResolutionReportSchema } from "@opspilot/contracts";
import { z } from "zod";

export interface DiagnosticToolWithDescription {
  readonly tool: DiagnosticToolDefinition;
  readonly description: string;
}

// Anthropic's strict-tool-use JSON Schema subset (see "JSON Schema
// limitations" in Anthropic's structured-outputs docs) rejects these
// constraints outright. z.toJSONSchema() emits them from .min()/.max()/etc,
// so they must be stripped before use as a strict input_schema — Zod itself
// remains the actual runtime validator downstream, so removing them here
// only affects what Claude's grammar sees, never what OpsPilot enforces.
const UNSUPPORTED_KEYS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "unevaluatedProperties",
  "patternProperties",
  "propertyNames",
  "contains",
  "$schema",
  "$id",
]);

const SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripUnsupported);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "format" && typeof value === "string" && !SUPPORTED_STRING_FORMATS.has(value)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;

    if (key === "oneOf") {
      // z.toJSONSchema() renders a discriminated union as oneOf, which
      // Claude's strict subset doesn't support (only anyOf). The branches
      // here are mutually exclusive on a `const` discriminant, so anyOf is
      // behaviorally equivalent for every input that could actually occur.
      output.anyOf = stripUnsupported(value);
      continue;
    }

    output[key] = stripUnsupported(value);
  }

  // Required on every object level, not just the top level, per Claude's
  // strict-tool-use JSON Schema subset.
  if (output.type === "object") {
    output.additionalProperties = false;
  }

  return output;
}

export function toStrictInputSchema(schema: z.ZodTypeAny): Anthropic.Tool.InputSchema {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  return stripUnsupported(jsonSchema) as Anthropic.Tool.InputSchema;
}

export function toClaudeDiagnosticTool({
  tool,
  description,
}: DiagnosticToolWithDescription): Anthropic.Tool {
  return {
    name: tool.name,
    description,
    strict: true,
    // Issue #58 Checkpoint B (§5): every diagnostic tool call now carries the
    // model-declared evidence assessment alongside the tool input. The wrapper
    // is STRUCTURAL — derived from the real Zod schemas (EvidenceAssessmentSchema
    // for the assessment, the tool's own inputSchema for toolInput) rather than
    // a handwritten duplicate. The provider adapter only splits it
    // (claude-response-normalization.ts); authoritative validation of the
    // assessment happens once, in the orchestrator. superRefine cross-field
    // invariants are deliberately NOT represented in this JSON Schema —
    // orchestrator validation remains the authority.
    input_schema: toStrictInputSchema(
      z
        .object({
          evidenceAssessment: EvidenceAssessmentSchema,
          toolInput: tool.inputSchema,
        })
        .strict(),
    ),
  };
}

export const SUBMIT_RESOLUTION_REPORT_TOOL_NAME = "submit_resolution_report";

export const SUBMIT_RESOLUTION_REPORT_TOOL: Anthropic.Tool = {
  name: SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  description:
    "Submit the final resolution report for this ticket investigation (Issue #58). Set evidenceState to your model-declared judgment of the gathered evidence: SUFFICIENT when you have enough grounded evidence for a conclusion, INSUFFICIENT when you are ending without enough, or CONFLICTING when the evidence disagrees. rootCause must be null whenever evidenceState is not SUFFICIENT. When evidenceState is SUFFICIENT, rootCause may be null for a grounded non-causal conclusion (for example, no fault observed) — do not invent a cause merely because evidenceState is SUFFICIENT. This ends the investigation — do not call any other tool in the same turn as this one. Every evidence entry with sourceType TOOL_EXECUTION must cite the exact tool_use id of the diagnostic tool call whose result it references. Declare recommendationDisposition: ACTIONABLE when the recommended resolution is a concrete next step a human can take (and provide at least one matching suggested action), or ADVISORY when it is informational or monitoring-only (and provide no suggested actions). Each suggested action must contain 1 to 10 groundedBy evidence locators, each `{ evidenceId, sourceType }` copied exactly from an entry already present in the same report's `evidence` array. Never invent a locator for groundedBy. For each evidence entry, declare `supports`: the closed set of report claims it backs (`ROOT_CAUSE`, `CUSTOMER_IMPACT`, `RECOMMENDED_RESOLUTION`), or an empty array if the entry is general context that does not directly back a specific claim. `supports` values must be distinct. Never declare `ROOT_CAUSE` support when `rootCause` is null. When `rootCause` is non-null, at least one evidence entry must declare `ROOT_CAUSE` support.",
  strict: true,
  input_schema: toStrictInputSchema(ResolutionReportSchema),
};
