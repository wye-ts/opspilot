import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InvestigationForm } from "./InvestigationForm";

describe("InvestigationForm", () => {
  it("associates a real label with the Issue Summary textarea", () => {
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Issue Summary")).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("blocks submission when the summary is empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Run Investigation" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submission when the summary is whitespace only", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Issue Summary"), "   ");
    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the trimmed summary", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Issue Summary"), "  Elevated error rate  ");
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith({ summary: "Elevated error rate", approvalDemo: false });
  });

  it("the Approval workflow demo checkbox is keyboard operable", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    const checkbox = screen.getByLabelText("Approval workflow demo");
    checkbox.focus();
    expect(checkbox).toHaveFocus();
    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
  });

  it("reports approvalDemo: false when unchecked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Issue Summary"), "summary");
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: false }));
  });

  it("reports approvalDemo: true when checked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Issue Summary"), "summary");
    await user.click(screen.getByLabelText("Approval workflow demo"));
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: true }));
  });

  it("renders no editable Ticket ID field, and no input other than the checkbox", () => {
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText(/ticket/i)).toBeNull();

    const { container } = render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={vi.fn()} />);
    const inputs = container.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe("checkbox");
  });

  it("disables the textarea, checkbox, and button while the workflow is active", () => {
    render(<InvestigationForm disabled={true} submitLabel="Running agent…" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Issue Summary")).toBeDisabled();
    expect(screen.getByLabelText("Approval workflow demo")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Running agent…" })).toBeDisabled();
  });

  it("a rapid double-click issues exactly one submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm disabled={false} submitLabel="Run Investigation" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Issue Summary"), "summary");
    const button = screen.getByRole("button", { name: "Run Investigation" });
    await user.dblClick(button);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
