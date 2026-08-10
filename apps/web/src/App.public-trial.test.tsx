import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";
import { getTurnstileClient, type TurnstileRenderOptions } from "./turnstile/turnstile-client";

/**
 * Issue #39 — the PUBLIC LIVE trial's frontend surface: the Turnstile
 * challenge replaces the private token field, submission carries
 * `X-OpsPilot-Turnstile-Token`, an exhausted visitor allowance disables LIVE
 * with an explicit (never automatic) FAKE offer, and the private token path
 * stays completely untouched by any of it.
 *
 * `getTurnstileClient` is mocked directly — no real script load, no network
 * call, matching the frozen plan's test-matrix requirement.
 */
vi.mock("./turnstile/turnstile-client", () => ({
  getTurnstileClient: vi.fn(),
}));

const SITE_KEY = "turnstile-site-key-test";
const TURNSTILE_TOKEN = "solved-turnstile-token";
const TURNSTILE_HEADER = "X-OpsPilot-Turnstile-Token";
const DEMO_TOKEN_HEADER = "X-OpsPilot-Demo-Token";
const UUID_A = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function publicTrialCapabilitiesResponse(visitorRunsRemaining: 0 | 1 = 1): Response {
  return jsonResponse(200, {
    data: {
      liveAgentRuns: "AVAILABLE",
      liveAccess: "PUBLIC_TRIAL",
      visitorRunsRemaining,
      turnstileSiteKey: SITE_KEY,
    },
  });
}

function privateCapabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function jobResponse(): AgentJobResponse {
  return {
    id: "job-1",
    ticketId: `DEMO-${UUID_A}`,
    summary: "Elevated error rate on billing",
    createdAt: "2026-08-01T10:00:00.000Z",
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
      startedAt: "2026-08-01T10:00:00.000Z",
      finishedAt: "2026-08-01T10:00:12.000Z",
      createdAt: "2026-08-01T10:00:00.000Z",
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

let capabilityQueue: (Response | Promise<Response>)[] = [];
let capabilityFallback: () => Response = () => publicTrialCapabilitiesResponse();

function setCapabilities(queue: (Response | Promise<Response>)[], fallback?: () => Response) {
  capabilityQueue = [...queue];
  if (fallback) capabilityFallback = fallback;
}

function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
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

function runRequestCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]).includes("/runs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined) ?? {};
}

/** A fake `window.turnstile`-backed client, with hooks to fire its callbacks directly. */
function fakeTurnstileClient() {
  let solved: ((token: string) => void) | null = null;
  let expired: (() => void) | null = null;
  let errored: (() => void) | null = null;

  const client = {
    render: vi.fn((_container: HTMLElement, options: TurnstileRenderOptions) => {
      solved = options.callback;
      expired = options["expired-callback"];
      errored = options["error-callback"];
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };

  return {
    client,
    solve: (token = TURNSTILE_TOKEN) => solved?.(token),
    expire: () => expired?.(),
    error: () => errored?.(),
  };
}

const user = () => userEvent.setup();

async function selectLive(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole("radio", { name: /Live Claude/ }));
}

afterEach(() => {
  capabilityQueue = [];
  capabilityFallback = () => publicTrialCapabilitiesResponse();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PUBLIC_TRIAL capabilities: token field hidden, Turnstile rendered", () => {
  it("hides the private token field and renders the Turnstile widget instead", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await selectLive(u);

    expect(screen.queryByLabelText("Live demo access token")).toBeNull();
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    expect(fake.client.render.mock.calls[0]?.[1]).toMatchObject({ sitekey: SITE_KEY });
  });

  it("keeps submit disabled until the mocked client reports a solved token", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled();

    fake.solve();

    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());
  });

  it("submits with X-OpsPilot-Turnstile-Token and no demo-token header", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));
    const headers = headersOf(runRequestCalls(fetchMock)[0]!);
    expect(headers[TURNSTILE_HEADER]).toBe(TURNSTILE_TOKEN);
    expect(headers[DEMO_TOKEN_HEADER]).toBeUndefined();
  });

  it("enforces the stricter 300-character PUBLIC ceiling, not the private 2000", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await selectLive(u);
    await u.type(screen.getByLabelText("Issue Summary"), "a".repeat(301));

    expect(screen.getByText(/Maximum 300 characters/)).toBeInTheDocument();
  });
});

