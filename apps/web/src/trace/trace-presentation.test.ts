import { describe, expect, it } from "vitest";

import type { AgentTraceEvent } from "../api/types";
import { presentTraceEvent } from "./trace-presentation";

describe("presentTraceEvent", () => {
  it("presents TOOL_REQUESTED", () => {
    const event: AgentTraceEvent = { type: "TOOL_REQUESTED", toolCallId: "job-1-call-1", toolName: "get_service_status" };
    const result = presentTraceEvent(event);
    expect(result.label).toBe("Tool requested");
    expect(result.detail).toBe("get_service_status");
    expect(result.toolCallId).toBe("job-1-call-1");
  });

  it("presents TOOL_COMPLETED", () => {
    const event: AgentTraceEvent = { type: "TOOL_COMPLETED", toolCallId: "job-1-call-1", toolName: "get_service_status" };
    const result = presentTraceEvent(event);
    expect(result.label).toBe("Tool completed");
    expect(result.detail).toBe("get_service_status");
    expect(result.toolCallId).toBe("job-1-call-1");
  });

  it("presents REPORT_GENERATED", () => {
    const event: AgentTraceEvent = { type: "REPORT_GENERATED" };
    const result = presentTraceEvent(event);
    expect(result.label).toBe("Report generated");
    expect(result.detail).toBe("The agent submitted its resolution report.");
  });

  it("presents RETRIEVAL_COMPLETED with 7 chunks as 5 rows plus a +2 more count", () => {
    const chunks = Array.from({ length: 7 }, (_, i) => ({ chunkId: `chunk-${i}`, rank: i + 1, score: 0.9 - i * 0.05 }));
    const event: AgentTraceEvent = { type: "RETRIEVAL_COMPLETED", chunks };
    const result = presentTraceEvent(event);
    expect(result.label).toBe("Runbook retrieval completed");
    expect(result.detail).toBe("7 chunks retrieved");
    expect(result.chunkRows).toHaveLength(5);
    expect(result.moreChunksCount).toBe(2);
    expect(result.chunkRows?.[0]).toEqual({ rank: 1, chunkId: "chunk-0", score: "0.900" });
  });

  it("presents an unrecognized event type with only the type string, never a JSON dump", () => {
    const event = { type: "SOMETHING_NEW", payload: { secret: "should-not-appear" } } as unknown as AgentTraceEvent;
    const result = presentTraceEvent(event);
    expect(result.label).toBe("Unknown event");
    expect(result.detail).toBe("SOMETHING_NEW");
    expect(result.detail).not.toContain("secret");
    expect(result.detail).not.toContain("should-not-appear");
  });
});
