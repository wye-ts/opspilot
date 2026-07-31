import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * LIVE PARTIAL FAILURE: job created, run refused.
 *
 * The defect these tests pin down. The app correctly retained the AgentJob when
 * the LIVE run request failed, and correctly told the user to re-enter their
 * token — but the only submit action was `runInvestigation`, which generates a
 * new ticket ID and POSTs a NEW job. So "retrying" produced a duplicate job,
 * stranded the original, bypassed that job's live attempt history, and consumed
 * a fresh daily reservation under a different job. The instruction on screen was
 * false.
 *
 * The invariant now enforced:
 *
 *   re-enter token
 *     -> POST /v1/agent-jobs/:retainedJobId/runs
 *     -> NO POST /v1/agent-jobs
 *     -> same provider mode, same persisted job, same attempt history
 */

const TOKEN = "demo-token-do-not-use-8f14e45fceea";
const RETRY_TOKEN = "demo-token-do-not-use-second-entry";
const UUID_A = "11111111-1111-1111-1111-111111111111";
const HEADER = "X-OpsPilot-Demo-Token";
const JOB_ID = "job-1";
const SUMMARY = "Elevated error rate on billing";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function jobResponse(): AgentJobResponse {
  return {
    id: JOB_ID,
    ticketId: `DEMO-${UUID_A}`,
    summary: SUMMARY,
    createdAt: "2026-07-30T10:00:00.000Z",
  };
}

function liveRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: JOB_ID,
      attemptNumber: 2,
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

function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
  // Two parameters, so `call[1]` (the RequestInit) stays typed at the call sites.
  const fetchMock = vi.fn((input: unknown, _init?: unknown) => {
    if (String(input) === "/v1/capabilities") {
      return Promise.resolve(capabilityQueue.shift() ?? capabilityFallback());
    }
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

/** Everything that is NOT a capability read. */
function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities");
}

function jobCreateCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).endsWith("/v1/agent-jobs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function runCreateCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]).includes("/runs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function headerOf(call: unknown[]): string | undefined {
  const headers = (call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
  return headers?.[HEADER];
}

const user = () => userEvent.setup();

/** Drives the form through a LIVE submission that will fail at run creation. */
async function submitLive(u: ReturnType<typeof userEvent.setup>, token = TOKEN) {
  await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
  await u.click(screen.getByRole("radio", { name: /Live Claude/ }));
  await u.type(screen.getByLabelText("Live demo access token"), token);
  await u.click(screen.getByRole("button", { name: "Run Investigation" }));
}

/** Re-enters a token in retry mode and submits. */
async function submitRetry(u: ReturnType<typeof userEvent.setup>, token = RETRY_TOKEN) {
  await u.type(screen.getByLabelText("Live demo access token"), token);
  await u.click(screen.getByRole("button", { name: "Recover Live Run" }));
}

/**
 * A response that does not resolve until the test says so.
 *
 * The only way to observe the window between "job created" and "run request
 * resolved" — the window in which the app used to claim the run had already
 * failed.
 */
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const RUN_REFUSED = () =>
  jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled."));

afterEach(() => {
  capabilityQueue = [];
  capabilityFallback = () => capabilitiesResponse();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LIVE partial failure — the retained job", () => {
  it("keeps the job, renders no run, and enters Recover Live Run mode", async () => {
    mockFetch(jsonResponse(201, { data: jobResponse() }), RUN_REFUSED());
    render(<App />);

    await submitLive(user());
    await screen.findByText("Live agent runs are currently disabled.");

    // The job survived...
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    // ...no run was produced...
    expect(screen.queryByRole("heading", { name: "Investigation timeline" })).toBeNull();
    // ...and the form now offers the dedicated retry, not a new investigation.
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Investigation" })).toBeNull();
  });

  it("presents the retained ticket and summary as facts, not editable fields", async () => {
    // Option 1 of the two acceptable designs: the retained context is read-only.
    // An editable summary here would imply the retry could change the
    // investigation it retries.
    mockFetch(jsonResponse(201, { data: jobResponse() }), RUN_REFUSED());
    render(<App />);

    await submitLive(user());
    await screen.findByRole("heading", { name: "Recover Live Run" });

    expect(screen.queryByLabelText("Issue Summary")).toBeNull();
    expect(screen.getAllByText(SUMMARY).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`DEMO-${UUID_A}`).length).toBeGreaterThan(0);
    // The provider is fixed by the retained job — no radio group to change it.
    expect(screen.queryByRole("radio", { name: /Demo — FAKE/ })).toBeNull();
    // And the approval-workflow demo is unavailable, as it is for any live run.
    expect(screen.queryByLabelText("Approval workflow demo")).toBeNull();
  });

  it("starts the retry token field empty", async () => {
    mockFetch(jsonResponse(201, { data: jobResponse() }), RUN_REFUSED());
    render(<App />);

    await submitLive(user());
    await screen.findByRole("heading", { name: "Recover Live Run" });

    expect(screen.getByLabelText("Live demo access token")).toHaveValue("");
    // With no token typed, the retry cannot be submitted.
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeDisabled();
  });
});

describe("LIVE retry — the request it actually makes", () => {
  it("POSTs to the retained job id and creates no second job", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    // THE decisive assertion: exactly one job was ever created.
    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    // And the retry addressed the retained job, not a replacement.
    expect(String(runCreateCalls(fetchMock)[1]![0])).toBe(`/v1/agent-jobs/${JOB_ID}/runs`);
    expect(String(runCreateCalls(fetchMock)[0]![0])).toBe(`/v1/agent-jobs/${JOB_ID}/runs`);
  });

  it("sends providerMode LIVE and the freshly entered token in the header", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    const retry = runCreateCalls(fetchMock)[1]!;
    expect(JSON.parse(String((retry[1] as RequestInit).body))).toEqual({ providerMode: "LIVE" });
    // The SECOND token, not the first — the field was cleared and re-entered.
    expect(headerOf(retry)).toBe(RETRY_TOKEN);
  });

  it("generates no second ticket id", async () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    const afterFirstSubmit = randomUUID.mock.calls.length;
    await submitRetry(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    // A new ticket id would mean a new investigation, which is the whole bug.
    expect(randomUUID.mock.calls.length).toBe(afterFirstSubmit);
  });
});

