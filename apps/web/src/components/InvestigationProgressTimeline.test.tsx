import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InvestigationProgressTimeline } from "./InvestigationProgressTimeline";
import type {
  InvestigationProgressStageStatus,
  InvestigationProgressStageViewModel,
} from "../investigation-progress/investigation-progress-stages";
import type { ExecutionStageRowViewModel } from "../investigation-progress/execution-stage-rows";

/**
 * Direct component/view-model tests for `InvestigationProgressTimeline`,
 * closing the verification gap the Codex review identified: the plan's
 * required RUNNING forced expansion, the four canonical child rows including
 * `omitted`, always-visible authoritative stages (the collapse toggle was
 * removed in the Issue #41 visual polish — the four execution stages are
 * NEVER collapsed), the detail-unavailable note, and nested event rendering
 * were previously exercised only indirectly (via App-level tests and
 * helper/reducer unit tests), never through this component directly.
 *
 * Deliberately does NOT duplicate reducer transition tests (those live in
 * packages/contracts and execution-stage-derivation.test.ts) — every fixture
 * here is a hand-built view model, focused purely on rendering/lifecycle.
 */

function stage(overrides: Partial<InvestigationProgressStageViewModel> = {}): InvestigationProgressStageViewModel {
  return { key: "run", status: "active", label: "Agent investigation in progress…", ...overrides };
}

function childRow(key: string, status: InvestigationProgressStageStatus, label: string): ExecutionStageRowViewModel {
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
        executionDetailNote={null}
        overallStatus={null}
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
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    const diagnosticRow = within(childList()).getByText("Diagnostic execution").closest("li");
    expect(diagnosticRow).not.toBeNull();
    expect(within(diagnosticRow as HTMLElement).getByText("Not applicable")).toBeInTheDocument();
  });
});

describe("InvestigationProgressTimeline — authoritative stages never collapse", () => {
  it("each authoritative stage label appears exactly once — no duplicated stage summaries (§18.5)", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    // The stepper is a single vertical list; each canonical stage renders as
    // exactly one row. A duplicated summary would surface as a second match.
    for (const label of ["Investigation created", "Agent analysis", "Diagnostic execution", "Report generation"]) {
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    // One top-level list, one nested canonical list — never a side-by-side
    // duplicate layout (§18.6).
    expect(document.querySelectorAll(".investigation-progress-list")).toHaveLength(1);
    expect(document.querySelectorAll(".investigation-progress-children-list")).toHaveLength(1);
  });

  it("renders no collapse control and the four canonical rows always show, RUNNING or terminal", () => {
    const { rerender } = render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: FOUR_CHILDREN })]}
        elapsedLabel="5s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    // No disclosure control exists at all — running or terminal.
    expect(screen.queryByRole("button", { name: /Hide steps|Show steps/ })).toBeNull();
    expect(within(childList()).getAllByRole("listitem")).toHaveLength(4);

    // The terminal transition must not collapse the four authoritative stages.
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /Hide steps|Show steps/ })).toBeNull();
    expect(within(childList()).getAllByRole("listitem")).toHaveLength(4);
  });

  it("a rerender with a newly-allocated children array still renders the four rows", () => {
    const freshChildren: readonly ExecutionStageRowViewModel[] = FOUR_CHILDREN.map((c) => ({ ...c }));
    const { rerender } = render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    rerender(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: freshChildren })]}
        elapsedLabel="31s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(within(childList()).getAllByRole("listitem")).toHaveLength(4);
  });
});

describe("InvestigationProgressTimeline — canonical-invalid presentation", () => {
  it("canonical-invalid WITH last-good stages shows the frozen children and no note", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: FOUR_CHILDREN })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(within(childList()).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByText(/Detailed step-by-step progress/)).toBeNull();
  });

  it("canonical-invalid with NO last-good shows the detail-unavailable note and no child list", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed" })]} // no `children` at all
        elapsedLabel="30s"
        executionDetailNote="Detailed step-by-step progress isn't available for this run right now."
        overallStatus={null}
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByText("Detailed step-by-step progress isn't available for this run right now.")).toBeInTheDocument();
  });
});

