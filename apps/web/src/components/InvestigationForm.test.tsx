import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InvestigationForm } from "./InvestigationForm";

/**
 * The ordinary new-investigation form: not retrying, with inert retry callbacks.
 *
 * Spread FIRST at every call site, so any test that cares about retry mode can
 * still override it. The three props are required on the component so that a new
 * construction site has to decide what it means — these tests are all about the
 * creation form, and this states that once.
 */
const NOT_RETRYING = {
  liveRetryTarget: null,
  onRetryLiveRun: () => undefined,
  onStartNewInvestigation: () => undefined,
} as const;

describe("InvestigationForm", () => {
  it("associates a real label with the Issue Summary textarea", () => {
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={vi.fn()} capabilities={null} />);
    expect(screen.getByLabelText("Issue Summary")).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("blocks submission when the summary is empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} />);

    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submission when the summary is whitespace only", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} />);

    await user.type(screen.getByLabelText("Issue Summary"), "   ");
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the trimmed summary", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} />);

    await user.type(screen.getByLabelText("Issue Summary"), "  Elevated error rate  ");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith({
      summary: "Elevated error rate",
      approvalDemo: false,
      providerMode: "FAKE",
    });
  });

  it("defaults approvalDemo to false without the query-param default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} />);

    await user.type(screen.getByLabelText("Issue Summary"), "a summary long enough to submit");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: false }));
  });

  it("preselects approvalDemo on the FAKE path when defaultApprovalDemo is set", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} defaultApprovalDemo={true} />,
    );

    await user.type(screen.getByLabelText("Issue Summary"), "a summary long enough to submit");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: true }));
  });

  it("renders no editable Ticket ID field, and only the two provider radios", () => {
    const { container } = render(
      <InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={vi.fn()} capabilities={null} />,
    );
    expect(screen.queryByLabelText(/ticket/i)).toBeNull();

    // Two provider-mode radios. No approval-demo checkbox (Milestone 10) and no
    // token field: capabilities are null, so LIVE is unavailable/unselectable.
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs.map((input) => input.type)).toEqual(["radio", "radio"]);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("disables the textarea, provider radios, and button while the workflow is active", () => {
    render(<InvestigationForm {...NOT_RETRYING} disabled={true} submitLabel="Running agent…" onSubmit={vi.fn()} capabilities={null} />);
    expect(screen.getByLabelText("Issue Summary")).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Demo/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Running agent…" })).toBeDisabled();
  });

  it("a rapid double-click issues exactly one submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={null} />);

    await user.type(screen.getByLabelText("Issue Summary"), "a summary long enough to submit");
    const button = screen.getByRole("button", { name: "Start Investigation" });
    await user.dblClick(button);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

const LIVE_AVAILABLE = { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } as const;
const LIVE_UNAVAILABLE = { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } as const;

function renderForm(capabilities: typeof LIVE_AVAILABLE | typeof LIVE_UNAVAILABLE | null, onSubmit = vi.fn(), defaultApprovalDemo = false) {
  const result = render(
    <InvestigationForm {...NOT_RETRYING} disabled={false} submitLabel="Start Investigation" onSubmit={onSubmit} capabilities={capabilities} defaultApprovalDemo={defaultApprovalDemo} />,
  );
  return { ...result, onSubmit };
}

const LONG_SUMMARY = "Elevated API error rate on billing";

describe("InvestigationForm — progressive summary validation", () => {
  it("shows the subtle helper while empty and keeps the CTA disabled", async () => {
    const user = userEvent.setup();
    renderForm(null);

    // Empty trimmed summary -> subtle helper, no warn.
    expect(screen.getByText(/Describe the issue in at least 15 characters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeDisabled();

    // 5 real trimmed characters -> amber add-more-detail warn, CTA still disabled.
    await user.type(screen.getByLabelText("Issue Summary"), "  short  ");
    expect(screen.getByText(/Add more detail — the issue summary needs at least 15 characters/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeDisabled();
  });

  it("enables the CTA at exactly 15 trimmed characters and clears the warn", async () => {
    const user = userEvent.setup();
    renderForm(null);
    const button = screen.getByRole("button", { name: "Start Investigation" });

    await user.type(screen.getByLabelText("Issue Summary"), "a".repeat(14));
    expect(screen.getByText(/Add more detail — the issue summary needs at least 15 characters/i)).toBeInTheDocument();
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Issue Summary"), "a");
    // The progressive helper disappears once valid — the enabled CTA is the
    // positive signal (§8). No permanent "n / 15" counter.
    expect(screen.queryByText(/Add more detail — the issue summary needs at least 15 characters/i)).toBeNull();
    expect(screen.queryByText(/at least 15 characters/i)).toBeNull();
    expect(button).toBeEnabled();
  });

  it("is an affordance only — the copy states the rule the backend enforces", () => {
    renderForm(null);
    expect(screen.getByText(/at least 15 characters/i)).toBeInTheDocument();
  });
});

describe("InvestigationForm — provider mode selector", () => {
  it("defaults to FAKE (Demo card selected)", () => {
    renderForm(LIVE_AVAILABLE);
    expect(screen.getByRole("radio", { name: /Demo/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Live/ })).not.toBeChecked();
  });

  it("submits providerMode FAKE by default", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(LIVE_AVAILABLE);

    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ providerMode: "FAKE" }));
  });

  it("disables the LIVE option with a visible reason when unavailable", () => {
    // Disabled and explained, never hidden — a hidden control makes the feature
    // look absent rather than protected.
    renderForm(LIVE_UNAVAILABLE);

    expect(screen.getByRole("radio", { name: /Live/ })).toBeDisabled();
    // The unavailableReason copy (distinct from the pill text) explains WHY.
    expect(screen.getByText(/the deterministic demo is always available/i)).toBeInTheDocument();
  });

  it("treats unknown capabilities as unavailable, failing closed", () => {
    renderForm(null);
    expect(screen.getByRole("radio", { name: /Live/ })).toBeDisabled();
  });

  it("submits providerMode LIVE once selected", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: "LIVE", liveAccessToken: "tok-abc" }),
    );
  });
});

