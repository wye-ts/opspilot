import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

/**
 * THE HEADER IS A CLAIM ABOUT WHAT THE APPLICATION CAN DO, and it used to say:
 *
 *     Local-only, deterministic provider — no live model calls.
 *
 * That was true until this branch added the protected LIVE Claude path. It is
 * now false in the only sense that matters to a visitor: the product CAN make
 * live model calls, and a visitor holding the demo token can cause one.
 *
 * The claim is untrue independently of whether LIVE is admissible right now.
 * `/v1/capabilities` answering UNAVAILABLE means the gate is shut today — the
 * kill switch, the daily budget, an unreconciled reservation — not that the
 * capability does not exist. So the header must NOT be conditioned on
 * capabilities: both cases below assert the same sentence.
 *
 * This is copy only. Nothing here touches admission, spend, or the kill switch.
 */

const HEADER_COPY = "Run investigations with the deterministic demo or protected Live Claude.";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AVAILABLE = () =>
  jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
const UNAVAILABLE = () =>
  jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });

/**
 * The header renders before any request resolves, but the capability read is
 * still stubbed: an unmocked `fetch` would reject and the resulting error
 * banner would be noise in a copy test.
 */
function mockCapabilities(capabilities: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/v1/capabilities") return Promise.resolve(capabilities());
      throw new Error(`unexpected request: ${String(input)}`);
    }),
  );
}

function headerNote(): HTMLElement {
  return within(screen.getByRole("banner")).getByText(HEADER_COPY);
}

const liveRadio = () => screen.getByLabelText(/Live Claude/);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page header", () => {
  it.each([
    ["LIVE is available", AVAILABLE, false],
    ["LIVE is unavailable", UNAVAILABLE, true],
  ])("describes both execution modes when %s", async (_label, capabilities, liveDisabled) => {
    mockCapabilities(capabilities);
    render(<App />);

    // Present immediately, before capabilities are known.
    expect(headerNote()).toBeInTheDocument();

    // Settle the capability read, then assert the copy did not react to it.
    await waitFor(() => {
      expect(liveRadio()).toHaveProperty("disabled", liveDisabled);
    });
    expect(headerNote()).toBeInTheDocument();
  });

  it("no longer claims the provider is deterministic-only with no live model calls", async () => {
    mockCapabilities(AVAILABLE);
    render(<App />);
    await waitFor(() => {
      expect(liveRadio()).toBeEnabled();
    });

    expect(screen.queryByText(/Local-only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deterministic provider/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no live model calls/)).not.toBeInTheDocument();
  });
});
