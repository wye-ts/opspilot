import opspilotAgentRuntime from "@opspilot/agent-runtime";
import { ResolutionReportSchema } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import {
  SUBMIT_RESOLUTION_REPORT_TOOL,
  SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  toClaudeDiagnosticTool,
  toStrictInputSchema,
} from "./claude-tool-schemas";

const { getServiceStatusTool } = opspilotAgentRuntime;

const FORBIDDEN_KEYS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "oneOf",
  "unevaluatedProperties",
  "patternProperties",
  "propertyNames",
  "contains",
  "$schema",
  "$id",
];

function collectViolations(node: unknown, path: string, violations: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectViolations(entry, `${path}[${index}]`, violations));
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    if (key in record) violations.push(`${path}.${key}`);
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    violations.push(`${path}.additionalProperties (expected false, got ${JSON.stringify(record.additionalProperties)})`);
  }
  if (typeof record.minItems === "number" && record.minItems > 1) {
    violations.push(`${path}.minItems (expected 0 or 1, got ${record.minItems})`);
  }

  for (const [key, value] of Object.entries(record)) {
    collectViolations(value, `${path}.${key}`, violations);
  }
}

describe("toStrictInputSchema", () => {
  it("produces a ResolutionReportSchema-derived schema with no unsupported keywords anywhere", () => {
    const schema = toStrictInputSchema(ResolutionReportSchema);
    const violations: string[] = [];
    collectViolations(schema, "$", violations);
    expect(violations).toEqual([]);
  });

  it("preserves ResolutionReportSchema's enum/required/type structure", () => {
    const schema = toStrictInputSchema(ResolutionReportSchema) as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: {
        category: { enum: string[] };
        confidence: { type: string };
        evidence: { type: string; minItems: number; items: Record<string, unknown> };
      };
    };

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "category",
      "summary",
      "rootCause",
      "customerImpact",
      "recommendedResolution",
      "confidence",
      "evidence",
      "suggestedActions",
    ]);
    expect(schema.properties.category.enum).toEqual([
      "SERVICE_DEGRADATION",
      "RATE_LIMITING",
      "AUTHENTICATION",
      "CONFIGURATION",
      "DATA_QUALITY",
      "UNKNOWN",
    ]);
    expect(schema.properties.confidence.type).toBe("number");
    expect(schema.properties.evidence.type).toBe("array");
    expect(schema.properties.evidence.minItems).toBe(1);
  });

  it("converts the discriminated suggestedActions union from oneOf to anyOf without losing branches", () => {
    const schema = toStrictInputSchema(ResolutionReportSchema) as {
      properties: {
        suggestedActions: {
          items: { anyOf?: Array<{ properties: { type: { const: string } } }>; oneOf?: unknown };
        };
      };
    };

    const { anyOf, oneOf } = schema.properties.suggestedActions.items;
    expect(oneOf).toBeUndefined();
    expect(anyOf).toBeDefined();
    expect(anyOf?.map((branch) => branch.properties.type.const)).toEqual([
      "UPDATE_TICKET_STATUS",
      "CREATE_ESCALATION",
      "DRAFT_CUSTOMER_REPLY",
    ]);
  });

  it("produces a get_service_status input schema with no unsupported keywords", () => {
    const schema = toStrictInputSchema(getServiceStatusTool.inputSchema);
    const violations: string[] = [];
    collectViolations(schema, "$", violations);
    expect(violations).toEqual([]);
  });
});

describe("toClaudeDiagnosticTool", () => {
  it("sets strict: true and derives the input schema from the tool's Zod inputSchema", () => {
    const claudeTool = toClaudeDiagnosticTool({
      tool: getServiceStatusTool,
      description: "Look up the current operational status of a service.",
    });

    expect(claudeTool.name).toBe("get_service_status");
    expect(claudeTool.strict).toBe(true);
    expect(claudeTool.input_schema).toEqual(toStrictInputSchema(getServiceStatusTool.inputSchema));
  });
});

describe("SUBMIT_RESOLUTION_REPORT_TOOL", () => {
  it("is named submit_resolution_report, strict, and derived from ResolutionReportSchema", () => {
    expect(SUBMIT_RESOLUTION_REPORT_TOOL.name).toBe(SUBMIT_RESOLUTION_REPORT_TOOL_NAME);
    expect(SUBMIT_RESOLUTION_REPORT_TOOL.strict).toBe(true);
    expect(SUBMIT_RESOLUTION_REPORT_TOOL.input_schema).toEqual(
      toStrictInputSchema(ResolutionReportSchema),
    );
  });
});
