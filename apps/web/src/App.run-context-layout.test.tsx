import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

const UUID_A = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return {
    id: "job-1",
    ticketId: `DEMO-${UUID_A}`,
    summary: "Elevated error rate",
    createdAt: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

function runDetail(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "FAKE",
      // A FAKE run made no provider call, so there is no measured cost.
      estimatedCostUsd: null,
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "s",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.5,
        evidence: [],
        suggestedActions: [],
      },
    },
    ...overrides,
  };
}

function demoRunDetail(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return runDetail({
    job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }),
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "s",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.5,
        evidence: [],
        suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." } }],
      },
    },
    ...overrides,
  });
}

function approvalView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    runId: "run-1",
    status: "NOT_ELIGIBLE",
    reviewerName: null,
    note: null,
    decidedAt: null,
    ...overrides,
  };
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

async function submitOrdinary(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

async function submitDemo(user: ReturnType<typeof userEvent.setup>, summary = "Approval demo issue") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByLabelText("Approval workflow demo"));
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

/**
 * The app reads GET /v1/capabilities once on mount, before any user interaction,
 * so it is always the first fetch of a test. Each test's mock chain therefore
 * begins with this response, and `apiCalls()` filters it back out — every
 * assertion below is about the investigation workflow, not the capability probe.
 *
 * UNAVAILABLE keeps the LIVE option disabled, which is the posture these
 * deterministic workflow tests exercise.
 */
function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

function apiCalls() {
  return vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Run Context Panel layout", () => {
  it("PENDING renders the Action required banner, linking to #approval-heading", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    const banner = screen.getByRole("link", { name: /action required/i });
    expect(banner).toHaveAttribute("href", "#approval-heading");
  });

  // Approval-related UI (the banner included) must follow Agent activity,
  // Generated report, and Suggested actions in DOM order.
  it("the banner follows the named Run detail region in DOM order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    const banner = screen.getByRole("link", { name: /action required/i });
    const runDetailRegion = screen.getByRole("region", { name: /run detail/i });
    expect(runDetailRegion.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("NOT_ELIGIBLE does not render the Action required banner", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Not eligible");

    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("APPROVED does not render the Action required banner", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
        }),
      );

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Approved");

    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("REJECTED does not render the Action required banner", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: approvalView({ status: "REJECTED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
        }),
      );

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Rejected");

    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("exactly one Approve button and one Reject button exist while PENDING", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
  });

  it("approval === null renders run facts with no eligibility claim", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(
        jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      );

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Run overview");

    expect(screen.queryByText("Not eligible")).toBeNull();
    expect(screen.queryByText("This run has no suggested actions to approve.")).toBeNull();
    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("NOT_ELIGIBLE renders run facts plus the reused eligibility copy/hint", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Run overview");

    // The "Approval workflow demo" checkbox label is always present in
    // InvestigationForm regardless of run state, so the reused hint text
    // (which also names that checkbox) is asserted scoped to the Run
    // overview region, not via a page-wide text query.
    const overviewRegion = screen.getByRole("region", { name: "Run overview" });
    expect(within(overviewRegion).getByText("Not eligible")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("This run has no suggested actions to approve.")).toBeInTheDocument();
    expect(within(overviewRegion).getByText(/Approval workflow demo/)).toBeInTheDocument();
  });

  it("PENDING renders ApprovalPanel, not RunOverviewPanel", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    expect(screen.queryByText("Run overview")).toBeNull();
    expect(screen.getByRole("region", { name: "Approval" })).toBeInTheDocument();
  });

  it("APPROVED renders a read-only decision record with zero buttons", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
        }),
      );

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Approved");

    expect(screen.queryByText("Run overview")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /approve|reject/i })).toHaveLength(0);
  });

  it("REJECTED renders a read-only decision record with zero buttons", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: approvalView({ status: "REJECTED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
        }),
      );

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Rejected");

    expect(screen.queryByText("Run overview")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /approve|reject/i })).toHaveLength(0);
  });

  it("PENDING -> APPROVED removes the banner and shows the terminal record", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");
    expect(screen.getByRole("link", { name: /action required/i })).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, {
        data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Approved");

    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("PENDING -> REJECTED removes the banner and shows the terminal record", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");
    expect(screen.getByRole("link", { name: /action required/i })).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, {
        data: approvalView({ status: "REJECTED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await screen.findByText("Rejected");

    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();
  });

  it("a fresh investigation resolving to PENDING announces the completion notice", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Investigation complete. Human approval required."),
    );
  });

  it("a retried run resolving to PENDING announces the completion notice", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      );

    render(<App />);
    await submitOrdinary(user);
    const retryButton = await screen.findByRole("button", { name: "Retry Run" });

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    await user.click(retryButton);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Investigation complete. Human approval required."),
    );
  });

  it("an explicit refresh resolving to PENDING announces the refresh-flavored notice, not fresh completion", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Run refreshed. Human approval required."),
    );
  });

  it("an explicit refresh resolving to a non-pending status announces plain 'Run refreshed.'", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Not eligible");

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Run refreshed."));
    expect(screen.getByRole("status")).not.toHaveTextContent("Human approval required.");
  });

  it("timeline, report, and approval heading targets are focusable via tabindex=-1", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    expect(document.getElementById("timeline-heading")).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("report-heading")).toHaveAttribute("tabindex", "-1");
    expect(document.getElementById("approval-heading")).toHaveAttribute("tabindex", "-1");
  });

  it("a long reviewer note remains present as plain wrapped text, not moved into a duplicated control", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    const longNote = "This is an unusually long reviewer note that should wrap safely. ".repeat(15).trim();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, {
        data: approvalView({
          status: "APPROVED",
          reviewerName: "Jacky",
          note: longNote,
          decidedAt: "2026-07-23T10:15:00.000Z",
        }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Decision recorded.");

    // getByText (singular) already throws if the note is duplicated anywhere
    // else in the document, so this is both a presence and a uniqueness check.
    const noteNode = screen.getByText(longNote);
    expect(noteNode.tagName).toBe("DD");
    expect(noteNode).toHaveClass("approval-decision-note");
    expect(screen.queryAllByRole("button", { name: /approve|reject/i })).toHaveLength(0);
  });
});
