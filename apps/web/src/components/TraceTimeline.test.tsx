import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { InvestigationEventRecord } from "@opspilot/contracts";

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

// Issue #56 — richer Agent Activity sourced from the canonical investigation
// event stream, gated on the SAME reducer-validated `executionStageDerivation`
// the Progress Timeline already trusts (never the origin-only marker alone).
describe("TraceTimeline — canonical investigation events (Issue #56)", () => {
  it("renders the richer canonical vocabulary, including a type Agent Activity never showed before (TOOL_FAILED)", () => {
    const events: InvestigationEventRecord[] = [
      { runId: "run-1", sequence: 1, recordedAt: "2026-01-01T00:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: "run-1", sequence: 2, recordedAt: "2026-01-01T00:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      {
        runId: "run-1",
        sequence: 3,
        recordedAt: "2026-01-01T00:00:02.000Z",
        payload: { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
      },
      {
        runId: "run-1",
        sequence: 4,
        recordedAt: "2026-01-01T00:00:03.000Z",
        payload: { type: "TOOL_FAILED", toolCallId: "c1", toolName: "get_service_status", failureCode: "TOOL_EXECUTION_FAILED" },
      },
      {
        runId: "run-1",
        sequence: 5,
        recordedAt: "2026-01-01T00:00:04.000Z",
        payload: { type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "DIAGNOSTIC_EXECUTION" },
      },
    ];
    render(
      <TraceTimeline
        trace={[]}
        events={events}
        executionStageDerivation={{ kind: "canonical", stages: [] }}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Investigation created");
    expect(items[1]).toHaveTextContent("Agent started analyzing the ticket");
    expect(items[2]).toHaveTextContent("Checking service status");
    expect(items[4]).toHaveTextContent("Investigation failed");

    // The failed tool request must never show the "running" (in-flight) glyph.
    const steps = [...document.querySelectorAll(".trace-timeline-step")];
    expect(steps[2]!.className).not.toContain("running");
  });

  it("resolves a TOOL_REQUESTED whose matching TOOL_FAILED arrives later to a failed status, not running or completed", () => {
    const events: InvestigationEventRecord[] = [
      {
        runId: "run-1",
        sequence: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        payload: { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
      },
      {
        runId: "run-1",
        sequence: 2,
        recordedAt: "2026-01-01T00:00:01.000Z",
        payload: { type: "TOOL_FAILED", toolCallId: "c1", toolName: "get_service_status", failureCode: "TOOL_EXECUTION_FAILED" },
      },
    ];
    const { container } = render(
      <TraceTimeline trace={[]} events={events} executionStageDerivation={{ kind: "canonical", stages: [] }} />,
    );
    const steps = [...container.querySelectorAll(".trace-timeline-step")];
    expect(steps[0]).toHaveClass("trace-timeline-step--failed");
    expect(steps[0]!.textContent).toBe("✕");
  });

  it("gives REPORT_VALIDATED the same completed status as legacy REPORT_GENERATED (strict-superset regression guard)", () => {
    const events: InvestigationEventRecord[] = [
      { runId: "run-1", sequence: 1, recordedAt: "2026-01-01T00:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: "run-1", sequence: 2, recordedAt: "2026-01-01T00:00:01.000Z", payload: { type: "REPORT_VALIDATED" } },
    ];
    const { container } = render(
      <TraceTimeline trace={[]} events={events} executionStageDerivation={{ kind: "canonical", stages: [] }} />,
    );
    const steps = [...container.querySelectorAll(".trace-timeline-step")];
    expect(steps[1]).toHaveClass("trace-timeline-step--completed");
    expect(steps[1]!.textContent).toBe("✓");
  });

  it("renders a fail-closed unavailable message for a canonical-invalid stream, never falling back to legacy trace or crashing", () => {
    const trace: AgentTraceEvent[] = [{ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" }];
    const events: InvestigationEventRecord[] = [
      { runId: "run-1", sequence: 1, recordedAt: "2026-01-01T00:00:00.000Z", payload: { type: "RUN_CREATED" } },
    ];
    expect(() =>
      render(
        <TraceTimeline
          trace={trace}
          events={events}
          executionStageDerivation={{ kind: "canonical-invalid", lastGoodStages: null }}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByText(/Agent activity detail isn't available/)).toBeInTheDocument();
    // Never the legacy fallback for corrupt canonical data.
    expect(screen.queryByText("Checking service status")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("falls back to the legacy trace when executionStageDerivation is omitted (default prop, zero regression)", () => {
    const trace: AgentTraceEvent[] = [{ type: "REPORT_GENERATED" }];
    render(<TraceTimeline trace={trace} />);
    expect(screen.getByText("Resolution report generated")).toBeInTheDocument();
  });
});