describe("InvestigationProgressTimeline — nested events under execution-stage rows", () => {
  const CHILDREN_WITH_EVENTS: readonly ExecutionStageRowViewModel[] = [
    {
      key: "INVESTIGATION_CREATED",
      status: "completed",
      label: "Investigation created",
      events: [{ sequence: 1, label: "Run created" }],
    },
    {
      key: "AGENT_ANALYSIS",
      status: "completed",
      label: "Agent analysis",
      events: [{ sequence: 2, label: "Agent started" }],
    },
    {
      key: "DIAGNOSTIC_EXECUTION",
      status: "active",
      label: "Diagnostic execution",
      events: [
        { sequence: 3, label: "Tool requested" },
        { sequence: 4, label: "Tool completed" },
      ],
    },
    childRow("REPORT_GENERATION", "pending", "Report generation"),
  ];

  function eventItems(): HTMLElement[] {
    return [...document.querySelectorAll(".investigation-progress-event-item")] as HTMLElement[];
  }

  it("renders a nested event list under each child row that carries events", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: CHILDREN_WITH_EVENTS })]}
        elapsedLabel="5s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(document.querySelectorAll(".investigation-progress-event-list")).toHaveLength(3);
    expect(eventItems()).toHaveLength(4);
    expect(document.querySelectorAll(".investigation-progress-event-item")).toHaveLength(4);
  });

  it("renders no nested event list for child rows without events", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: FOUR_CHILDREN })]}
        elapsedLabel="5s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    expect(document.querySelector(".investigation-progress-event-list")).toBeNull();
  });

  it("displays event labels in canonical sequence order", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "active", children: CHILDREN_WITH_EVENTS })]}
        elapsedLabel="5s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    const labels = eventItems().map((el) => el.textContent);
    expect(labels).toEqual(["Run created", "Agent started", "Tool requested", "Tool completed"]);
  });

  it("the four stages and their nested events remain visible at every state", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children: CHILDREN_WITH_EVENTS })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(document.querySelectorAll(".investigation-progress-children-list > .investigation-progress-item")).toHaveLength(4);
    expect(document.querySelector(".investigation-progress-event-list")).not.toBeNull();
  });

  it("an omitted stage never renders its nested events", () => {
    const children: readonly ExecutionStageRowViewModel[] = [
      {
        key: "INVESTIGATION_CREATED",
        status: "completed",
        label: "Investigation created",
        events: [{ sequence: 1, label: "Run created" }],
      },
      {
        key: "DIAGNOSTIC_EXECUTION",
        status: "omitted",
        label: "Diagnostic execution",
        events: [{ sequence: 3, label: "Tool requested" }],
      },
    ];
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    // Only INVESTIGATION_CREATED's nested list renders — the omitted
    // diagnostic stage shows no event rows at all.
    expect(document.querySelectorAll(".investigation-progress-event-list")).toHaveLength(1);
    expect(eventItems().map((el) => el.textContent)).toEqual(["Run created"]);
  });

  it("a legacy run (no canonical children) renders no nested events", () => {
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed" })]}
        elapsedLabel="30s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(document.querySelector(".investigation-progress-event-list")).toBeNull();
    expect(screen.queryByRole("button", { name: /Hide steps|Show steps/ })).toBeNull();
  });
});