describe("LIVE retry — outcomes", () => {
  it("renders the returned run, loads approval, clears the token, keeps the job id", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);

    await screen.findByRole("heading", { name: "Investigation timeline" });
    // Approval was fetched for the new run.
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toBe(true);
    // The retained job id is unchanged — this is the same investigation.
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    // Retry mode is gone, and with it the token field.
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Live demo access token")).toHaveValue(""));
  });

  it("stays on the same job, retryable, after a SECOND failure", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      RUN_REFUSED(),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    // Same job, still exactly one created, still offering a retry.
    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    // Token cleared again, so a third attempt needs a third entry.
    await waitFor(() => expect(screen.getByLabelText("Live demo access token")).toHaveValue(""));
  });

  it("keeps a per-job attempt-limit rejection attached to the retained job", async () => {
    // The rejection that proves the attempt history is being respected: the
    // server counted this job's live runs. A replacement job would have reset
    // that count, which is exactly the safeguard the old behaviour bypassed.
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(
        429,
        errorEnvelope("LIVE_RUN_ATTEMPT_LIMIT", "This agent job has reached its live run attempt limit."),
      ),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);

    await screen.findByText("This agent job has reached its live run attempt limit.");
    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    // No fallback to FAKE, and no replacement job.
    for (const call of runCreateCalls(fetchMock)) {
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ providerMode: "LIVE" });
    }
  });
});

