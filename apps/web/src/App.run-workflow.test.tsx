import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const RESUME_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    trace: [
      { type: "TOOL_REQUESTED", toolCallId: "job-1-call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "job-1-call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "A diagnostic check was performed.",
        rootCause: "No root cause could be established.",
        customerImpact: "No customer impact could be established.",
        recommendedResolution: "Further diagnostic action is required.",
        confidence: 0.5,
        evidence: [{ evidenceId: "job-1-call-1", sourceType: "TOOL_EXECUTION", finding: "get_service_status completed.", supports: [] }],
        suggestedActions: [],
      },
    },
    ...overrides,
  };
}

// PR 4B: every successful run triggers a chained approval GET (App.tsx's
// runInvestigation/retryRun/refreshRun). These PR 4A tests don't assert on
// approval state — approval.test.tsx owns that — but a successful run mock
// chain needs one more response, or the extra fetch call resolves to
// `undefined` and surfaces a spurious error banner.
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

async function submit(user: ReturnType<typeof userEvent.setup>, summary: string) {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
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

/**
 * Investigation polling (#38) starts concurrently with every submit/retry
 * this file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), and
 * `apiCalls()` above excludes it from every request-sequence assertion.
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

// Investigation polling (#38) starts concurrently with every submit/retry
// this file exercises and issues its own GET against a THIRD, distinct URL
// pattern — excluded here for the same reason `/v1/capabilities` already is:
// every assertion below is about the job/run/approval workflow request
// sequence, not about polling, which this file never queues a response for
// beyond the harmless 404 fallback below.
function apiCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities" && !String(call[0]).endsWith("/investigation"));
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App investigation workflow", () => {
  it("one click calls POST job then POST run, in that order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Agent activity");

    const calls = apiCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toBe("/v1/agent-jobs");
    expect(calls[1]?.[0]).toBe("/v1/agent-jobs/job-1/runs");
    expect(calls[2]?.[0]).toBe("/v1/agent-runs/run-1/approval");
  });

  it("ordinary mode sends exactly DEMO-<stubbed UUID>", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Agent activity");

    const firstCallInit = apiCalls()[0]?.[1];
    expect(firstCallInit?.body).toBe(JSON.stringify({ ticketId: `DEMO-${UUID_A}`, summary: "Elevated error rate" }));
  });

  it("two ordinary submissions use two distinct deterministic UUIDs", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");

    // Milestone-10 composer collapse: once a job exists the fresh-submission
    // form is hidden, so a second ordinary submission is exercised as a second
    // page-load/session — each still mints one deterministic UUID from
    // `randomUUID`.
    uuidSpy.mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ id: "job-1", ticketId: `DEMO-${UUID_A}` }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-1" }) }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(userEvent.setup(), "First reported issue");
    await screen.findByText("Agent activity");
    const firstTicketId = apiCalls()[0]?.[1]?.body as string;

    cleanup();
    uuidSpy.mockReturnValueOnce(UUID_B);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ id: "job-2", ticketId: `DEMO-${UUID_B}` }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-2" }) }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(userEvent.setup(), "Second reported issue");
    await screen.findByText("Agent activity");
    const secondTicketId = apiCalls()[3]?.[1]?.body as string;

    expect(firstTicketId).toContain(UUID_A);
    expect(secondTicketId).toContain(UUID_B);
    expect(firstTicketId).not.toBe(secondTicketId);
  });

  it("approval-demo mode sends exactly TICKET-APPROVAL-DEMO", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submit(user, "Approval demo issue");
    await screen.findByText("Agent activity");

    const firstCallInit = apiCalls()[0]?.[1];
    expect(firstCallInit?.body).toBe(JSON.stringify({ ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval demo issue" }));
  });

  it("renders no editable Ticket ID field, and shows the ticket/job/run IDs as read-only metadata", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Agent activity");

    expect(screen.queryByRole("textbox", { name: /ticket/i })).toBeNull();
    expect(screen.getByText(`DEMO-${UUID_A}`).tagName).toBe("DD");
    expect(screen.getByText("job-1").tagName).toBe("DD");
    expect(screen.getByText("run-1").tagName).toBe("DD");
  });

  it("preserves trace response order in the rendered timeline", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Agent activity");

    const items = screen.getAllByRole("listitem").filter((item) => item.className.includes("trace-timeline-item"));
    expect(items[0]).toHaveTextContent("Checking service status");
    expect(items[1]).toHaveTextContent("Checked service status");
    expect(items[2]).toHaveTextContent("Resolution report generated");
  });

  it("an ordinary run's report renders no Suggested actions section at all", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Agent activity");

    // An empty suggestedActions array means the entire
    // Suggested actions section is absent, not an empty-state message.
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByText("Draft customer reply")).toBeNull();
  });

  it("an approval-demo run's report has exactly one DRAFT_CUSTOMER_REPLY card", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const demoRun = runDetail({
      outcome: {
        type: "COMPLETED",
        report: {
          category: "UNKNOWN",
          summary: "s",
          rootCause: "r",
          customerImpact: "c",
          recommendedResolution: "rr",
          confidence: 0.5,
          evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "f", supports: [] }],
          suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." }, groundedBy: [] }],
        },
      },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRun }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submit(user, "Approval demo issue");
    await screen.findByText("Agent activity");

    expect(screen.getAllByText("Draft customer reply")).toHaveLength(1);
    expect(screen.getByText("Update")).toBeInTheDocument();
  });

  it("a job-creation failure shows the error and makes no run request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The request body failed validation.");
    expect(apiCalls()).toHaveLength(1);
    expect(screen.queryByText("Investigation")).toBeNull();
    expect(screen.queryByText("Agent activity")).toBeNull();
  });

  it("a run-creation failure retains job metadata and exposes Retry Run, which retries only POST /runs", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The database is temporarily unavailable.");
    expect(screen.getByText("job-1").tagName).toBe("DD");
    const retryButton = screen.getByRole("button", { name: "Retry Run" });
    expect(retryButton).toBeInTheDocument();

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    await user.click(retryButton);
    await screen.findByText("Agent activity");

    const calls = apiCalls();
    expect(calls).toHaveLength(4);
    expect(calls[2]?.[0]).toBe("/v1/agent-jobs/job-1/runs");
    expect(calls[3]?.[0]).toBe("/v1/agent-runs/run-1/approval");
    expect(calls.filter((call) => call[0] === "/v1/agent-jobs")).toHaveLength(1);
  });

  it("a new investigation clears the prior job, run, and error state before the new one resolves", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");

    // Milestone-10 composer collapse: the fresh form only coexists with an
    // existing job in the job-only resume state (`resumedJobOnly`). Mount a
    // job-only resume so the "start a new investigation" flow that clears the
    // prior job is reachable.
    window.history.pushState(null, "", `?job=${RESUME_JOB_ID}`);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { job: jobResponse({ id: RESUME_JOB_ID }), run: null, trace: [], outcome: null, events: [] },
        }),
      )
      .mockResolvedValueOnce(pollFallbackResponse());

    render(<App />);
    await screen.findByText(RESUME_JOB_ID);
    expect(screen.queryByText("Agent activity")).toBeNull();

    let resolveSecondJob!: (value: Response) => void;
    const pendingSecondJob = new Promise<Response>((resolve) => {
      resolveSecondJob = resolve;
    });
    uuidSpy.mockReturnValueOnce(UUID_B);
    vi.mocked(fetch).mockImplementationOnce(() => pendingSecondJob);

    await user.type(screen.getByLabelText("Issue Summary"), "Second reported issue");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await waitFor(() => expect(screen.queryByText(RESUME_JOB_ID)).toBeNull());

    resolveSecondJob(jsonResponse(201, { data: jobResponse({ id: "job-2", ticketId: `DEMO-${UUID_B}` }) }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-2" }) }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    await screen.findByText("job-2");
  });

  it("a network failure renders an actionable, safe message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse()).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText(/Could not reach the OpsPilot API/);
    expect(document.body.textContent).not.toContain("TypeError");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("a malformed response body renders a safe UNEXPECTED_RESPONSE message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse()).mockResolvedValueOnce(new Response("<html>not json</html>", { status: 500 }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The server returned an unexpected response.");
    expect(document.body.textContent).not.toContain("<html>");
  });

  it("renders a FAILED outcome with its code and message, and no suggested-actions section", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({ outcome: { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." } }),
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("RETRIEVAL_FAILED");
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    expect(screen.queryByText(/Suggested actions/)).toBeNull();
  });

  // A RUNNING outcome must never render an empty Generated
  // report panel. Agent activity still shows (trace data exists, even if
  // empty), and the pre-existing InvestigationSummary Refresh button — not a
  // second ReportPanel-owned one — is the only refresh affordance.
  it("renders a RUNNING outcome with no Resolution report panel, and a working Refresh", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      // A RUNNING outcome never triggers the approval fetch — no fourth
      // mocked response is consumed here.
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ outcome: { type: "RUNNING" } }) }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("Agent activity");
    expect(screen.queryByText("Resolution report")).toBeNull();
    expect(screen.queryByText("This run has not produced a report yet.")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await screen.findByText("Resolution report");
    expect(screen.queryByText("Suggested actions")).toBeNull();
  });

  it("a rapid double-click produces exactly one workflow submission", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate");
    await user.dblClick(screen.getByRole("button", { name: "Start Investigation" }));

    await screen.findByText("Agent activity");
    expect(apiCalls()).toHaveLength(3);
    expect(apiCalls().filter((call) => call[0] === "/v1/agent-jobs")).toHaveLength(1);
  });
});
