import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { InvestigationProgressTimeline } from "./InvestigationProgressTimeline";
import type { InvestigationProgressStageViewModel } from "../investigation-progress/investigation-progress-stages";
import type { ExecutionStageRowViewModel } from "../investigation-progress/execution-stage-rows";

/**
 * Direct component/view-model tests for `InvestigationProgressTimeline`,
 * closing the verification gap the Codex review identified: the plan's
 * required RUNNING forced-expansion, terminal collapse toggle, collapse
 * reset scoped to run/attempt/job identity, same-run collapse preservation,
 * the detail-unavailable note, and the four canonical child rows including
 * `omitted` were previously exercised only indirectly (via App-level tests
 * and helper/reducer unit tests), never through this component directly.
 *
 * Deliberately does NOT duplicate reducer transition tests (those live in
 * packages/contracts and execution-stage-derivation.test.ts) — every fixture
 * here is a hand-built view model, focused purely on rendering/lifecycle.
 */

function stage(overrides: Partial<InvestigationProgressStageViewModel> = {}): InvestigationProgressStageViewModel {
  return { key: "run", status: "active", label: "Agent investigation in progress…", ...overrides };
}

function childRow(key: string, status: string, label: string): ExecutionStageRowViewModel {
  return { key, status, label };
}

const FOUR_CHILDREN: readonly ExecutionStageRowViewModel[] = [
  childRow("INVESTIGATION_CREATED", "completed", "Investigation created"),
  childRow("AGENT_ANALYSIS", "completed", "Agent analysis"),
  childRow("DIAGNOSTIC_EXECUTION", "active", "Diagnostic execution"),
  childRow("REPORT_GENERATION", "pending", "Report generation"),
];

function childList(): HTMLElement {
  const list = document.querySelector(".investigation-progress-children-list");
  if (list === null) throw new Error("no canonical child list rendered");
  return list as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("InvestigationProgressTimeline — canonical child rows", () => {
  it("renders the run parent plus exactly four canonical child rows", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="12s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    const children = within(childList()).getAllByRole("listitem");
    expect(children).toHaveLength(4);
    expect(within(childList()).getByText("Investigation created")).toBeInTheDocument();
    expect(within(childList()).getByText("Agent analysis")).toBeInTheDocument();
    expect(within(childList()).getByText("Diagnostic execution")).toBeInTheDocument();
    expect(within(childList()).getByText("Report generation")).toBeInTheDocument();
  });

  it("an `omitted` diagnostic stage renders the 'Not applicable' badge", () => {
    const children = [
      ...FOUR_CHILDREN.slice(0, 2),
      childRow("DIAGNOSTIC_EXECUTION", "omitted", "Diagnostic execution"),
      childRow("REPORT_GENERATION", "pending", "Report generation"),
    ];
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children })]}
        elapsedLabel="12s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    const diagnosticRow = within(childList()).getByText("Diagnostic execution").closest("li");
    expect(diagnosticRow).not.toBeNull();
    expect(within(diagnosticRow as HTMLElement).getByText("Not applicable")).toBeInTheDocument();
  });
});

describe("InvestigationProgressTimeline — RUNNING forced expansion", () => {
  it("a RUNNING canonical run renders no collapse control and its children always show", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: FOUR_CHILDREN })]}
        elapsedLabel="5s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /Hide steps|Show steps/ })).toBeNull();
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
  });
});

describe("InvestigationProgressTimeline — terminal collapse toggle", () => {
  it("a terminal canonical run is expanded by default and a click collapses it", async () => {
    const user = userEvent.setup();
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "Hide steps" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Show steps" })).toHaveAttribute("aria-expanded", "false");

    // A second click restores it.
    await user.click(screen.getByRole("button", { name: "Show steps" }));
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
  });

  it("a collapsed terminal run stays collapsed across a rerender for the SAME run with a newly-allocated children array", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Hide steps" }));
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();

    // A poll-style update: SAME runExpansionKey, but a brand-new `stages`/
    // `children` array reference (not the same object) — the collapse
    // choice must not reset.
    const freshChildren: readonly ExecutionStageRowViewModel[] = FOUR_CHILDREN.map((c) => ({ ...c }));
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: freshChildren })]}
        elapsedLabel="31s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Show steps" })).toBeInTheDocument();
  });
});

describe("InvestigationProgressTimeline — collapse reset scoped to run identity", () => {
  it("a new ATTEMPT key resets to expanded", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Hide steps" }));
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();

    // A retry — same job, new run/attempt.
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: FOUR_CHILDREN })]}
        elapsedLabel="0s"
        runExpansionKey="job-1:run-2:2"
        executionDetailNote={null}
      />,
    );
    // RUNNING again, so no toggle at all — but the underlying collapse
    // state is also proven reset by the next terminal transition below.
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="10s"
        runExpansionKey="job-1:run-2:2"
        executionDetailNote={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Hide steps" })).toHaveAttribute("aria-expanded", "true");
  });

  it("a new JOB key resets to expanded", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Hide steps" }));
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();

    // A resume/navigation to a DIFFERENT job entirely.
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="45s"
        runExpansionKey="job-2:run-9:1"
        executionDetailNote={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Hide steps" })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
  });
});

describe("InvestigationProgressTimeline — canonical-invalid presentation", () => {
  it("canonical-invalid WITH last-good stages shows the frozen children and no note", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote={null}
      />,
    );
    expect(within(childList()).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByText(/Detailed step-by-step progress/)).toBeNull();
  });

  it("canonical-invalid with NO last-good shows the detail-unavailable note and no empty disclosure control", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed" })]} // no `children` at all
        elapsedLabel="30s"
        runExpansionKey="job-1:run-1:1"
        executionDetailNote="Detailed step-by-step progress isn't available for this run right now."
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    // No disclosure control either — nothing to disclose.
    expect(screen.queryByRole("button", { name: /Hide steps|Show steps/ })).toBeNull();
    expect(screen.getByText("Detailed step-by-step progress isn't available for this run right now.")).toBeInTheDocument();
  });
});
