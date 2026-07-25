import type Anthropic from "@anthropic-ai/sdk";
import type { DiagnosticToolDefinition } from "@opspilot/agent-runtime";
import { ResolutionReportSchema } from "@opspilot/contracts";
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
    input_schema: toStrictInputSchema(tool.inputSchema),
  };
}

export const SUBMIT_RESOLUTION_REPORT_TOOL_NAME = "submit_resolution_report";

export const SUBMIT_RESOLUTION_REPORT_TOOL: Anthropic.Tool = {
  name: SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  description:
    "Submit the final resolution report for this ticket investigation once you have sufficient evidence. This ends the investigation — do not call any other tool in the same turn as this one. Every evidence entry with sourceType TOOL_EXECUTION must cite the exact tool_use id of the diagnostic tool call whose result it references.",
  strict: true,
  input_schema: toStrictInputSchema(ResolutionReportSchema),
};
