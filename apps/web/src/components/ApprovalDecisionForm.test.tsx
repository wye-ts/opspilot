import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApprovalDecisionForm, NOTE_MAX_LENGTH, REVIEWER_NAME_MAX_LENGTH } from "./ApprovalDecisionForm";

describe("ApprovalDecisionForm", () => {
  it("blocks submission when reviewerName is empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submission when reviewerName is whitespace only", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "   ");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("trims reviewerName in the submitted payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "  Jacky  ");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(onSubmit).toHaveBeenCalledWith({ decision: "APPROVED", reviewerName: "Jacky" });
  });

  it("omits note entirely when blank", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    const payload = onSubmit.mock.calls[0]?.[0];
    expect("note" in payload).toBe(false);
  });

  it("omits note entirely when whitespace only", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.type(screen.getByLabelText("Note (optional)"), "   ");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    const payload = onSubmit.mock.calls[0]?.[0];
    expect("note" in payload).toBe(false);
  });

  it("trims and includes a non-blank note", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.type(screen.getByLabelText("Note (optional)"), "  Looks good  ");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(onSubmit).toHaveBeenCalledWith({ decision: "APPROVED", reviewerName: "Jacky", note: "Looks good" });
  });

  it("Approve submits decision APPROVED", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ decision: "APPROVED" }));
  });

  it("Reject submits decision REJECTED", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ decision: "REJECTED" }));
  });

  it("disables the reviewer input, note textarea, and both buttons whenever disabled is true, independent of submitting", () => {
    render(<ApprovalDecisionForm disabled={true} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Reviewer name")).toBeDisabled();
    expect(screen.getByLabelText("Note (optional)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("sets aria-busy on the form whenever disabled is true, even when submitting is false", () => {
    // This is the Finding 1 regression case: disabled must stay true (and
    // aria-busy with it) through phases like the automatic post-409
    // convergence GET, where submitting has already gone back to false.
    render(<ApprovalDecisionForm disabled={true} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Reviewer name").closest("form")).toHaveAttribute("aria-busy", "true");
  });

  it("does not disable controls or set aria-busy when disabled is false", async () => {
    const user = userEvent.setup();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Reviewer name").closest("form")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByLabelText("Reviewer name")).not.toBeDisabled();

    // The Approve button is separately gated by a non-empty reviewer name —
    // type one so this assertion isolates the `disabled` prop's effect.
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });

  it("reviewer name is exposed to the browser and assistive technology as required", () => {
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Reviewer name")).toBeRequired();
  });

  it("the optional note field is not required", () => {
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Note (optional)")).not.toBeRequired();
  });

  it("a rapid double-click on Approve produces exactly one submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.dblClick(screen.getByRole("button", { name: "Approve" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("reviewerName and note carry maxLength matching the contract bounds", () => {
    render(<ApprovalDecisionForm disabled={false} submitting={false} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Reviewer name")).toHaveAttribute("maxLength", String(REVIEWER_NAME_MAX_LENGTH));
    expect(screen.getByLabelText("Note (optional)")).toHaveAttribute("maxLength", String(NOTE_MAX_LENGTH));
  });
});
