import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * The live demo access token's LIFETIME, as a property of the app.
 *
 * The token authorizes exactly one run. It used to be copied into App's
 * `activeRunRequest` state so "Retry Run" could reuse it, which meant a shared
 * credential lived in component state for the whole session — surviving
 * completed runs, failed runs, and switching back to FAKE. These tests assert
 * the opposite: after any terminal outcome, no copy of the token remains
 * anywhere the app can reach, and a live retry has to start from the form.
 */

const TOKEN = "demo-token-do-not-use-8f14e45fceea";
const UUID_A = "11111111-1111-1111-1111-111111111111";
const HEADER = "X-OpsPilot-Demo-Token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function capabilitiesResponse(): Response {
  // The only posture in which the LIVE option and its token field are offered.
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function jobResponse(): AgentJobResponse {
  return {
    id: "job-1",
    ticketId: `DEMO-${UUID_A}`,
    summary: "Elevated error rate on billing",
    createdAt: "2026-07-30T10:00:00.000Z",
  };
}

function liveRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "LIVE",
      estimatedCostUsd: "0.017956",
      modelIdentifier: "claude-sonnet-5",
      startedAt: "2026-07-30T10:00:00.000Z",
      finishedAt: "2026-07-30T10:00:12.000Z",
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "SERVICE_DEGRADATION",
        summary: "A diagnostic check was performed.",
        rootCause: "Upstream latency.",
        customerImpact: "Slow responses.",
        recommendedResolution: "Scale the upstream pool.",
        confidence: 0.6,
        evidence: [
          { evidenceId: "job-1-call-1", sourceType: "TOOL_EXECUTION", finding: "get_service_status completed." },
        ],
        suggestedActions: [],
      },
    },
  };
}

function approvalView(): ApprovalView {
  return { runId: "run-1", status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null };
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, requestId: "req-1" } };
}

/**
 * Routes `/v1/capabilities` separately from the investigation endpoints.
 *
 * Capabilities are now refreshed at several lifecycle points — mount, both LIVE
 * preflights, every terminal outcome, focus/visibility — so a strictly ordered
 * response queue would make every investigation assertion depend on exactly how
 * many refreshes happened to fire. Routing by URL keeps the behavioural checks
 * (which job, which run, which header) exact while letting capability traffic
 * vary independently, which is what the refresh is for.
 *
 * `responses` are the NON-capability responses, still consumed strictly in
 * order. `capabilityQueue` supplies capability answers in order and then falls
 * back to `capabilityFallback` forever, so a test only has to describe the
 * changes it cares about.
 */
let capabilityQueue: (Response | Promise<Response>)[] = [];
let capabilityFallback: () => Response = () => capabilitiesResponse();

function setCapabilities(queue: (Response | Promise<Response>)[], fallback?: () => Response) {
  capabilityQueue = [...queue];
  if (fallback) capabilityFallback = fallback;
}

// Investigation polling (#38) starts concurrently with every submit/retry
// this file exercises and issues its own GET these tests never queue a
// response for. Routed to its own harmless fallback (404 — polling stops
// immediately), the same way capability traffic gets its own queue+fallback.
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
  // Two parameters, so `call[1]` (the RequestInit) stays typed at the call sites.
  const fetchMock = vi.fn((input: unknown, _init?: unknown) => {
    if (String(input) === "/v1/capabilities") {
      return Promise.resolve(capabilityQueue.shift() ?? capabilityFallback());
    }
    if (String(input).endsWith("/investigation")) return Promise.resolve(pollFallbackResponse());
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected request: ${String(input)}`);
    }
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Capability reads only — asserted separately from investigation traffic. */
function capabilityCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/v1/capabilities");
}

/** Everything that is NOT a capability read AND NOT investigation polling (#38). */
function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]) !== "/v1/capabilities" && !String(call[0]).endsWith("/investigation"),
  );
}

function runRequestCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]).includes("/runs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function headerOf(call: unknown[]): string | undefined {
  const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  return headers?.[HEADER];
}

const user = () => userEvent.setup();

async function selectLive(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole("radio", { name: /Live Claude/ }));
}

async function submitLive(u: ReturnType<typeof userEvent.setup>, token = TOKEN) {
  await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
  await selectLive(u);
  await u.type(screen.getByLabelText("Live demo access token"), token);
  await u.click(screen.getByRole("button", { name: "Run Investigation" }));
}

afterEach(() => {
  capabilityQueue = [];
  capabilityFallback = () => capabilitiesResponse();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("live access token lifetime", () => {
  it("sends the token as a header on the LIVE run request", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));

    expect(headerOf(runRequestCalls(fetchMock)[0]!)).toBe(TOKEN);
  });

  it("clears the token field once a successful run completes", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));

    // The field is the only place a token ever lived; emptying it is what makes
    // "no copy survives the run" observable from the outside.
    await waitFor(() =>
      expect(screen.getByLabelText("Live demo access token")).toHaveValue(""),
    );
  });

  it("clears the token field after a terminal failure too", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByText("Live agent runs are currently disabled.");

    // A failed run is exactly the case where a retained token would be most
    // tempting to reuse — and most wrong to keep.
    await waitFor(() =>
      expect(screen.getByLabelText("Live demo access token")).toHaveValue(""),
    );
  });

  it("offers no Retry Run button after a failed LIVE run, explaining why", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByText("Live agent runs are currently disabled.");

    // The job exists and the run does not — the exact state that shows Retry Run
    // for FAKE. For LIVE there is no token to retry with, so the app offers its
    // dedicated retry mode rather than a button that would earn a 401.
    expect(screen.queryByRole("button", { name: "Retry Run" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeInTheDocument();
  });

  it("still offers Retry Run after a failed FAKE run, which needs no credential", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      jsonResponse(201, { data: { ...liveRunDetail(), run: { ...liveRunDetail().run, providerMode: "FAKE" } } }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByText("The database is temporarily unavailable.");

    await u.click(screen.getByRole("button", { name: "Retry Run" }));
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(2));

    // Same mode as the original, and no token header on either request.
    expect(JSON.parse(String((runRequestCalls(fetchMock)[1]![1] as RequestInit).body))).toEqual({
      providerMode: "FAKE",
    });
    expect(headerOf(runRequestCalls(fetchMock)[1]!)).toBeUndefined();
  });

  it("clears the token when the user switches back to FAKE", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: { ...liveRunDetail(), run: { ...liveRunDetail().run, providerMode: "FAKE" } } }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("radio", { name: /Demo — FAKE/ }));

    // The field is gone from the DOM, and the value did not survive to be sent.
    expect(screen.queryByLabelText("Live demo access token")).toBeNull();

    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));

    expect(headerOf(runRequestCalls(fetchMock)[0]!)).toBeUndefined();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(TOKEN);
  });

  it("re-selecting LIVE after a completed run starts from an empty token field", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText("Live demo access token")).toHaveValue(""));

    // With no token, the form refuses to submit rather than spending a round trip
    // to be told 401 — which also proves nothing was silently kept to fall back on.
    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled();
  });

  it("never writes the token to storage, a URL, or a request body", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain(TOKEN);
      const body = (call[1] as RequestInit | undefined)?.body;
      if (body !== undefined && body !== null) expect(String(body)).not.toContain(TOKEN);
    }
    // The one and only place it appears: the header of the LIVE run request.
    expect(headerOf(runRequestCalls(fetchMock)[0]!)).toBe(TOKEN);
  });
});
