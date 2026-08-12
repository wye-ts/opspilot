import { describe, expect, it } from "vitest";

import type { AgentTraceEvent } from "../api/types";
import { presentTraceProductLabel, traceTechnicalEntries } from "./trace-product-labels";

describe("presentTraceProductLabel", () => {
  it("maps a grounded tool request to product language, never the raw type", () => {
    const event: AgentTraceEvent = { type: "TOOL_REQUESTED", toolCallId: "job-1-call-1", toolName: "get_service_status" };
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Checking service status");
    expect(result.detail).toBeNull();
  });

  it("maps a grounded tool completion to product language", () => {
    const event: AgentTraceEvent = { type: "TOOL_COMPLETED", toolCallId: "job-1-call-1", toolName: "get_service_status" };
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Checked service status");
    expect(result.detail).toBeNull();
  });

  it("presents REPORT_GENERATED as the resolution report", () => {
    const event: AgentTraceEvent = { type: "REPORT_GENERATED" };
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Resolution report generated");
    expect(result.detail).toBeNull();
  });

  it("presents RETRIEVAL_COMPLETED with a grounded chunk count", () => {
    const event: AgentTraceEvent = { type: "RETRIEVAL_COMPLETED", chunks: Array.from({ length: 7 }, (_, i) => ({ chunkId: `c-${i}`, rank: i + 1, score: 0.9 - i * 0.05 })) };
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Runbook retrieval completed");
    expect(result.detail).toBe("7 chunks retrieved");
  });

  it("degrades an unknown tool to generic phrasing, keeping the raw name out of the primary copy", () => {
    const event: AgentTraceEvent = { type: "TOOL_REQUESTED", toolCallId: "job-1-call-1", toolName: "some_proprietary_tool" };
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Running a diagnostic tool");
    expect(result.label).not.toContain("some_proprietary_tool");
  });

  it("falls back safely for an unrecognized event type with only the type string, never a JSON dump", () => {
    const event = { type: "SOMETHING_NEW", payload: { secret: "should-not-appear" } } as unknown as AgentTraceEvent;
    const result = presentTraceProductLabel(event);
    expect(result.label).toBe("Agent activity recorded");
    expect(result.detail).toBe("SOMETHING_NEW");
    expect(result.detail).not.toContain("secret");
    expect(result.detail).not.toContain("should-not-appear");
  });
});

describe("traceTechnicalEntries", () => {
  it("collects one grounded identifier row per TOOL_REQUESTED, preserving order", () => {
    const trace: AgentTraceEvent[] = [
      { type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "c2", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
    ];
    expect(traceTechnicalEntries(trace)).toEqual([
      { toolName: "get_service_status", toolCallId: "c2" },
      { toolName: "get_service_status", toolCallId: "c1" },
    ]);
  });

  it("omits the call id when the event carries none", () => {
    // The validated type requires toolCallId; this casts to simulate a lenient
    // payload the defensive branch in traceTechnicalEntries guards against.
    const trace = [{ type: "TOOL_REQUESTED", toolName: "get_service_status" }] as unknown as AgentTraceEvent[];
    expect(traceTechnicalEntries(trace)).toEqual([{ toolName: "get_service_status" }]);
  });

  it("yields nothing for an empty trace", () => {
    expect(traceTechnicalEntries([])).toEqual([]);
  });
});