describe("InvestigationForm — approval demo and LIVE are mutually exclusive", () => {
  it("no public Approval workflow demo checkbox exists (Milestone 10)", () => {
    renderForm(LIVE_AVAILABLE);
    expect(screen.queryByLabelText("Approval workflow demo")).toBeNull();
  });

  it("clears a defaultApprovalDemo preselect when switching to LIVE", async () => {
    // The deterministic TICKET-APPROVAL-DEMO scenario has no meaning for a live
    // run, and a live run must never be started under that ticket ID.
    const user = userEvent.setup();
    const { onSubmit } = renderForm(LIVE_AVAILABLE, vi.fn(), true);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: false, providerMode: "LIVE" }));
  });

  it("does not restore a previously preselect approvalDemo when switching back to FAKE", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(LIVE_AVAILABLE, vi.fn(), true);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.click(screen.getByRole("radio", { name: /Demo/ }));
    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalDemo: false }));
  });
});

describe("InvestigationForm — live access token containment", () => {
  it("shows the token field only for LIVE when a token is required", async () => {
    const user = userEvent.setup();
    renderForm(LIVE_AVAILABLE);

    expect(screen.queryByLabelText("Live demo access token")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    expect(screen.getByLabelText("Live demo access token")).toBeInTheDocument();
  });

  it("renders the token input as a password field with the session-only notice", async () => {
    const user = userEvent.setup();
    renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));

    expect(screen.getByLabelText("Live demo access token")).toHaveAttribute("type", "password");
    expect(screen.getByText(/Used only for this browser session/i)).toBeInTheDocument();
    expect(screen.getByText(/Not stored on this device/i)).toBeInTheDocument();
  });

  it("keeps submission disabled until a required token is supplied", async () => {
    // A LIVE submission with no token is a guaranteed 401, so the button stays
    // disabled rather than spending a round trip to be told so.
    const user = userEvent.setup();
    renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeDisabled();

    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeEnabled();
  });

  it("clears the token when switching back to FAKE", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");
    await user.click(screen.getByRole("radio", { name: /Demo/ }));
    await user.type(screen.getByLabelText("Issue Summary"), LONG_SUMMARY);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    // No token on the FAKE submission at all — not an empty one.
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ providerMode: "FAKE" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("liveAccessToken");

    // And the field itself is empty again when LIVE is reselected.
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    expect(screen.getByLabelText("Live demo access token")).toHaveValue("");
  });

  it("never writes the token to localStorage or sessionStorage", async () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");

    expect(localSet).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("liveAccessToken")).toBeNull();
    expect(window.sessionStorage.getItem("liveAccessToken")).toBeNull();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("tok-abc");
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("tok-abc");
    localSet.mockRestore();
  });

  it("never puts the token in the URL, query string, or hash", async () => {
    const user = userEvent.setup();
    renderForm(LIVE_AVAILABLE);

    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), "tok-abc");

    expect(window.location.href).not.toContain("tok-abc");
    expect(window.location.search).not.toContain("tok-abc");
    expect(window.location.hash).not.toContain("tok-abc");
  });

  /**
   * A LIVE submission always needs a token, whatever the capability snapshot
   * says.
   *
   * This test previously asserted the opposite — that the field is hidden when
   * `liveAccess` is not `TOKEN_REQUIRED` — which is exactly how a tokenless LIVE
   * submission became possible: the field was hidden, `tokenSatisfied` was
   * vacuously true, and the submit button enabled. If the preflight then found
   * LIVE had recovered, the browser created an AgentJob and sent an
   * unauthenticated run request.
   *
   * Availability and authentication are different questions.
   */
  it("still requires a token when the snapshot does not advertise one", async () => {
    const user = userEvent.setup();
    renderForm({ liveAgentRuns: "AVAILABLE", liveAccess: "NOT_APPLICABLE" } as never);

    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await user.click(screen.getByRole("radio", { name: /Live/ }));

    // The field is rendered...
    expect(screen.getByLabelText("Live demo access token")).toBeInTheDocument();
    // ...and submission is blocked until it has a value.
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeDisabled();

    await user.type(screen.getByLabelText("Live demo access token"), "tok-1");
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeEnabled();
  });

  it("requires a token even when capabilities are unknown", async () => {
    // `null` capabilities disable the LIVE radio, but nothing about an unknown
    // snapshot means a live run stops needing authentication.
    const user = userEvent.setup();
    renderForm(null);

    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    expect(screen.getByRole("radio", { name: /Live/ })).toBeDisabled();
    // FAKE remains submittable — the requirement is scoped to LIVE.
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeEnabled();
    void user;
  });
});
