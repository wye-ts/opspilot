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

    // Product language (§14), not raw event types — grounded tool semantics
    // only.
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Checking service status");
    expect(items[1]).toHaveTextContent("Checked service status");
    expect(items[2]).toHaveTextContent("Resolution report generated");
  });

  it("uses compact checklist glyphs, not numbered 1/2/3 circles (§11)", () => {
    const trace: AgentTraceEvent[] = [
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ];
    const { container } = render(<TraceTimeline trace={trace} />);

    // Glyphs are presentational (aria-hidden), so assert on the span text. A
    // matched request→completion pair AND the report all resolve to green
    // checks — never numeric ordinals.
    const steps = [...container.querySelectorAll(".trace-timeline-step")];
    expect(steps.map((step) => step.textContent)).toEqual(["✓", "✓", "✓"]);
    expect(container.textContent).not.toMatch(/\b[0-9]\b/);
  });

  it("shows a small running dot for an in-flight tool request with no completion yet", () => {
    const trace: AgentTraceEvent[] = [
      { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
    ];
    const { container } = render(<TraceTimeline trace={trace} />);

    const steps = [...container.querySelectorAll(".trace-timeline-step")];
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step).toHaveClass("trace-timeline-step--running");
    expect(step.textContent).toBe("●");
  });

  it("renders an empty-state message and no list for an empty trace", () => {
    render(<TraceTimeline trace={[]} />);
    expect(screen.getByText(/No trace events were recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders an unknown event type without throwing", () => {
    const trace = [{ type: "SOMETHING_NEW" }] as unknown as AgentTraceEvent[];
    expect(() => render(<TraceTimeline trace={trace} />)).not.toThrow();
    // Unknown types fall back to generic product phrasing, with the raw type
    // only as supporting detail — never primary copy.
    expect(screen.getByText("Agent activity recorded")).toBeInTheDocument();
    expect(screen.getByText("SOMETHING_NEW")).toBeInTheDocument();
  });

  it("discloses grounded tool identifiers under Technical details, never the raw type", () => {
    const trace: AgentTraceEvent[] = [
      { type: "TOOL_REQUESTED", toolCallId: "call_01", toolName: "get_service_status" },
    ];
    render(<TraceTimeline trace={trace} />);

    expect(screen.queryByText("TOOL_REQUESTED")).toBeNull();
    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText("get_service_status")).toBeInTheDocument();
    expect(screen.getByText("call_01")).toBeInTheDocument();
  });
});
