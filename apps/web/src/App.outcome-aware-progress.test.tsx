import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, AgentRunOutcomeView, ApprovalView } from "./api/types";

/**
 * The run progress stage — and everything downstream of it (approval
 * loading, elapsed freezing, terminal announcements, the report jump link) —
 * must be derived from the run's ACTUAL `outcome.type`, never from
 * `run !== null` alone. These tests pin that down for every place a run can
 * first be observed to settle: the initial submission, a FAKE retry, a LIVE
 * recovery, and an existing-Refresh transition out of RUNNING.
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

function runDetail(outcome: AgentRunOutcomeView, overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: outcome.type,
      providerMode: "FAKE",
      estimatedCostUsd: null,
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: outcome.type === "RUNNING" ? null : "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome,
    ...overrides,
  };
}

const RUNNING: AgentRunOutcomeView = { type: "RUNNING" };
const FAILED: AgentRunOutcomeView = { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." };
const COMPLETED: AgentRunOutcomeView = {
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
};

/**
 * Finding 2 (independent review, Codex review): a manual Refresh that
 * observes a terminal outcome for the first time now performs one
 * authoritative `getInvestigationState` read (the same mechanism Finding 1
 * added for the POST path) before permanently freezing canonical detail —
 * an extra fetch call every "Refresh out of RUNNING into a terminal
 * outcome" test must account for in its mock sequence.
 */
function investigationStateResponse(outcome: AgentRunOutcomeView): Response {
  const detail = runDetail(outcome);
  return jsonResponse(200, { data: { job: detail.job, run: detail.run, trace: detail.trace, outcome: detail.outcome, events: [] } });
}

function approvalView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return { runId: "run-1", status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null, ...overrides };
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

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

function progressRegion() {
  return screen.getByRole("region", { name: "Investigation progress" });
}

function stageRow(labelText: string): HTMLElement {
  const label = within(progressRegion()).getByText(labelText);
  const row = label.closest("li");
  if (row === null) throw new Error(`no <li> ancestor for "${labelText}"`);
  return row;
}

function statusRegion(): HTMLElement {
  return screen.getByRole("status");
}

/**
 * A terminally-failed investigation must not advertise an approval step at
 * all. Asserting ABSENCE rather than a Pending badge is the point: the
 * production incident was a run that failed and left the Timeline reading
 * "Pending — Loading approval state…" forever, because a pending row is
 * labelled by what it was about to do.
 */
function expectNoApprovalStage() {
  expect(within(progressRegion()).queryByText("Loading approval state…")).toBeNull();
  expect(within(progressRegion()).queryByText("Approval state loaded")).toBeNull();
}

/** Every rendered "Jump to X" link must target an element that actually exists. */
function assertNoDanglingJumpLinks() {
  for (const link of screen.queryAllByRole("link", { name: /jump to/i })) {
    const href = link.getAttribute("href");
    expect(href).not.toBeNull();
    const targetId = (href ?? "").replace("#", "");
    expect(document.getElementById(targetId)).not.toBeNull();
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Initial submission — outcome-aware progress", () => {
  it("RUNNING: run stage Active, elapsed keeps ticking, approval never starts, no terminal announcement, no report/jump-link", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(RUNNING) }));

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");

    expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();
    expect(within(stageRow("Loading approval state…")).getByText("Pending")).toBeInTheDocument();
    expect(statusRegion()).not.toHaveTextContent("Investigation complete");
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(document.getElementById("report-heading")).toBeNull();
    assertNoDanglingJumpLinks();

    const elapsedBefore = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(3000);
    const elapsedAfter = document.querySelector(".investigation-progress-elapsed")?.textContent;
    expect(elapsedAfter).not.toBe(elapsedBefore);
  });

  it("FAILED: run stage Failed, approval never starts, elapsed freezes, live region announces the failure, Report shows failure details, jump link present", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(FAILED) }));

    render(<App />);
    await submit(user);
    await screen.findByText("Generated report");

    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();
    expectNoApprovalStage();
    expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(statusRegion()).not.toHaveTextContent("Investigation complete");
    expect(screen.getByText("RETRIEVAL_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    assertNoDanglingJumpLinks();
    expect(screen.getByRole("link", { name: "Jump to report" })).toBeInTheDocument();
    // The endpoint is never even reached for a permanently ineligible run —
    // the omitted Timeline row above is not merely cosmetic.
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();

    const elapsedFrozen = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".investigation-progress-elapsed")?.textContent).toBe(elapsedFrozen);
  });

  it("COMPLETED: the existing successful flow remains correct", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(COMPLETED) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user);
    await screen.findByText("Generated report");

    expect(within(stageRow("Investigation created")).getByText("Done")).toBeInTheDocument();
    await waitFor(() => expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument());
    expect(statusRegion()).toHaveTextContent("Investigation complete.");
    assertNoDanglingJumpLinks();
    expect(screen.getByRole("link", { name: "Jump to report" })).toBeInTheDocument();
  });
});