describe("visitorRunsRemaining: 0 — LIVE disabled, explicit FAKE offer, no auto-fallback", () => {
  it("disables the LIVE radio with a distinct exhausted-trial message", async () => {
    mockFetch();
    setCapabilities([], () => publicTrialCapabilitiesResponse(0));
    render(<App />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeDisabled());
    expect(screen.getByText(/already used today's live trial run/i)).toBeInTheDocument();
  });

  it("never switches the radio to FAKE automatically — FAKE stays merely selectable", async () => {
    mockFetch();
    setCapabilities([], () => publicTrialCapabilitiesResponse(0));
    render(<App />);

    await waitFor(() => expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeDisabled());

    // FAKE was never auto-selected on the visitor's behalf — it is exactly
    // where an ordinary page load leaves it, a click away, not pre-clicked.
    expect(screen.getByRole("radio", { name: /Demo — FAKE/ })).toBeChecked();
  });

  it("refuses LIVE submission when the submission-time refresh shows visitorRunsRemaining 0", async () => {
    // Initial page load: remaining 1 → LIVE is enabled. Submission-time
    // refresh: remaining 0 → preflight refuses before creating the job.
    // queue[0] serves the initial page load; the fallback serves
    // refreshCapabilities() at submission time.
    setCapabilities(
      [publicTrialCapabilitiesResponse(1)],
      () => publicTrialCapabilitiesResponse(0),
    );
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    // No createAgentJob or startAgentRun responses — neither may be called.
    const fetchMock = mockFetch();
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    // The exhausted notice is shown — no job was created, no run was started.
    await screen.findByText(/Your live trial run for today has already been used/);
    // FAKE is not auto-selected.
    expect(screen.getByRole("radio", { name: /Demo — FAKE/ })).not.toBeChecked();
    // Neither createAgentJob nor startAgentRun was called.
    const runCalls = runRequestCalls(fetchMock);
    expect(runCalls).toHaveLength(0);
  });
});

describe("a 429 mid-submission offers FAKE without auto-fallback", () => {
  it("shows the same opaque unavailable notice and never auto-retries as FAKE", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(429, errorEnvelope("LIVE_RUN_VISITOR_QUOTA_EXHAUSTED", "Your live trial run for today has already been used.")),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Your live trial run for today has already been used.");

    // No PUBLIC retry mechanism exists — unlike the private path, no
    // "Recover Live Run" banner ever appears for this failure.
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    // FAKE remains the ordinary, user-initiated alternative — never triggered
    // by this component.
    expect(screen.getByRole("radio", { name: /Demo — FAKE/ })).not.toBeChecked();
  });
});

describe("expired or failed Turnstile solve requires a fresh solve before submit re-enables", () => {
  it("clears the held token and disables submit again on expiry", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());

    fake.expire();

    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled());
  });

  it("clears the held token and disables submit again on a widget error", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());

    fake.error();

    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled());
  });

  it("re-enables submit once a fresh solve arrives after expiry", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await waitFor(() => expect(fake.client.render).toHaveBeenCalledTimes(1));
    fake.solve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());

    fake.expire();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled());

    fake.solve("second-solved-token");
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).not.toBeDisabled());
  });
});

describe("the private token path never renders Turnstile and never sends its header", () => {
  it("renders the token field, not the Turnstile widget", async () => {
    const fake = fakeTurnstileClient();
    vi.mocked(getTurnstileClient).mockReturnValue(fake.client);
    mockFetch();
    setCapabilities([], () => privateCapabilitiesResponse());
    render(<App />);
    const u = user();

    await selectLive(u);

    expect(screen.getByLabelText("Live demo access token")).toBeInTheDocument();
    expect(fake.client.render).not.toHaveBeenCalled();
  });

  it("never sends X-OpsPilot-Turnstile-Token on a private LIVE submission", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    setCapabilities([], () => privateCapabilitiesResponse());
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await selectLive(u);
    await u.type(screen.getByLabelText("Live demo access token"), "demo-token-do-not-use-8f14e45fceea");
    const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await waitFor(() => expect(runRequestCalls(fetchMock)).toHaveLength(1));
    expect(headersOf(runRequestCalls(fetchMock)[0]!)[TURNSTILE_HEADER]).toBeUndefined();
  });
});
