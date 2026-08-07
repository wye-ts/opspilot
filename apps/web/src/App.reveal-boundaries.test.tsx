import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * Data-driven reveal boundaries only (no timers/animation):
 *
 *   submission starts               -> submitted summary + Investigation progress
 *   run data exists                 -> Agent activity may render
 *   run is terminal and has report  -> Generated report may render
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
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

function headingOrder(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Data-driven reveal boundaries", () => {
  // Scenario 1: unresolved job/run.
  it("shows only Progress while job/run are unresolved — Agent activity, Report, Actions, and Approval are absent", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(capabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);

    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();

    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
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
    expect(screen.getByText(/Tool requested/)).toBeInTheDocument();
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
  });

  // Scenario 3: terminal run with a report but empty actions.
  it("terminal run with report but empty actions: Agent activity then Generated report; no Suggested actions; no approval unless applicable", async () => {
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
    await screen.findByText("Generated report");

    const order = headingOrder();
    expect(order.indexOf("Agent activity")).toBeLessThan(order.indexOf("Generated report"));
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // NOT_ELIGIBLE is not "applicable" — no approval decision surface.
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
  });

  // Scenario 4: terminal run with non-empty actions.
  it("terminal run with non-empty actions: Agent activity -> Generated report -> Suggested actions, in DOM order", async () => {
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
    const reportIndex = order.indexOf("Generated report");
    const actionsIndex = order.indexOf("Suggested actions");
    expect(activityIndex).toBeLessThan(reportIndex);
    expect(reportIndex).toBeLessThan(actionsIndex);
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

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByLabelText("Approval workflow demo"));
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Suggested actions");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("link", { name: /action required/i })).toBeNull();

    const suggestedActionsHeading = screen.getByRole("heading", { name: "Suggested actions" });

    deferredApproval.resolve(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    const approveButton = await screen.findByRole("button", { name: "Approve" });
    const banner = screen.getByRole("link", { name: /action required/i });

    // Both the banner and the approval control follow Suggested actions in
    // DOM order.
    expect(suggestedActionsHeading.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(suggestedActionsHeading.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Scenario 6: full final order with a non-empty-action approval fixture.
  it("verifies the full final order end to end: summary -> progress -> activity -> report -> actions -> approval", async () => {
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

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByLabelText("Approval workflow demo"));
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    const approveButton = await screen.findByRole("button", { name: "Approve" });
    const order = headingOrder();
    const summaryIndex = order.indexOf("Submitted issue");
    const progressIndex = order.indexOf("Investigation progress");
    const activityIndex = order.indexOf("Agent activity");
    const reportIndex = order.indexOf("Generated report");
    const actionsIndex = order.indexOf("Suggested actions");

    expect([summaryIndex, progressIndex, activityIndex, reportIndex, actionsIndex].every((i) => i !== -1)).toBe(true);
    expect(summaryIndex).toBeLessThan(progressIndex);
    expect(progressIndex).toBeLessThan(activityIndex);
    expect(activityIndex).toBeLessThan(reportIndex);
    expect(reportIndex).toBeLessThan(actionsIndex);

    const suggestedActionsHeading = screen.getByRole("heading", { name: "Suggested actions" });
    expect(suggestedActionsHeading.compareDocumentPosition(approveButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