/**
 * THE FIRST ATTEMPT IS NOT A RETRY.
 *
 * `job !== null && run === null && activeProviderMode === "LIVE"` is true for two
 * completely different situations: a LIVE run that was REFUSED, and a LIVE run
 * that is still IN FLIGHT. An earlier version derived retry mode from exactly
 * that condition, so during an ordinary first attempt the form announced
 * "the investigation was created, but the live run could not be started" while
 * the run was still going — and the retry-entry effect cleared the token field
 * mid-request.
 *
 * `liveRetryPending` is set only where a rejection is actually observed, which is
 * what these tests pin down.
 */
describe("an in-flight first LIVE run is not treated as a failure", () => {
  it("shows the ordinary busy UI, not retry mode, while the first run is pending", async () => {
    const pendingRun = deferredResponse();
    mockFetch(jsonResponse(201, { data: jobResponse() }), pendingRun.promise);
    render(<App />);
    const u = user();

    await submitLive(u);

    // The job has been created and is on screen...
    await waitFor(() => expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0));
    // ...the run request is still outstanding...
    // The progress region specifically: "Running agent…" is also the submit
    // button's label while busy, so a bare text query matches twice.
    //
    // A longer timeout than the 1s default: these tests hold a response open
    // deliberately, and under parallel file execution the jsdom + userEvent work
    // before this point can approach that default. Raising the wait does not
    // weaken the assertion — the condition is unchanged — it just stops a slow
    // machine from reading as a failure.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running agent…"), {
      timeout: 5_000,
    });

    // ...and NOTHING claims it failed.
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recover Live Run" })).toBeNull();
    expect(
      screen.queryByText(/the live run could not be started/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Start new investigation" })).toBeNull();

    // Clean up the pending request so the test does not leak it.
    pendingRun.resolve(jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "disabled")));
  });

  it("keeps the ordinary form fields visible while the first run is pending", async () => {
    const pendingRun = deferredResponse();
    mockFetch(jsonResponse(201, { data: jobResponse() }), pendingRun.promise);
    render(<App />);
    const u = user();

    await submitLive(u);
    // The progress region specifically: "Running agent…" is also the submit
    // button's label while busy, so a bare text query matches twice.
    //
    // A longer timeout than the 1s default: these tests hold a response open
    // deliberately, and under parallel file execution the jsdom + userEvent work
    // before this point can approach that default. Raising the wait does not
    // weaken the assertion — the condition is unchanged — it just stops a slow
    // machine from reading as a failure.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running agent…"), {
      timeout: 5_000,
    });

    // The editable summary is still the summary field, not a read-only <dl>.
    expect(screen.getByLabelText("Issue Summary")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeInTheDocument();

    pendingRun.resolve(jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "disabled")));
  });

  it("enters retry mode only once the rejection actually arrives", async () => {
    const pendingRun = deferredResponse();
    mockFetch(jsonResponse(201, { data: jobResponse() }), pendingRun.promise);
    render(<App />);
    const u = user();

    await submitLive(u);
    // The progress region specifically: "Running agent…" is also the submit
    // button's label while busy, so a bare text query matches twice.
    //
    // A longer timeout than the 1s default: these tests hold a response open
    // deliberately, and under parallel file execution the jsdom + userEvent work
    // before this point can approach that default. Raising the wait does not
    // weaken the assertion — the condition is unchanged — it just stops a slow
    // machine from reading as a failure.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running agent…"), {
      timeout: 5_000,
    });
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();

    pendingRun.resolve(
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
    );

    // Now — and only now — the recovery affordance appears.
    await screen.findByRole("heading", { name: "Recover Live Run" });
    // `waitFor`, not a bare read. The heading is driven by state, while the token
    // is cleared by an EFFECT on the busy→idle edge, so the two do not have to
    // land in the same commit — and on a slow machine they sometimes do not.
    // What the test asserts is unchanged (the field ends up empty); it just no
    // longer demands that it be empty in the exact tick the heading first
    // renders, which was never the guarantee.
    await waitFor(() => expect(screen.getByLabelText("Live demo access token")).toHaveValue(""));
  });

  it("does not enter retry mode when the FIRST attempt was FAKE", async () => {
    // A FAKE partial failure keeps the Retry Run button; it must never produce a
    // token form.
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByText("The database is temporarily unavailable.");

    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry Run" })).toBeInTheDocument();
  });

  it("keeps retry mode visible while the RETRY itself is in flight", async () => {
    // The other half of the distinction: once the failure is confirmed, a
    // pending request must NOT snap the form back to creation mode.
    const pendingRetry = deferredResponse();
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      pendingRetry.promise,
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);

    // Still in retry mode, still busy.
    // The progress region specifically: "Running agent…" is also the submit
    // button's label while busy, so a bare text query matches twice.
    //
    // A longer timeout than the 1s default: these tests hold a response open
    // deliberately, and under parallel file execution the jsdom + userEvent work
    // before this point can approach that default. Raising the wait does not
    // weaken the assertion — the condition is unchanged — it just stops a slow
    // machine from reading as a failure.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running agent…"), {
      timeout: 5_000,
    });
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Issue Summary")).toBeNull();

    pendingRetry.resolve(jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "disabled")));
  });
});

