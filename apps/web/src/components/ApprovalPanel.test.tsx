import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalView } from "../api/types";
import { ApprovalPanel } from "./ApprovalPanel";

function approval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    runId: "run-1",
    status: "NOT_ELIGIBLE",
    reviewerName: null,
    note: null,
    decidedAt: null,
    ...overrides,
  };
}

describe("ApprovalPanel", () => {
  it("NOT_ELIGIBLE renders a compact secondary status with no buttons and no ?approval-demo=1 leak (§10)", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "NOT_ELIGIBLE" })}
        suggestedActionCount={0}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Not eligible")).toBeInTheDocument();
    expect(screen.getByText("Not eligible: this run produced no suggested actions.")).toBeInTheDocument();
    // The query-param demo path is a deterministic hidden/test entry point,
    // never a user-facing product instruction (§10).
    expect(screen.queryByText(/approval-demo=1/)).toBeNull();
    expect(screen.queryByText(/checkbox/i)).toBeNull();
    expect(screen.queryByText(/ticket/i)).toBeNull();
  });

  it("PENDING renders the ApprovalDecisionForm", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "PENDING" })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Reviewer name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("APPROVED renders reviewer, note, and decidedAt", () => {
    render(
      <ApprovalPanel
        approval={approval({
          status: "APPROVED",
          reviewerName: "Jacky",
          note: "Looks good",
          decidedAt: "2026-07-23T10:15:00.000Z",
        })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("Jacky")).toBeInTheDocument();
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("REJECTED renders reviewer, note, and decidedAt", () => {
    render(
      <ApprovalPanel
        approval={approval({
          status: "REJECTED",
          reviewerName: "Jacky",
          note: "Not appropriate",
          decidedAt: "2026-07-23T10:15:00.000Z",
        })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("Jacky")).toBeInTheDocument();
    expect(screen.getByText("Not appropriate")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("APPROVED contains no edit, revoke, resubmit, or decision buttons", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/edit|revoke|resubmit/i)).toBeNull();
  });

  it("REJECTED contains no edit, revoke, resubmit, or decision buttons", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "REJECTED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/edit|revoke|resubmit/i)).toBeNull();
  });

  it("PENDING with decisionDisabled true disables the reviewer input and both buttons", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "PENDING" })}
        suggestedActionCount={1}
        decisionDisabled={true}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Reviewer name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("a null note renders 'No note provided'", () => {
    render(
      <ApprovalPanel
        approval={approval({ status: "APPROVED", reviewerName: "Jacky", note: null, decidedAt: "2026-07-23T10:15:00.000Z" })}
        suggestedActionCount={1}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("No note provided")).toBeInTheDocument();
  });
});

/**
 * Issue #131 — the reviewer must read the execution boundary WHILE deciding.
 *
 * approval-presentation.test.ts pins the sentence; this pins its POSITION.
 * A disclosure rendered only after an irreversible click preserves the very
 * misconception it exists to remove, so asserting the string alone is not
 * enough — an earlier draft of the plan placed it on the terminal states only
 * and independent review rejected that as MAJOR.
 */
describe("ApprovalPanel — issue #131 disclosure placement", () => {
  const DISCLOSURE = /does not carry out any suggested actions/i;

  it("shows the no-execution disclosure BEFORE the decision controls on PENDING", () => {
    const { container } = render(
      <ApprovalPanel
        approval={approval({ status: "PENDING" })}
        suggestedActionCount={2}
        decisionDisabled={false}
        submittingDecision={false}
        onDecide={vi.fn()}
      />,
    );

    const hint = screen.getByText(DISCLOSURE);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(hint).toBeInTheDocument();

    // DOM order, not merely presence: DOCUMENT_POSITION_FOLLOWING means the
    // Approve button comes after the hint in document order, so a reviewer
    // reads the boundary on the way to the controls.
    const relation = hint.compareDocumentPosition(approve);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING, "disclosure must precede the Approve control").toBeTruthy();

    // Guard against a DOM-order pass achieved by hiding the text.
    expect(container.querySelector(".approval-panel-hint")).toBe(hint);
  });

  it("keeps the disclosure visible on both terminal states", () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const { unmount } = render(
        <ApprovalPanel
          approval={approval({ status, reviewerName: "Dana", decidedAt: "2026-09-22T10:00:00.000Z" })}
          suggestedActionCount={2}
          decisionDisabled={false}
          submittingDecision={false}
          onDecide={vi.fn()}
        />,
      );
      expect(screen.getByText(DISCLOSURE), status).toBeInTheDocument();
      unmount();
    }
  });
});
