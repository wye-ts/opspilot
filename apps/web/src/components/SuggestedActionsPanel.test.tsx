import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SuggestedAction } from "../api/types";
import { SuggestedActionsPanel } from "./SuggestedActionsPanel";

describe("SuggestedActionsPanel", () => {
  it("renders one card per suggested action, all three variants", () => {
    const actions: SuggestedAction[] = [
      { type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." } },
      { type: "CREATE_ESCALATION", payload: { team: "platform", reason: "Needs attention.", priority: "HIGH" } },
      { type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We are looking into it." } },
    ];
    render(<SuggestedActionsPanel actions={actions} />);

    expect(screen.getByText("Suggested actions")).toBeInTheDocument();
    expect(screen.getByText("Update ticket status")).toBeInTheDocument();
    expect(screen.getByText("Create escalation")).toBeInTheDocument();
    expect(screen.getByText("Draft customer reply")).toBeInTheDocument();
    expect(screen.getByText("RESOLVED")).toBeInTheDocument();
    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(screen.getByText("We are looking into it.")).toBeInTheDocument();
  });

  it("its heading is focusable via tabindex=-1, matching the other top-level sections", () => {
    render(<SuggestedActionsPanel actions={[{ type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." } }]} />);
    expect(screen.getByRole("heading", { name: "Suggested actions" })).toHaveAttribute("tabindex", "-1");
  });

  // Defensive: App.tsx never mounts this component for an empty array (it
  // gates on `actions.length > 0`), but the component itself should still
  // render a well-formed, empty list rather than anything broken if it ever
  // is.
  it("renders a heading and an empty list, not an error, for an empty array", () => {
    render(<SuggestedActionsPanel actions={[]} />);
    expect(screen.getByText("Suggested actions")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
