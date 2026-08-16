import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * A second submission must clear the PREVIOUS
 * investigation's visible result immediately, before any request of the new
 * submission (including the LIVE preflight) resolves. Previously the new
 * Progress Timeline snapshot reset immediately but the stale job/run/report/
 * approval only cleared once the preflight succeeded, so a slow or refused
 * preflight showed two investigations on screen at once.
 */

const UUID_A = "11111111-1111-1111-1111-111111111111";
const TOKEN = "demo-token-do-not-use-8f14e45fceea";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Investigation polling (#38) starts concurrently with every submit this
 * file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), which is
 * invisible to every assertion in this file (none inspect polling state).
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, { error: { code: "PERSISTENCE_UNAVAILABLE", message: "not tracked by this test", requestId: "req-1" } });
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return {
    id: "job-1",
    ticketId: "TICKET-APPROVAL-DEMO",
    summary: "First investigation issue",
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
        summary: "First investigation summary",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.5,
        evidence: [],
        suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." }, groundedBy: [] }],
      },
    },
    ...overrides,
  };
}

function approvalView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    runId: "run-1",
    status: "PENDING",
    reviewerName: null,
    note: null,
    decidedAt: null,
    ...overrides,
  };
}

function liveCapabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function unavailableCapabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

/** A response that only resolves once the test explicitly resolves it. */
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("clears the previous investigation's visible result immediately on a second LIVE submission, before and after a refused preflight", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(UUID_A);

  // Capabilities are routed separately from investigation traffic: the
  // popstate reset back to the fresh form refreshes capabilities, and the
  // second submission's preflight is its own (held-open) capability read, so a
  // strict FIFO queue can't predict their exact interleaving with the awaited
  // investigation calls. See App.live-retry.test.tsx for the same pattern.
  const investigationQueue: Response[] = [
    jsonResponse(201, { data: jobResponse() }), // first job
    jsonResponse(201, { data: runDetail() }), // first run
    jsonResponse(200, { data: approvalView() }), // first approval, PENDING
  ];
  const deferredPreflight = deferredResponse();
  const capabilityQueue: (Response | Promise<Response>)[] = [
    liveCapabilitiesResponse(), // mount
    liveCapabilitiesResponse(), // popstate reset back to the fresh form
    deferredPreflight.promise, // second submission's preflight (held open)
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      if (String(input) === "/v1/capabilities") {
        return Promise.resolve(capabilityQueue.shift() ?? liveCapabilitiesResponse());
      }
      if (String(input).endsWith("/investigation")) return Promise.resolve(pollFallbackResponse());
      const next = investigationQueue.shift();
      if (next === undefined) throw new Error(`unexpected request: ${String(input)}`);
      return Promise.resolve(next);
    }),
  );

  // The Approval workflow demo checkbox is gone — approval-demo mode is a
  // URL deep link read once at App mount.
  window.history.replaceState({}, "", "/?approval-demo=1");
  render(<App />);

  // First investigation, FAKE, complete with a rich visible result.
  await user.type(screen.getByLabelText("Issue Summary"), "First investigation issue");
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
  await screen.findByRole("button", { name: "Approve" });
  expect(screen.getByText("job-1")).toBeInTheDocument();
  expect(screen.getByText("First investigation summary")).toBeInTheDocument();
  expect(screen.getByText("Draft customer reply")).toBeInTheDocument();

  // The composer collapses once a job exists — the only way back to a fresh
  // form is to navigate away (popstate to a URL with no ?job=), which resets
  // the display and refreshes capabilities.
  window.history.pushState({}, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByLabelText("Issue Summary");

  // Second investigation: LIVE, with the preflight held open.
  await user.type(screen.getByLabelText("Issue Summary"), "Second investigation issue, live mode");
  await user.click(screen.getByRole("radio", { name: /Live/ }));
  await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));

  // While the preflight is still unresolved: the live region announces the
  // availability check, but every trace of the FIRST investigation is already
  // gone. (The Progress Timeline itself only mounts once a job exists, so it
  // is absent during the preflight too.)
  expect(screen.getByRole("status")).toHaveTextContent("Checking Live availability…");
  expect(screen.queryByText("Investigation progress")).toBeNull();
  expect(screen.queryByText("job-1")).toBeNull();
  expect(screen.queryByText("First investigation summary")).toBeNull();
  expect(screen.queryByText("Draft customer reply")).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByText("Agent activity")).toBeNull();
  expect(screen.queryByText("Resolution report")).toBeNull();

  // Now the preflight resolves as refused. Refusal is NOT a failure: no failed
  // stage, no failed-stage badge, and no Progress Timeline at all (job never
  // created) — the composer stays visible with the user's draft intact.
  deferredPreflight.resolve(unavailableCapabilitiesResponse());
  await screen.findByText("Live is temporarily unavailable. No investigation job was created.");

  // Everything from the first investigation remains absent.
  expect(screen.queryByText("job-1")).toBeNull();
  expect(screen.queryByText("First investigation summary")).toBeNull();
  expect(screen.queryByText("Draft customer reply")).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByText("Agent activity")).toBeNull();
  expect(screen.queryByText("Resolution report")).toBeNull();
  expect(screen.queryByText("Investigation progress")).toBeNull();

  // The composer is still present and the new summary draft is preserved.
  expect(screen.getByLabelText("Issue Summary")).toHaveValue("Second investigation issue, live mode");
  expect(screen.getByRole("button", { name: "Start Investigation" })).toBeInTheDocument();
});

