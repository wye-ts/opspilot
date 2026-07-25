import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentTraceEvent } from "../api/types";
import { TraceTimeline } from "./TraceTimeline";

describe("TraceTimeline", () => {
  it("renders items in server array order, not re-sorted", () => {
    const trace: AgentTraceEvent[] = [
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ];
    render(<TraceTimeline trace={trace} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Tool requested");
    expect(items[1]).toHaveTextContent("Tool completed");
    expect(items[2]).toHaveTextContent("Report generated");
  });

  it("labels steps with 1-based ordinals", () => {
    const trace: AgentTraceEvent[] = [{ type: "REPORT_GENERATED" }, { type: "REPORT_GENERATED" }];
    render(<TraceTimeline trace={trace} />);

    expect(screen.getByText(/Step 1:/)).toBeInTheDocument();
    expect(screen.getByText(/Step 2:/)).toBeInTheDocument();
  });

  it("renders an empty-state message and no list for an empty trace", () => {
    render(<TraceTimeline trace={[]} />);
    expect(screen.getByText(/No trace events were recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders an unknown event type without throwing", () => {
    const trace = [{ type: "SOMETHING_NEW" }] as unknown as AgentTraceEvent[];
    expect(() => render(<TraceTimeline trace={trace} />)).not.toThrow();
    expect(screen.getByText("SOMETHING_NEW")).toBeInTheDocument();
  });
});
