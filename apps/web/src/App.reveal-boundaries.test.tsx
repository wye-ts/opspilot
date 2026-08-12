import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * Data-driven reveal boundaries only (no timers/animation):
 *
 *   submission starts               -> submitted summary + Investigation progress
 *   run data exists                 -> Agent activity may render
 *   run is terminal and has report  -> Resolution report may render
 *   terminal + non-empty actions    -> Suggested actions may render
 *   initial approval load settled
 *     and approval is applicable    -> approval UI may render, after Suggested actions
 */

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

function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

/**
 * Investigation polling (#38) starts concurrently with every submit this
 * file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), which is
 * invisible to every reveal-boundary assertion here.
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, { error: { code: "PERSISTENCE_UNAVAILABLE", message: "not tracked by this test", requestId: "req-1" } });
}

function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

function headingOrder(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Data-driven reveal boundaries", () => {
  // Scenario 1: unresolved run (job committed, run pending).
  it("shows only Progress while the run is unresolved — Agent activity, Report, Actions, and Approval are absent", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredRun = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockImplementationOnce(() => deferredRun.promise);

    render(<App />);
    await submit(user);

    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Resolution report")).toBeNull();
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Human approval" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Review actions" })).toBeNull();

    deferredRun.resolve(jsonResponse(201, { data: runDetail() }));
  });

  // Scenario 2: RUNNING run data.
  it("RUNNING outcome: Agent activity shows with real trace data; Report, Actions, and Approval stay absent", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      // A RUNNING outcome never triggers the approval fetch — no fourth
      // mock queued (see App.run-workflow.test.tsx's identical note); an
      // unused extra mock here would otherwise be wrongly consumed by
      // investigation polling (#38), which starts concurrently.
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({
            trace: [{ type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }],
            outcome: { type: "RUNNING" },
          }),
        }),
      );

    render(<App />);
    await submit(user);

    await screen.findByText("Agent activity");
    expect(screen.getByText("Checking service status")).toBeInTheDocument();
    expect(screen.queryByText("Resolution report")).toBeNull();
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Human approval" })).toBeNull();
  });

  // Scenario 3: terminal run with a report but empty actions.
  it("terminal run with report but empty actions: Agent activity then Resolution report; no Suggested actions; no approval unless applicable", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submit(user);
    await screen.findByText("Resolution report");

    const order = headingOrder();
    // Milestone-10 flat flow: the resolution row (Resolution report) precedes
    // the Agent activity section.
    expect(order.indexOf("Resolution report")).toBeLessThan(order.indexOf("Agent activity"));
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // NOT_ELIGIBLE is not "applicable" — the panel mounts (§18) but exposes no
    // decision surface.
    const approvalRegion = screen.getByRole("region", { name: "Human approval" });
    expect(within(approvalRegion).queryByRole("button")).toBeNull();
  });

  // Scenario 4: terminal run with non-empty actions.
  it("terminal run with non-empty actions: Agent activity -> Resolution report -> Suggested actions, in DOM order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({
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
                suggestedActions: [{ type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." } }],
              },
            },
          }),
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submit(user);
    await screen.findByText("Suggested actions");

    const order = headingOrder();
    const activityIndex = order.indexOf("Agent activity");
    const reportIndex = order.indexOf("Resolution report");
    const actionsIndex = order.indexOf("Suggested actions");
    // Milestone-10 flat flow: Resolution report -> Suggested actions -> Agent activity.
    expect(reportIndex).toBeLessThan(actionsIndex);
    expect(actionsIndex).toBeLessThan(activityIndex);
  });

  // Scenario 5: applicable approval after its initial load settles.
  it("an applicable approval surface appears only after its load settles, positioned after Suggested actions", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredApproval = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({
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
          }),
        }),
      )
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockImplementationOnce(() => deferredApproval.promise);

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await screen.findByText("Suggested actions");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Review actions" })).toBeNull();

    const suggestedActionsHeading = screen.getByRole("heading", { name: "Suggested actions" });

    deferredApproval.resolve(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    const approveButton = await screen.findByRole("button", { name: "Approve" });
    const banner = screen.getByRole("link", { name: "Review actions" });

    // In the Milestone-10 flat flow the banner precedes Suggested actions;
    // the approval control still follows it.
    expect(suggestedActionsHeading.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(suggestedActionsHeading.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Scenario 6: full final order with a non-empty-action approval fixture.
  it("verifies the full final order end to end: summary -> progress -> report -> actions -> activity", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({
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
          }),
        }),
      )
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    const approveButton = await screen.findByRole("button", { name: "Approve" });
    const order = headingOrder();
    const summaryIndex = order.indexOf("Elevated error rate");
    const progressIndex = order.indexOf("Investigation progress");
    const reportIndex = order.indexOf("Resolution report");
    const actionsIndex = order.indexOf("Suggested actions");
    const activityIndex = order.indexOf("Agent activity");

    expect([summaryIndex, progressIndex, reportIndex, actionsIndex, activityIndex].every((i) => i !== -1)).toBe(true);
    expect(summaryIndex).toBeLessThan(progressIndex);
    expect(progressIndex).toBeLessThan(reportIndex);
    expect(reportIndex).toBeLessThan(actionsIndex);
    expect(actionsIndex).toBeLessThan(activityIndex);

    const suggestedActionsHeading = screen.getByRole("heading", { name: "Suggested actions" });
    expect(suggestedActionsHeading.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