// The new-submission reset must not disturb retained-job recovery, which
// deliberately keeps the existing job and idempotency key.
describe("retained-job recovery is unaffected by beginNewSubmissionDisplay", () => {
  it("a run-creation failure still enters LIVE recovery mode with the job retained", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: `DEMO-${UUID_A}` }) }))
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "LIVE_RUNS_DISABLED", message: "Live agent runs are currently disabled.", requestId: "req-1" } }))
      .mockResolvedValueOnce(liveCapabilitiesResponse());

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Needs recovery after refusal");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await screen.findByText("Live agent runs are currently disabled.");
    expect(await screen.findByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    expect(screen.getAllByText("job-1").length).toBeGreaterThan(0);
  });
});

// No piece of an abandoned LIVE investigation's ownership — the visible
// error, recovery affordance, provider mode, idempotency key, failed stage, or
// frozen elapsed snapshot — may leak into a new submission.
describe("Start new investigation fully resets ownership, not just the visible job/run", () => {
  it("a subsequent FAKE submission's failure shows Retry Run (FAKE), never Recover Live Run (LIVE)", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(UUID_A);
    // Capabilities are routed separately from investigation traffic: several
    // capability refreshes fire-and-forget in this flow (the LIVE preflight,
    // the post-failure refresh, "Start new investigation"'s own refresh),
    // and a strict FIFO queue can't predict their exact interleaving with
    // the awaited investigation calls. See App.live-retry.test.tsx for the
    // same pattern.
    const investigationQueue: Response[] = [
      jsonResponse(201, { data: jobResponse({ ticketId: `DEMO-${UUID_A}` }) }),
      jsonResponse(503, { error: { code: "LIVE_RUNS_DISABLED", message: "Live agent runs are currently disabled.", requestId: "req-1" } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        if (String(input) === "/v1/capabilities") return Promise.resolve(liveCapabilitiesResponse());
        const next = investigationQueue.shift();
        if (next === undefined) throw new Error(`unexpected request: ${String(input)}`);
        return Promise.resolve(next);
      }),
    );

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "First investigation, LIVE, will fail ambiguously");
    await user.click(screen.getByRole("radio", { name: /Live/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    // Ambiguous LIVE failure: error shown, elapsed frozen, recovery
    // affordance present, ownership (activeProviderMode=LIVE, liveRequestKey
    // set, liveRetryPending true) all held by THIS attempt.
    await screen.findByText("Live agent runs are currently disabled.");
    await screen.findByRole("heading", { name: "Recover Live Run" });
    expect(document.querySelector(".investigation-progress-elapsed")).not.toBeNull();

    // Abandon it.
    await user.click(screen.getByRole("button", { name: "Start new investigation" }));

    // Old error, recovery banner, and Progress Timeline (elapsed snapshot
    // included) are all gone — not just the job/run.
    expect(screen.queryByText("Live agent runs are currently disabled.")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.queryByText("Investigation progress")).toBeNull();
    expect(document.querySelector(".investigation-progress-elapsed")).toBeNull();

    // A brand-new FAKE submission that ALSO fails at run creation.
    investigationQueue.push(
      jsonResponse(201, { data: jobResponse({ id: "job-2", ticketId: `DEMO-${UUID_A}` }) }),
      jsonResponse(503, { error: { code: "PERSISTENCE_UNAVAILABLE", message: "The database is temporarily unavailable.", requestId: "req-2" } }),
    );
    await user.type(screen.getByLabelText("Issue Summary"), "Second investigation, FAKE, also fails");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await screen.findByText("The database is temporarily unavailable.");

    // If `activeProviderMode` (or liveRetryPending/liveRequestKey) had
    // leaked from the abandoned LIVE attempt, this FAKE failure would show
    // the wrong affordance (or none at all) instead of the correct
    // FAKE-only Retry Run button.
    expect(screen.getByRole("button", { name: "Retry Run" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recover Live Run" })).toBeNull();

    // The new investigation's own Progress Timeline starts fresh — no stale
    // Failed badge carried over, and the new failure is correctly attributed
    // to the "run" stage of THIS submission.
    const progressRegion = screen.getByRole("region", { name: "Investigation progress" });
    expect(within(progressRegion).queryByText(/Checking Live Claude availability/)).toBeNull();
    const runLabel = within(progressRegion).getByText("Agent investigation in progress…");
    const runRow = runLabel.closest("li");
    expect(runRow).not.toBeNull();
    expect(within(runRow as HTMLElement).getByText("Failed")).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-elapsed")).not.toBeNull();
  });
});