describe("Start new investigation", () => {
  it("clears only local state and creates no job until the user submits one", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });

    await u.click(screen.getByRole("button", { name: "Start new investigation" }));

    // Back to the ordinary creation form...
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.getByLabelText("Issue Summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeInTheDocument();
    // ...the retained job is gone from the page...
    expect(screen.queryByText(JOB_ID)).toBeNull();
    // ...the form's OWN state is reset, not just the parent's...
    expect(screen.getByLabelText("Issue Summary")).toHaveValue("");
    expect(screen.getByRole("radio", { name: /Demo — FAKE/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Live Claude/ })).not.toBeChecked();
    // Provider is back to FAKE, so the token field is not even rendered.
    expect(screen.queryByLabelText("Live demo access token")).toBeNull();
    expect(screen.getByLabelText("Approval workflow demo")).not.toBeChecked();
    // ...and NOTHING was sent: no delete, no new job, no extra request at all.
    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "DELETE"))
      .toHaveLength(0);
    // Investigation traffic only — exactly the job create and the refused run.
    // Capability reads are counted separately (the reset triggers one on its way
    // back to idle), so this stays an exact behavioural assertion rather than
    // being loosened to absorb refresh traffic.
    expect(investigationCalls(fetchMock)).toHaveLength(2);
  });
});

describe("FAKE partial failure is unchanged", () => {
  it("retries the retained job via Retry Run and sends no token header", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      jsonResponse(201, {
        data: { ...liveRunDetail(), run: { ...liveRunDetail().run, providerMode: "FAKE" } },
      }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByText("The database is temporarily unavailable.");

    // The FAKE affordance is still a button, not a token form.
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    await u.click(screen.getByRole("button", { name: "Retry Run" }));
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    for (const call of runCreateCalls(fetchMock)) {
      expect(headerOf(call)).toBeUndefined();
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ providerMode: "FAKE" });
    }
  });
});

describe("the retry token stays ephemeral", () => {
  it("never reaches storage, a URL, a cookie, a body, or a FAKE request", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRetry(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    for (const token of [TOKEN, RETRY_TOKEN]) {
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      expect(window.location.href).not.toContain(token);
      expect(document.cookie).not.toContain(token);

      for (const call of fetchMock.mock.calls) {
        expect(String(call[0])).not.toContain(token);
        const body = (call[1] as RequestInit | undefined)?.body;
        if (body !== undefined && body !== null) expect(String(body)).not.toContain(token);
      }
    }

    // Each token appeared in exactly one place: the header of its own request.
    expect(headerOf(runCreateCalls(fetchMock)[0]!)).toBe(TOKEN);
    expect(headerOf(runCreateCalls(fetchMock)[1]!)).toBe(RETRY_TOKEN);
  });
});
