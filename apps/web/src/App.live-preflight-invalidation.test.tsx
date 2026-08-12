import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse } from "./api/types";

/**
 * Focused coverage for independent-review Finding 2: a new LIVE submission
 * must invalidate the PREVIOUS workflow (main generation, capability
 * request, poll session, terminal claim) BEFORE display reset and BEFORE
 * the LIVE preflight — never after — so a still-active previous poll cannot
 * repopulate the freshly-reset display while the (possibly slow) preflight
 * is in flight, and remains stopped even if LIVE access is refused.
 */

const JOB_A_ID = "job-a";
const JOB_B_ID = "job-b";
const TOKEN = "demo-token-do-not-use-8f14e45fceea";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jobResponse(id: string, summary: string): AgentJobResponse {
  return { id, ticketId: `DEMO-${id}`, summary, createdAt: "2026-07-23T10:00:00.000Z" };
}

function runningRunDetail(jobId: string, summary: string) {
  return {
    job: jobResponse(jobId, summary),
    run: {
      id: `run-${jobId}`,
      jobId,
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: jobId === JOB_A_ID ? "FAKE" : "LIVE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-07-23T10:00:00.000Z",
      estimatedCostUsd: null,
    },
    trace: [],
    outcome: { type: "RUNNING" as const },
  };
}

function liveCapabilities(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function unavailableCapabilities(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

function investigationStateResponse(jobId: string, summary: string): Response {
  const detail = runningRunDetail(jobId, summary);
  return jsonResponse(200, { data: { job: detail.job, run: detail.run, trace: detail.trace, outcome: detail.outcome, events: [] } });
}

function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface MockFetchOptions {
  /** Consumed, in order, for EVERY GET /v1/capabilities call (mount + every preflight). */
  readonly capabilities: (Response | Promise<Response>)[];
  readonly investigationJobA?: (Response | Promise<Response>)[];
}

function mockFetch(options: MockFetchOptions) {
  const capQueue = [...options.capabilities];
  const investigationAQueue = [...(options.investigationJobA ?? [])];
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      const next = capQueue.shift();
      if (next === undefined) throw new Error("capabilities queue exhausted");
      return Promise.resolve(next);
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      const body = JSON.parse(String((init as RequestInit).body));
      const id = body.summary.includes("job A") ? JOB_A_ID : JOB_B_ID;
      return Promise.resolve(jsonResponse(201, { data: jobResponse(id, body.summary) }));
    }
    if (url === `/v1/agent-jobs/${JOB_A_ID}/runs` && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: runningRunDetail(JOB_A_ID, "job A investigation, elevated") }));
    }
    if (url === `/v1/agent-jobs/${JOB_B_ID}/runs` && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: runningRunDetail(JOB_B_ID, "job B investigation, elevated") }));
    }
    if (url === `/v1/agent-jobs/${JOB_A_ID}/investigation`) {
      const next = investigationAQueue.shift();
      if (next === undefined) return Promise.resolve(jsonResponse(404, { error: { code: "AGENT_JOB_NOT_FOUND", message: "n/a", requestId: "req-1" } }));
      return Promise.resolve(next);
    }
    if (url === `/v1/agent-jobs/${JOB_B_ID}/investigation`) {
      // Harmless placeholder: job B's own poll is not under test here, and a
      // 404 fallback would be indistinguishable from "job B not found" —
      // incorrectly triggering Finding 4's not-found reset against job B's
      // own, current (non-stale) workflow generation.
      return Promise.resolve(investigationStateResponse(JOB_B_ID, "job B investigation, elevated"));
    }
    if (url.endsWith("/investigation")) {
      return Promise.resolve(jsonResponse(404, { error: { code: "AGENT_JOB_NOT_FOUND", message: "n/a", requestId: "req-1" } }));
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function investigationJobACalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === `/v1/agent-jobs/${JOB_A_ID}/investigation`);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LIVE preflight invalidates the previous poll session (Finding 2)", () => {
  it("job A actively polling → new LIVE submission with a delayed preflight: the old poll is stopped immediately and a late job-A response cannot repopulate state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredJobATick = deferredResponse();
    const deferredPreflight = deferredResponse();
    const fetchMock = mockFetch({
      // mount -> AVAILABLE; the popstate reset below re-reads capabilities
      // (second AVAILABLE); job B's LIVE preflight is the deferred one.
      capabilities: [liveCapabilities(), liveCapabilities(), deferredPreflight.promise],
      investigationJobA: [deferredJobATick.promise],
    });

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "job A investigation, elevated error rate");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    await screen.findByText("job-a");

    // job A's poll fires its first tick — leave it in flight (deferred).
    await vi.advanceTimersByTimeAsync(0);
    expect(investigationJobACalls(fetchMock)).toHaveLength(1);

    // Milestone-10: the composer collapses once a real job exists, so there
    // is no form to type job B into while job A runs. Leaving the resumed
    // `?job=` view (popstate to "/") is how the fresh-submission form returns;
    // that reset itself invalidates job A's poll before the new submission.
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Live/ })).toBeEnabled());

    // Start a NEW LIVE submission while job A's tick is still in flight.
    await user.type(screen.getByLabelText("Issue Summary"), "job B investigation, elevated error rate");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    // The display already shows job B's own workflow — job A is gone.
    expect(screen.queryByText("job-a")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking Live availability…");

    // job A's late poll tick now resolves — it must be silently discarded
    // by the poll hook itself (already stopped), never reaching App state.
    deferredJobATick.resolve(investigationStateResponse(JOB_A_ID, "job A investigation, elevated"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText("job-a")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking Live availability…");

    // Now the LIVE preflight resolves AVAILABLE — job B proceeds normally.
    deferredPreflight.resolve(liveCapabilities());
    await screen.findByText("job-b");
    expect(screen.queryByText("job-a")).toBeNull();
  });

  it("job A actively polling → new LIVE submission whose preflight refuses: the old poll remains stopped, job A is never restored, and the LIVE-unavailable notice is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredJobATick = deferredResponse();
    const deferredPreflight = deferredResponse();
    const fetchMock = mockFetch({
      // mount -> AVAILABLE; the popstate reset below re-reads capabilities
      // (second AVAILABLE); job B's LIVE preflight is the deferred one.
      capabilities: [liveCapabilities(), liveCapabilities(), deferredPreflight.promise],
      investigationJobA: [deferredJobATick.promise],
    });

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "job A investigation, elevated error rate");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    await screen.findByText("job-a");

    await vi.advanceTimersByTimeAsync(0);
    expect(investigationJobACalls(fetchMock)).toHaveLength(1);

    // Milestone-10: the composer collapsed when job A's real job appeared.
    // Leave the resumed `?job=` view so the fresh-submission form returns;
    // that reset itself invalidates job A's poll before the new submission.
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Live/ })).toBeEnabled());

    await user.type(screen.getByLabelText("Issue Summary"), "job B investigation, elevated error rate");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));
    expect(screen.queryByText("job-a")).toBeNull();

    // The preflight refuses LIVE access.
    deferredPreflight.resolve(unavailableCapabilities());
    await screen.findByText("Live is temporarily unavailable. No investigation job was created.");
    expect(screen.queryByText("job-a")).toBeNull();

    // job A's poll remains stopped permanently — advancing time further
    // produces no additional job-A investigation calls, whether or not its
    // one in-flight tick ever resolves.
    deferredJobATick.resolve(investigationStateResponse(JOB_A_ID, "job A"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationJobACalls(fetchMock)).toHaveLength(1);
    expect(screen.queryByText("job-a")).toBeNull();
  });
});