describe("Refresh transitions out of RUNNING", () => {
  async function submitRunning(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(RUNNING) }));
    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
  }

  it("RUNNING -> RUNNING: stays Active, elapsed keeps ticking without restarting, no approval load, no dangling links", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    await submitRunning(user);

    const elapsedBeforeRefresh = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(2000);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: runDetail(RUNNING) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(statusRegion()).toHaveTextContent("Run refreshed."));
    expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();
    expect(within(stageRow("Loading approval state…")).getByText("Pending")).toBeInTheDocument();
    // Elapsed carried on ticking from the SAME start — it did not reset to 0.
    const elapsedAfterRefresh = document.querySelector(".investigation-progress-elapsed")?.textContent;
    expect(elapsedAfterRefresh).not.toBe("0s");
    expect(elapsedAfterRefresh).not.toBe(elapsedBeforeRefresh);
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toHaveLength(0);
    assertNoDanglingJumpLinks();
  });

  it("RUNNING -> COMPLETED: run stage completes, approval loads (tracked), elapsed freezes, success is announced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    await submitRunning(user);

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: runDetail(COMPLETED) }))
      // Finding 2's authoritative getInvestigationState read, between the
      // legacy Refresh read above and the approval load below.
      .mockResolvedValueOnce(investigationStateResponse(COMPLETED))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await screen.findByText("Generated report");
    expect(within(stageRow("Investigation created")).getByText("Done")).toBeInTheDocument();
    await waitFor(() => expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument());
    expect(statusRegion()).toHaveTextContent("Investigation complete. Human approval required.");
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toHaveLength(1);
    const elapsedFrozen = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".investigation-progress-elapsed")?.textContent).toBe(elapsedFrozen);
    // A PENDING approval replaces RunOverviewPanel (and its jump-links nav)
    // with ApprovalPanel, which has no jump links at all — the invariant
    // that matters here is that no link ever dangles, not that this
    // particular one is present.
    assertNoDanglingJumpLinks();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("RUNNING -> FAILED: run stage fails, approval never starts, elapsed freezes, failure is announced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    await submitRunning(user);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: runDetail(FAILED) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await screen.findByText("Generated report");
    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();
    expectNoApprovalStage();
    expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toHaveLength(0);
    const elapsedFrozen = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector(".investigation-progress-elapsed")?.textContent).toBe(elapsedFrozen);
    assertNoDanglingJumpLinks();
    expect(screen.getByRole("link", { name: "Jump to report" })).toBeInTheDocument();
  });
});

describe("FAKE retry — outcome-aware, not converted to success", () => {
  it("Retry Run returning RUNNING reaches stable Active state without restoring the previous terminal notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    const retryButton = await screen.findByRole("button", { name: "Retry Run" });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { data: runDetail(RUNNING) }));
    await user.click(retryButton);

    await screen.findByText("Agent activity");
    // Wait for the workflow's RUNNING result to settle back to idle. Checking
    // only the first render with Agent activity could still observe the busy
    // phase and miss a stale notice that reappears one render later.
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).toBeEnabled());

    expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();
    expect(within(stageRow("Loading approval state…")).getByText("Pending")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(statusRegion()).not.toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(statusRegion()).not.toHaveTextContent("Investigation complete");
    expect(statusRegion()).toBeEmptyDOMElement();
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(screen.queryByText("Suggested actions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
    expect(document.getElementById("approval-heading")).toBeNull();

    const approvalCalls = vi.mocked(fetch).mock.calls.filter((call) => String(call[0]).endsWith("/approval"));
    expect(approvalCalls).toHaveLength(0);

    const elapsedBefore = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(3000);
    const elapsedAfter = document.querySelector(".investigation-progress-elapsed")?.textContent;
    expect(elapsedAfter).not.toBe(elapsedBefore);
  });

  it("Retry Run returning FAILED marks the run stage Failed, not Completed", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    const retryButton = await screen.findByRole("button", { name: "Retry Run" });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { data: runDetail(FAILED) }));
    await user.click(retryButton);

    await screen.findByText("Generated report");
    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation.");
  });
});

describe("Refresh of an already-FAILED run", () => {
  it("FAILED -> FAILED refreshes only the run projection and never begins approval settlement", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(FAILED) }));

    render(<App />);
    await submit(user);
    await screen.findByText("Generated report");

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: runDetail(FAILED) }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run Investigation" })).toBeEnabled());

    const runGets = vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1");
    const approvalGets = vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval");
    expect(runGets).toHaveLength(1);
    expect(approvalGets).toHaveLength(0);

    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();
    expectNoApprovalStage();
    expect(screen.getByText("RETRIEVAL_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
    expect(document.getElementById("approval-heading")).toBeNull();
    expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(statusRegion()).not.toHaveTextContent("Investigation complete");
  });
});

describe("LIVE recovery — outcome-aware, not converted to success", () => {
  async function submitLiveAmbiguousFailure(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(fetch)
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")));
    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate on billing");
    await user.click(screen.getByRole("radio", { name: /Live Claude/ }));
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByRole("heading", { name: "Recover Live Run" });
  }

  it("a genuinely-started (201) recovery returning FAILED is not announced as success", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    await submitLiveAmbiguousFailure(user);

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(FAILED, { run: { ...runDetail(FAILED).run, providerMode: "LIVE" } }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse());
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Recover Live Run" }));

    await screen.findByText("Generated report");
    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();
    expect(statusRegion()).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(statusRegion()).not.toHaveTextContent("Recovered");
    // The closest analogue in this suite to the production incident: a LIVE
    // run that reaches a terminal FAILED outcome must neither fetch approval
    // nor leave an approval row behind.
    expectNoApprovalStage();
    expect(
      vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === "/v1/agent-runs/run-1/approval"),
    ).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
  });

  it("a genuinely-started (201) recovery returning RUNNING stays Active, not Completed", async () => {
    // Fake timers, not real ones: RUNNING never stops polling, so with real
    // timers a poll tick can fire after this test's assertions (and even
    // after RTL's afterEach unmount, under load) and consume a mock slot
    // meant for something else — this used to crash intermittently with an
    // unhandled rejection once the suite ran under load.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    await submitLiveAmbiguousFailure(user);

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail(RUNNING, { run: { ...runDetail(RUNNING).run, providerMode: "LIVE" } }) }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse());
    await user.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Recover Live Run" }));

    await screen.findByText("Agent activity");
    expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();
    expect(statusRegion()).not.toHaveTextContent("Investigation complete");
  });
});
