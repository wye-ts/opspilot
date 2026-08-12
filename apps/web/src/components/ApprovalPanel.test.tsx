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
