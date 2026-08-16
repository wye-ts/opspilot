import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SuggestedAction } from "../api/types";
import { SuggestedActionCard } from "./SuggestedActionCard";

// Legacy-normalized read shape: groundedBy is [] for pre-#60 stored actions,
// and the card must render no grounding line for it.
const replyAction: SuggestedAction = {
  type: "DRAFT_CUSTOMER_REPLY",
  payload: { subject: "Update on password reset issue", body: "We've identified the root cause." },
  groundedBy: [],
};

// Modern #60 read shape: a grounded action carries 1..10 evidence locators.
const groundedReplyAction: SuggestedAction = {
  type: "DRAFT_CUSTOMER_REPLY",
  payload: { subject: "Update on password reset issue", body: "We've identified the root cause." },
  groundedBy: [{ evidenceId: "call-1", sourceType: "TOOL_EXECUTION" }],
};

// Multiple locators render compactly on one muted line.
const multiLocatorAction: SuggestedAction = {
  type: "CREATE_ESCALATION",
  payload: { team: "Email Platform Engineering", priority: "MEDIUM", reason: "Needs verification." },
  groundedBy: [
    { evidenceId: "call-1", sourceType: "TOOL_EXECUTION" },
    { evidenceId: "runbook-email-001", sourceType: "RAG_CHUNK" },
  ],
};

// `userEvent.setup()` installs its own jsdom Clipboard stub on
// `navigator.clipboard` as a side effect (@testing-library/user-event's
// `attachClipboardStubToView`) — so this must run AFTER `userEvent.setup()`,
// or setup() silently clobbers it back to a real-looking, non-mock
// Clipboard. `configurable: true` lets each test swap in its own mock (or
// remove it entirely, to simulate an unavailable API).
function stubClipboard(clipboard: { readonly writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

// Item 5 of the follow-up polish pass — the Draft customer reply card's
// header Copy CTA. Frontend convenience only: no persistence, no change to
// the suggested-action contract, so these tests cover the clipboard
// interaction and its states rather than anything backend-facing.
describe("SuggestedActionCard — Draft customer reply Copy CTA", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies Subject + Body as plain text (never card chrome or metadata) and shows Copied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    render(<SuggestedActionCard action={replyAction} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(
      "Subject: Update on password reset issue\n\nWe've identified the root cause.",
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  // Real timers, not fake ones — this repo's fake-timer setup
  // (`shouldAdvanceTime`) is known to produce flaky ordering across the full
  // suite, and separately, @testing-library/user-event's `setup()` installs
  // its own Clipboard stub that only cooperates with fake timers via delicate
  // sequencing. A real (bounded) wait is slower but reliable.
  it(
    "reverts from Copied back to Copy after a short delay",
    async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard({ writeText });

      render(<SuggestedActionCard action={replyAction} />);
      await user.click(screen.getByRole("button", { name: "Copy" }));
      expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

      await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument(), {
        timeout: 4000,
      });
    },
    7000,
  );

  it("falls back to a transient 'Copy failed' state when the clipboard API is unavailable, without throwing", async () => {
    const user = userEvent.setup();
    stubClipboard(undefined);

    render(<SuggestedActionCard action={replyAction} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });

  it("is keyboard accessible: a focused Copy button responds to Enter", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    render(<SuggestedActionCard action={replyAction} />);
    screen.getByRole("button", { name: "Copy" }).focus();
    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("renders no Copy CTA for suggested action types other than Draft customer reply", () => {
    const escalation: SuggestedAction = {
      type: "CREATE_ESCALATION",
      payload: { team: "Email Platform Engineering", priority: "MEDIUM", reason: "Needs verification." },
      groundedBy: [],
    };
    render(<SuggestedActionCard action={escalation} />);

    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });
});

// Issue #60 Checkpoint C — the grounding line on Suggested Action cards.
describe("SuggestedActionCard — grounding line", () => {
  it("renders 'Grounded in:' with the humanized source and evidenceId for a grounded modern action", () => {
    render(<SuggestedActionCard action={groundedReplyAction} />);

    expect(screen.getByText(/Grounded in:/)).toBeInTheDocument();
    expect(screen.getByText(/Tool execution call-1/)).toBeInTheDocument();
  });

  it("renders multiple locators compactly on one line", () => {
    render(<SuggestedActionCard action={multiLocatorAction} />);

    const grounding = screen.getByText(/Grounded in:/);
    expect(grounding).toBeInTheDocument();
    expect(screen.getByText(/Tool execution call-1/)).toBeInTheDocument();
    expect(screen.getByText(/Rag chunk runbook-email-001/)).toBeInTheDocument();
  });

  it("omits the grounding line for a legacy normalized action with groundedBy: []", () => {
    render(<SuggestedActionCard action={replyAction} />);

    expect(screen.queryByText(/Grounded in:/)).toBeNull();
  });

  it("keeps the existing card payload behavior intact alongside the grounding line", () => {
    render(<SuggestedActionCard action={multiLocatorAction} />);

    expect(screen.getByText("Email Platform Engineering")).toBeInTheDocument();
    expect(screen.getByText("Needs verification.")).toBeInTheDocument();
  });
});