describe("InvestigationProgressTimeline — hierarchy (Issue #41 HQ polish §1)", () => {
  it("once canonical stages exist, job/run are dropped entirely and availability is never a stepper row", () => {
    render(
      <InvestigationProgressTimeline
        stages={[
          stage({ key: "availability", status: "completed", label: "Live availability confirmed" }),
          stage({ key: "job", status: "completed", label: "Investigation created" }),
          stage({ key: "run", status: "completed", label: "Investigation complete", children: FOUR_CHILDREN }),
          stage({ key: "approval", status: "pending", label: "Loading approval state…" }),
        ]}
        elapsedLabel="12s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );

    // The four canonical stages are the only visually dominant rows — each
    // marked `--primary`, none marked `--system`.
    const primaryRows = [...document.querySelectorAll(".investigation-progress-item--primary")];
    expect(primaryRows).toHaveLength(4);
    for (const row of primaryRows) {
      expect(row.classList.contains("investigation-progress-item--system")).toBe(false);
    }

    // "Investigation created" appears exactly once — the canonical child's
    // own row, never a separate duplicating "job" row.
    expect(screen.getAllByText("Investigation created")).toHaveLength(1);
    // No row restates "Agent investigation in progress…" / "Investigation
    // complete" now that the four canonical rows already show run progress.
    expect(screen.queryByText("Agent investigation in progress…")).toBeNull();
    expect(screen.queryByText("Investigation complete")).toBeNull();

    // Availability renders as lightweight preflight metadata, not a stepper
    // `<li>` — the only remaining `--system` row is Approval.
    const systemRows = [...document.querySelectorAll(".investigation-progress-item--system")];
    expect(systemRows).toHaveLength(1);
    expect(within(systemRows[0] as HTMLElement).getByText("Loading approval state…")).toBeInTheDocument();
    const availability = screen.getByText("Live availability confirmed");
    expect(availability.closest("li")).toBeNull();
    expect(availability.closest(".investigation-progress-preflight")).not.toBeNull();
  });

  it("a legacy run (no canonical children) keeps job/run as system rows, and availability still stays out of the stepper", () => {
    render(
      <InvestigationProgressTimeline
        stages={[
          stage({ key: "availability", status: "completed", label: "Live availability confirmed" }),
          stage({ key: "job", status: "completed", label: "Investigation created" }),
          stage({ key: "run", status: "active", label: "Agent investigation in progress…" }),
        ]}
        elapsedLabel="12s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );

    const systemRows = [...document.querySelectorAll(".investigation-progress-item--system")];
    expect(systemRows).toHaveLength(2);
    expect(screen.getByText("Investigation created")).toBeInTheDocument();
    expect(screen.getByText("Agent investigation in progress…")).toBeInTheDocument();
    const availability = screen.getByText("Live availability confirmed");
    expect(availability.closest("li")).toBeNull();
  });
});

describe("InvestigationProgressTimeline — Not reached vs Not applicable (Issue #41 HQ polish §1)", () => {
  it("an omitted stage after a failure reads 'Not reached'", () => {
    const children: readonly ExecutionStageRowViewModel[] = [
      childRow("INVESTIGATION_CREATED", "completed", "Investigation created"),
      { ...childRow("AGENT_ANALYSIS", "failed", "Agent analysis"), notReached: false },
      { ...childRow("DIAGNOSTIC_EXECUTION", "omitted", "Diagnostic execution"), notReached: true },
      { ...childRow("REPORT_GENERATION", "omitted", "Report generation"), notReached: true },
    ];
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "failed", children })]}
        elapsedLabel="12s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    const diagnosticRow = screen.getByText("Diagnostic execution").closest("li");
    expect(diagnosticRow).not.toBeNull();
    expect(within(diagnosticRow as HTMLElement).getByText("Not reached")).toBeInTheDocument();
    const reportRow = screen.getByText("Report generation").closest("li");
    expect(within(reportRow as HTMLElement).getByText("Not reached")).toBeInTheDocument();
  });

  it("an omitted stage with no earlier failure (diagnostics skipped on a successful run) still reads 'Not applicable'", () => {
    const children = [
      ...FOUR_CHILDREN.slice(0, 2),
      childRow("DIAGNOSTIC_EXECUTION", "omitted", "Diagnostic execution"),
      childRow("REPORT_GENERATION", "completed", "Report generation"),
    ];
    render(
      <InvestigationProgressTimeline
        stages={[stage({ status: "completed", children })]}
        elapsedLabel="12s"
        executionDetailNote={null}
        overallStatus={null}
      />,
    );
    const diagnosticRow = screen.getByText("Diagnostic execution").closest("li");
    expect(within(diagnosticRow as HTMLElement).getByText("Not applicable")).toBeInTheDocument();
  });
});
