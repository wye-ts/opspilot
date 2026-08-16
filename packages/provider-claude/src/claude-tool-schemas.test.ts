import { getServiceStatusTool } from "@opspilot/agent-runtime";
import { ResolutionReportSchema } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import {
  SUBMIT_RESOLUTION_REPORT_TOOL,
  SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  toClaudeDiagnosticTool,
  toStrictInputSchema,
} from "./claude-tool-schemas";


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
        evidence: { type: string; items: Record<string, unknown> };
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
      "evidenceState",
      "recommendationDisposition",
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
    // Issue #58 (P1-3): no minItems — a truthful zero-evidence INSUFFICIENT
    // report is valid. Cardinality is conditional on evidenceState, which the
    // JSON-Schema subset cannot express, so the prose in REPORT_FIELD_BOUNDS
    // carries those rules (asserted in claude-llm-provider.test.ts).
    expect("minItems" in schema.properties.evidence).toBe(false);
  });

  // Separate from the full `required` equality above, and deliberately
  // narrower: the production incident (LIVE run 179848c0…) was a report
  // submitted WITHOUT suggestedActions, so the two facts that make that a
  // model-compliance failure rather than a schema-conversion bug — the field
  // is exposed, and it is marked required — get an assertion that names them
  // and cannot be diluted by an unrelated edit to the field list.
  it("exposes suggestedActions to Claude as a required array property", () => {
    const schema = toStrictInputSchema(ResolutionReportSchema) as {
      required: string[];
      properties: { suggestedActions: { type: string } };
    };

    expect(schema.properties.suggestedActions).toBeDefined();
    expect(schema.properties.suggestedActions.type).toBe("array");
    expect(schema.required).toContain("suggestedActions");
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

  // Issue #60 §4b/§7: the write action's groundedBy is structurally required
  // (1..10) with NO `.default([])`, so every anyOf branch carries it in both
  // properties and required. minItems: 1 survives the strict subset because
  // the sanitizer only strips minItems > 1 — Anthropic's strict-tool JSON
  // Schema subset accepts minItems 0 and 1 (verified against the official
  // structured-outputs docs; maxItems is always stripped).
  it("exposes groundedBy on every suggested-action branch — in properties AND required, with minItems: 1", () => {
    const schema = toStrictInputSchema(ResolutionReportSchema) as {
      properties: {
        suggestedActions: {
          items: {
            anyOf?: Array<{
              required: string[];
              properties: {
                type: { const: string };
                groundedBy?: { type?: string; minItems?: number };
              };
            }>;
          };
        };
      };
    };

    const branches = schema.properties.suggestedActions.items.anyOf;
    expect(branches).toBeDefined();
    expect(branches?.length).toBe(3);
    for (const branch of branches ?? []) {
      expect(branch.properties.groundedBy?.type).toBe("array");
      expect(branch.properties.groundedBy?.minItems).toBe(1);
      expect(branch.required).toContain("groundedBy");
    }
  });

  it("produces a get_service_status input schema with no unsupported keywords", () => {
    const schema = toStrictInputSchema(getServiceStatusTool.inputSchema);
    const violations: string[] = [];
    collectViolations(schema, "$", violations);
    expect(violations).toEqual([]);
  });
});

