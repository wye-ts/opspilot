import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * One canonical stage-label source for the sole
 * `role="status"` live region. Exact text asserted for every stage, terminal
 * success, and stage-specific failure; elapsed-timer ticks must never alter
 * the live-region text.
 */

const UUID_A = "11111111-1111-1111-1111-111111111111";
const TOKEN = "demo-token-do-not-use-8f14e45fceea";

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

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function fakeCapabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

function liveCapabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

/**
 * Investigation polling (#38) starts concurrently with every submit/retry
 * this file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), which is
 * invisible to every assertion in this file (none inspect polling state).
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
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

function statusRegion(): HTMLElement {
  return screen.getByRole("status");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Sole live-region text uses the canonical stage-label source", () => {
  it("LIVE availability: exact text while the preflight is in flight", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredPreflight = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(liveCapabilitiesResponse()).mockImplementationOnce(() => deferredPreflight.promise);

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    expect(statusRegion()).toHaveTextContent("Checking Live availability…");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    deferredPreflight.resolve(liveCapabilitiesResponse());
  });

  it("job creation: exact text while POST /v1/agent-jobs is in flight", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);

    expect(statusRegion()).toHaveTextContent("Creating investigation…");
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
  });

  it("run request: exact text while POST .../runs is in flight", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredRun = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockImplementationOnce(() => deferredRun.promise);

    render(<App />);
    await submit(user);
    await waitFor(() => expect(statusRegion()).toHaveTextContent("Agent investigation in progress…"));
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    deferredRun.resolve(jsonResponse(201, { data: runDetail() }));
  });

  it("initial approval load: exact text while GET .../approval is in flight", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredApproval = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockImplementationOnce(() => deferredApproval.promise);

    render(<App />);
    await submit(user);
    await waitFor(() => expect(statusRegion()).toHaveTextContent("Loading approval state…"));
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    deferredApproval.resolve(jsonResponse(200, { data: approvalView() }));
  });

  it("terminal success: exact text with and without an applicable approval", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submit(user);
    await waitFor(() => expect(statusRegion()).toHaveTextContent("Investigation complete."));
    expect(statusRegion()).not.toHaveTextContent("Human approval required.");
  });

  it("terminal success with an applicable (PENDING) approval: exact composed text", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    // The Approval workflow demo checkbox is gone — approval-demo mode is a
    // URL deep link read once at App mount.
    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await waitFor(() => expect(statusRegion()).toHaveTextContent("Investigation complete. Human approval required."));
  });

  it("stage-specific failure: job creation", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user);

    await waitFor(() => expect(statusRegion()).toHaveTextContent("Investigation failed while creating the investigation."));
    // The concise stage-specific text, never the raw server message, in the
    // live region — the raw message stays in the separate role="alert" banner.
    expect(statusRegion()).not.toHaveTextContent("REQUEST_BODY_INVALID");
  });

  it("stage-specific failure: run request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);

    await waitFor(() => expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation."));
  });

  it("stage-specific failure: LIVE availability refusal", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch).mockResolvedValueOnce(liveCapabilitiesResponse()).mockResolvedValueOnce(fakeCapabilitiesResponse());

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await waitFor(() => expect(statusRegion()).toHaveTextContent("Live is temporarily unavailable. No investigation job was created."));
  });

  it("elapsed-timer ticks never alter the live-region text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredRun = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockImplementationOnce(() => deferredRun.promise);

    render(<App />);
    await submit(user);
    await waitFor(() => expect(statusRegion()).toHaveTextContent("Agent investigation in progress…"));

    const textBefore = statusRegion().textContent;
    await vi.advanceTimersByTimeAsync(5000);
    const textAfter = statusRegion().textContent;

    expect(textAfter).toBe(textBefore);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    deferredRun.resolve(jsonResponse(201, { data: runDetail() }));
  });
});
