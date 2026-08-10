import type { InvestigationEventRecordPayload } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import { formatInvestigationEventLabel } from "./investigation-event-labels";

// One minimal fixture per member of the 13-type record-payload union, typed
// against the union itself so the fixture set cannot drift from it. A tuple
// array (not a record) so indexed access stays defined under
// `noUncheckedIndexedAccess`.
const fixtureEntries: readonly (readonly [string, InvestigationEventRecordPayload])[] = [
  ["RUN_CREATED", { type: "RUN_CREATED" }],
  ["AGENT_STARTED", { type: "AGENT_STARTED" }],
  ["RETRIEVAL_COMPLETED", { type: "RETRIEVAL_COMPLETED", chunks: [] }],
  ["TOOL_REQUESTED", { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "check_status" }],
  ["TOOL_COMPLETED", { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "check_status" }],
  [
    "TOOL_FAILED",
    {
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "check_status",
      failureCode: "TOOL_EXECUTION_FAILED",
    },
  ],
  ["REPORT_GENERATION_STARTED", { type: "REPORT_GENERATION_STARTED" }],
  ["REPORT_SUBMITTED", { type: "REPORT_SUBMITTED" }],
  ["REPORT_VALIDATED", { type: "REPORT_VALIDATED" }],
  ["REPORT_VALIDATION_FAILED", { type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" }],
  ["RUN_COMPLETED", { type: "RUN_COMPLETED" }],
  ["RUN_FAILED", { type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }],
  ["REPORT_GENERATED", { type: "REPORT_GENERATED" }],
];

function fixtureFor(type: string): InvestigationEventRecordPayload {
  const entry = fixtureEntries.find(([t]) => t === type);
  if (entry === undefined) throw new Error(`no fixture for ${type}`);
  return entry[1];
}

describe("formatInvestigationEventLabel", () => {
  it("returns a non-empty label for every canonical type", () => {
    for (const [type, payload] of fixtureEntries) {
      if (type === "REPORT_GENERATED") continue;
      expect(formatInvestigationEventLabel(payload).length, `expected a label for ${type}`).toBeGreaterThan(0);
    }
  });

  it("returns 'Report generated' for the legacy REPORT_GENERATED type", () => {
    expect(formatInvestigationEventLabel(fixtureFor("REPORT_GENERATED"))).toBe("Report generated");
  });

  it("expands a known tool name to its friendly display name", () => {
    const label = formatInvestigationEventLabel({
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "get_service_status",
    });
    expect(label).toBe("Tool requested: Get service status");
  });

  it("degrades an unknown tool identifier to the generic label without interpolating it", () => {
    const label = formatInvestigationEventLabel({
      type: "TOOL_REQUESTED",
      toolCallId: "call-1",
      toolName: "some_mystery_tool_2026",
    });
    expect(label).toBe("Tool requested");
    expect(label).not.toContain("some_mystery_tool_2026");
  });

  it("never embeds toolCallId or other raw payload fields in a label", () => {
    for (const [, payload] of fixtureEntries) {
      const label = formatInvestigationEventLabel(payload);
      expect(label).not.toContain("call-1");
      expect(label).not.toContain("check_status");
      expect(label).not.toContain("REPORT_");
    }
  });

  it("renders RUN_FAILED as 'Run failed' — no failure code interpolation", () => {
    expect(formatInvestigationEventLabel(fixtureFor("RUN_FAILED"))).toBe("Run failed");
  });

  it("renders TOOL_FAILED as the generic or allowlisted label — never a failure code", () => {
    expect(formatInvestigationEventLabel(fixtureFor("TOOL_FAILED"))).toBe("Tool failed");
    const known = formatInvestigationEventLabel({
      type: "TOOL_FAILED",
      toolCallId: "call-1",
      toolName: "get_service_status",
      failureCode: "TOOL_EXECUTION_FAILED",
    });
    expect(known).toBe("Tool failed: Get service status");
    expect(known).not.toContain("TOOL_EXECUTION_FAILED");
  });
});