describe("toClaudeDiagnosticTool", () => {
  // Issue #58 Checkpoint B (§5): the diagnostic wire shape is the nested
  // { evidenceAssessment, toolInput } wrapper, derived from the REAL Zod
  // schemas. These are the §5 "Generated-schema tests" — asserted on the
  // actual emitted strict schema, never a handwritten approximation.
  it("sets strict: true and wraps the tool input with the evidence-assessment wrapper", () => {
    const claudeTool = toClaudeDiagnosticTool({
      tool: getServiceStatusTool,
      description: "Look up the current operational status of a service.",
    });

    expect(claudeTool.name).toBe("get_service_status");
    expect(claudeTool.strict).toBe(true);

    const schema = claudeTool.input_schema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: {
        evidenceAssessment: {
          type: string;
          properties: {
            evidenceState: { type: string; enum: string[] };
            continuationReason: { type: string; enum: string[] };
            supportedBy: {
              type: string;
              items: { properties: { sourceType: { type: string; enum: string[] } } };
            };
          };
        };
        toolInput: Record<string, unknown>;
      };
    };

    // Top-level object is strict, with both wrapper keys required.
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["evidenceAssessment", "toolInput"]);

    // The three closed vocabularies survive into the generated schema:
    // evidence state, continuation reason, and locator sourceType.
    expect(schema.properties.evidenceAssessment.properties.evidenceState.type).toBe("string");
    expect(schema.properties.evidenceAssessment.properties.evidenceState.enum).toEqual([
      "SUFFICIENT",
      "INSUFFICIENT",
      "CONFLICTING",
    ]);
    expect(schema.properties.evidenceAssessment.properties.continuationReason.enum).toEqual([
      "NO_EVIDENCE_YET",
      "STATUS_UNRESOLVED",
      "SCOPE_NOT_COVERED",
      "CONFLICT_UNRESOLVED",
    ]);
    expect(
      schema.properties.evidenceAssessment.properties.supportedBy.items.properties.sourceType.enum,
    ).toEqual(["RAG_CHUNK", "TOOL_EXECUTION"]);

    // toolInput is exactly the bare tool's schema — the wrapper never mutates it.
    expect(schema.properties.toolInput).toEqual(toStrictInputSchema(getServiceStatusTool.inputSchema));

    // No unsupported Anthropic strict-schema keywords anywhere in the wrapper.
    const violations: string[] = [];
    collectViolations(claudeTool.input_schema, "$", violations);
    expect(violations).toEqual([]);
  });

  // The checkpoint is explicit: superRefine cross-field semantics are NOT
  // represented by JSON Schema; orchestrator validation remains authoritative.
  // So the emitted diagnostic schema must NOT structurally encode invariants
  // like "SUFFICIENT cannot accompany a diagnostic request" (which would be a
  // duplicate, drift-prone check) — only the base enum/required shape above.
  it("does not encode superRefine invariants into the generated diagnostic schema", () => {
    const claudeTool = toClaudeDiagnosticTool({
      tool: getServiceStatusTool,
      description: "Look up the current operational status of a service.",
    });

    // The SUFFICIENT-rejection and CONFLICTING-needs-two-locators rules are
    // superRefine-only; a minItems/dependency-style structural encoding would
    // be a second, logically-unreachable copy of the check the orchestrator
    // already runs authoritatively.
    expect(JSON.stringify(claudeTool.input_schema)).not.toContain("minItems");
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

  // Issue #60 §5a: the tool description teaches the disposition rule and the
  // grounding cardinality, because the strict JSON Schema subset cannot express
  // the cross-field disposition↔action and groundedBy⊆evidence semantics.
  it("teaches the disposition and grounding rules in the tool description", () => {
    const description = SUBMIT_RESOLUTION_REPORT_TOOL.description;
    expect(description).toContain(
      "recommendationDisposition: ACTIONABLE when the recommended resolution is a concrete next step a human can take",
    );
    expect(description).toContain("or ADVISORY when it is informational or monitoring-only");
    expect(description).toContain("1 to 10 groundedBy evidence locators");
    expect(description).toContain("copied exactly from an entry already present in the same report's `evidence` array");
    expect(description).toContain("Never invent a locator for groundedBy");
  });

  // Issue #60 §4a/§4b: recommendationDisposition is structurally required at the
  // top level (write-required) — asserted on the ACTUAL emitted strict schema.
  it("exposes recommendationDisposition to Claude as a required top-level enum", () => {
    const schema = SUBMIT_RESOLUTION_REPORT_TOOL.input_schema as {
      required: string[];
      properties: { recommendationDisposition?: { type: string; enum: string[] } };
    };

    expect(schema.properties.recommendationDisposition).toBeDefined();
    expect(schema.properties.recommendationDisposition?.type).toBe("string");
    expect(schema.properties.recommendationDisposition?.enum).toEqual(["ACTIONABLE", "ADVISORY"]);
    expect(schema.required).toContain("recommendationDisposition");
  });

  // Issue #58 closure (Fix 1): asserted on the ACTUAL emitted strict report
  // tool schema, never a hand-written approximation. These are the three
  // facts the model-facing contract needs: rootCause stays required, it
  // accepts string OR null, and evidenceState is required.
  it("encodes rootCause as a required string-or-null field and evidenceState as a required enum in the generated strict schema", () => {
    const schema = SUBMIT_RESOLUTION_REPORT_TOOL.input_schema as {
      required: string[];
      properties: {
        rootCause: { anyOf: Array<{ type: string }> };
        evidenceState: { type: string; enum: string[] };
      };
    };

    // rootCause stays in required[] — the model must always supply the key;
    // a null is an explicit declaration, never an omission.
    expect(schema.required).toContain("rootCause");

    // rootCause accepts string OR null — the nullable union is encoded by the
    // generated schema itself (anyOf string/null).
    expect(schema.properties.rootCause.anyOf).toContainEqual({ type: "string" });
    expect(schema.properties.rootCause.anyOf).toContainEqual({ type: "null" });

    // evidenceState stays in required[] and is exactly the three-valued enum.
    expect(schema.required).toContain("evidenceState");
    expect(schema.properties.evidenceState.type).toBe("string");
    expect(schema.properties.evidenceState.enum).toEqual(["SUFFICIENT", "INSUFFICIENT", "CONFLICTING"]);
  });
});
