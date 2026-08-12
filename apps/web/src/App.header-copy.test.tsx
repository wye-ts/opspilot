import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

/**
 * THE HEADER IS PRODUCT IDENTITY ONLY (§4). Milestone 10 replaced the old
 * capabilities claim ("Run investigations with the deterministic demo or
 * protected Live Claude.") with a brand + source link. Run state — including
 * whether Live is admissible right now — belongs to the Current investigation
 * / Progress surfaces once a job exists, never to the header. So the header
 * copy is capability-independent: `/v1/capabilities` answering UNAVAILABLE
 * changes the provider gate, not a single character of the header.
 */

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page header", () => {
  it.each([
    ["LIVE is available", AVAILABLE],
    ["LIVE is unavailable", UNAVAILABLE],
  ])("renders OpsPilot identity and the source link when %s", async (_label, capabilities) => {
    mockCapabilities(capabilities);
    render(<App />);

    // Present immediately, before capabilities are known.
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("OpsPilot")).toBeInTheDocument();
    expect(within(banner).getByText("AI Operations Investigator")).toBeInTheDocument();

    // The source link is the grounded portfolio link (§4), external and safe.
    const sourceLink = within(banner).getByRole("link", { name: /View source/ });
    expect(sourceLink).toHaveAttribute("href", "https://github.com/wye-ts/opspilot");
    expect(sourceLink).toHaveAttribute("target", "_blank");
    expect(sourceLink).toHaveAttribute("rel", "noopener noreferrer");

    // Settle the capability read, then assert the copy did not react to it.
    await waitFor(() => expect(within(banner).getByText("OpsPilot")).toBeInTheDocument());
    expect(within(banner).getByText("AI Operations Investigator")).toBeInTheDocument();
  });

  it("no longer claims the provider is deterministic-only, and names Live, never 'Live Claude'", async () => {
    mockCapabilities(AVAILABLE);
    render(<App />);

    const banner = screen.getByRole("banner");
    expect(within(banner).queryByText(/Local-only/)).not.toBeInTheDocument();
    expect(within(banner).queryByText(/deterministic provider/)).not.toBeInTheDocument();
    expect(within(banner).queryByText(/no live model calls/)).not.toBeInTheDocument();
    expect(within(banner).queryByText(/Live Claude/)).not.toBeInTheDocument();
  });
});

describe("app footer", () => {
  it("renders the portfolio byline with the approved LinkedIn link", () => {
    mockCapabilities(UNAVAILABLE);
    render(<App />);

    const footer = screen.getByRole("contentinfo");
    const linkedIn = within(footer).getByRole("link", { name: /Wenjie Ye · LinkedIn/ });
    expect(linkedIn).toHaveAttribute("href", "https://www.linkedin.com/in/wenjie-ye-33884b183/");
    expect(linkedIn).toHaveAttribute("target", "_blank");
    expect(linkedIn).toHaveAttribute("rel", "noopener noreferrer");
  });
});
