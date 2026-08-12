import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InvestigationEventRecord } from "@opspilot/contracts";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView, InvestigationStateResponse } from "./api/types";

/**
 * Focused coverage for #34 (immediate frontend-known progress) and #35
 * (progressive reveal). Each `it` block is annotated with the requirement
 * number(s) from the implementation prompt it demonstrates.
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
 * Investigation polling (#38) starts concurrently with every submit this
 * file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), which is
 * invisible to every assertion in this file (none inspect polling state).
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

function apiCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities" && !String(call[0]).endsWith("/investigation"));
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

async function submitLive(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate", token = TOKEN) {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("radio", { name: /Live/ }));
  await user.type(screen.getByLabelText("Live demo access token"), token);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

/** A response that only resolves once the test explicitly resolves it. */
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function progressRegion() {
  return screen.getByRole("region", { name: "Investigation progress" });
}

/** Locates a stage row by its (unique) label text and returns the `<li>`. */
function stageRow(labelText: string): HTMLElement {
  const label = within(progressRegion()).getByText(labelText);
  const row = label.closest("li");
  if (row === null) throw new Error(`no <li> ancestor for "${labelText}"`);
  return row;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Investigation progress timeline (#34/#35)", () => {
  // Requirement 1: no empty result/progress panels before submission.
  it("renders no Progress, Agent activity, Report, or Approval panel before submission", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse());

    render(<App />);

    expect(screen.queryByText("Current investigation")).toBeNull();
    expect(screen.queryByText("Investigation progress")).toBeNull();
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Resolution report")).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
  });

  // Requirements 2 and 3: the busy CTA stays disabled while job creation is
  // unresolved (duplicate submission remains prevented). The Progress Timeline
  // and "Current investigation" card are grounded on a committed job, so they
  // only mount once the deferred POST resolves (Milestone-10 composer
  // collapse), after which the summary is shown in the Current investigation
  // card.
  it("locks the CTA while job creation is unresolved and reveals the Current investigation card once the job commits", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);

    // No grounded surfaces while job creation is unresolved — the composer is
    // still visible and locked.
    expect(screen.getByRole("button", { name: "Creating investigation…" })).toBeDisabled();
    expect(screen.queryByText("Current investigation")).toBeNull();
    expect(screen.queryByText("Investigation progress")).toBeNull();

    // A second click while pending must not issue a second job POST.
    await user.click(screen.getByRole("button", { name: "Creating investigation…" }));
    expect(apiCalls()).toHaveLength(1);

    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
    await screen.findByText("Investigation created");

    const currentSection = screen.getByText("Current investigation").closest("section");
    if (currentSection === null) throw new Error("no current-investigation section");
    expect(within(currentSection).getByText("Elevated error rate")).toBeInTheDocument();
  });

  // Requirement 4: job stage Active -> Completed. The Active boundary is only
  // observable as the busy CTA (the Timeline is grounded on a committed job);
  // once job creation resolves the stage reads Done.
  it("moves the job stage from Active to Completed once job creation resolves", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    expect(screen.getByRole("button", { name: "Creating investigation…" })).toBeDisabled();

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));

    await waitFor(() => expect(within(stageRow("Investigation created")).getByText("Done")).toBeInTheDocument());
  });

  // Requirement 5: run stage remains Active while startAgentRun is unresolved.
  it("keeps the run stage Active while the agent run request is unresolved", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredRun = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockImplementationOnce(() => deferredRun.promise);

    render(<App />);
    await submit(user);

    await waitFor(() => expect(within(stageRow("Investigation created")).getByText("Done")).toBeInTheDocument());
    expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();
    // The approval fetch has not started yet — idle, not loading.
    expect(within(stageRow("Loading approval state…")).getByText("Pending")).toBeInTheDocument();
    // Not yet resolved, so nothing about the run has appeared.
    expect(screen.queryByText("Agent activity")).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    deferredRun.resolve(jsonResponse(201, { data: runDetail() }));
    await screen.findByText("Agent activity");
  });

  // Requirements 8 and 9: a failed stage remains visible after `phase`
  // returns to idle, and every later stage remains Pending. Milestone 10
  // grounds the whole Timeline on a committed job, so a job-creation failure
  // (no job ever committed) mounts NO Timeline and no Current investigation
  // card — the stopped submission is never painted as a fake Pending stage.
  it("a job-creation failure shows the error and leaves no grounded progress timeline behind", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The request body failed validation.");

    // No job exists, so no Timeline / Current investigation card is grounded —
    // in particular nothing reads "Pending — Loading approval state…", a fetch
    // that can never happen.
    expect(screen.queryByText("Investigation progress")).toBeNull();
    expect(screen.queryByText("Current investigation")).toBeNull();
    expect(screen.queryByText("Loading approval state…")).toBeNull();
    // The composer stays visible for a fresh submission.
    expect(screen.getByRole("button", { name: "Start Investigation" })).toBeEnabled();
  });

  // Requirement 10: approval idle/loading/loaded/failed are distinguishable.
  // "idle" is covered by the run-stage test above (the approval stage reads
  // Pending while the run itself is still unresolved); this test covers the
  // loading -> loaded transition, and the dedicated test below covers failed.
  it("distinguishes the approval stage's loading and loaded states", async () => {
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

    // loading, once the run has resolved and the GET is in flight.
    await waitFor(() => expect(within(stageRow("Loading approval state…")).getByText("In progress")).toBeInTheDocument());

    // loaded.
    deferredApproval.resolve(jsonResponse(200, { data: approvalView() }));
    await waitFor(() => expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument());
  });

  it("shows the approval stage as Failed, distinct from Pending, when the fetch genuinely fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The database is temporarily unavailable.");

    expect(within(stageRow("Loading approval state…")).getByText("Failed")).toBeInTheDocument();

    // Requirement 13: an approval-load failure must not hide the completed
    // run/report that already succeeded.
    expect(screen.getByText("Agent activity")).toBeInTheDocument();
    expect(screen.getByText("Resolution report")).toBeInTheDocument();
  });

  // Requirement 11: report/activity/actions appear only when run data exists,
  // and in the required DOM order.
  it("reveals Agent activity, Resolution report, and Suggested actions only once run data exists, in order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Resolution report")).toBeNull();

    await submit(user);
    await screen.findByText("Agent activity");

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // The Current investigation card's h2 is the issue summary itself.
    // Milestone-10 flat flow: the resolution row (Progress + Report) precedes
    // the Agent activity section.
    const order = [
      "Elevated error rate",
      "Investigation progress",
      "Resolution report",
      "Agent activity",
    ].map((label) => headings.indexOf(label));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // An empty suggestedActions array renders no Suggested
    // actions heading/panel at all — see App.reveal-boundaries.test.tsx for
    // the full set of data-driven reveal-boundary assertions.
    expect(screen.queryByText("Suggested actions")).toBeNull();
  });

  // Requirement 12: Approval appears only when applicable and after its load
  // settles. Approval-demo mode is activated by ?approval-demo=1 at mount
  // (the checkbox is removed in Milestone 10).
  it("does not render the Approval decision form until the approval fetch settles as PENDING", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredApproval = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, {
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
      }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockImplementationOnce(() => deferredApproval.promise);

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByRole("button", { name: "Start Investigation" }));

    await screen.findByText("Resolution report");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();

    deferredApproval.resolve(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    await screen.findByRole("button", { name: "Approve" });
    expect(screen.getByRole("region", { name: "Approval" })).toBeInTheDocument();
  });

  // Requirement 15: the LIVE-only availability stage is absent in FAKE mode
  // and present in LIVE mode.
  it("omits the availability stage in FAKE mode and includes it in LIVE mode", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    expect(within(progressRegion()).queryByText(/Live availability/)).toBeNull();
  });

  it("includes availability as lightweight preflight metadata, in LIVE mode (HQ polish §1)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(201, { data: runDetail({ run: { ...runDetail().run, providerMode: "LIVE" } }) }),
      )
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }))
      .mockResolvedValueOnce(liveCapabilitiesResponse());

    render(<App />);
    await submitLive(user);
    await screen.findByText("Agent activity");

    // Live availability renders, but as a plain metadata line above the
    // stepper — never a dominant stepper row/listitem of its own.
    const availability = within(progressRegion()).getByText(/Live availability/);
    expect(availability.closest(".investigation-progress-preflight")).not.toBeNull();
    expect(availability.closest("li")).toBeNull();
  });

  // Requirement 16: exactly one aria-live region remains.
  it("still has exactly one aria-live region once the Progress Timeline is mounted", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
    await screen.findByText("Investigation created");
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  // Requirement 17: no percentage is ever rendered.
  it("never renders a percentage while a submission is in progress", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    expect(screen.getByRole("button", { name: "Creating investigation…" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("%");
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
    await screen.findByText("Investigation created");
    expect(document.body.textContent).not.toContain("%");
  });

  // Requirement 14: retry resets transient progress state (elapsed clock and
  // failed stage) rather than accumulating the earlier failed attempt's.
  it("resets the failed stage when Retry Run is used after a run-creation failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The database is temporarily unavailable.");
    expect(within(stageRow("Agent investigation in progress…")).getByText("Failed")).toBeInTheDocument();

    const deferredRun = deferredResponse();
    vi.mocked(fetch).mockImplementationOnce(() => deferredRun.promise);
    await user.click(screen.getByRole("button", { name: "Retry Run" }));

    await waitFor(() =>
      expect(within(stageRow("Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument(),
    );

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    deferredRun.resolve(jsonResponse(201, { data: runDetail() }));
    await screen.findByText("Agent activity");
  });

  // Requirement 14 (continued): starting a new investigation unmounts the
  // Progress Timeline and submitted-summary snapshot entirely.
  it("unmounts the Progress Timeline and submitted summary when starting a new investigation from LIVE recovery mode", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")))
      .mockResolvedValueOnce(liveCapabilitiesResponse());

    render(<App />);
    await submitLive(user);
    await screen.findByText("Live agent runs are currently disabled.");
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(liveCapabilitiesResponse());
    await user.click(screen.getByRole("button", { name: "Start new investigation" }));

    expect(screen.queryByText("Investigation progress")).toBeNull();
    expect(screen.queryByText("Current investigation")).toBeNull();
  });

  // Requirements 6 and 7: the elapsed timer stops on terminal success and on
  // failure, and does not keep ticking afterwards.
  it("stops the elapsed timer once the workflow reaches terminal success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");

    const elapsedAfterCompletion = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(5000);
    const elapsedAfterWaiting = document.querySelector(".investigation-progress-elapsed")?.textContent;
    expect(elapsedAfterWaiting).toBe(elapsedAfterCompletion);
  });

  it("stops the elapsed timer once the workflow reaches terminal failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The database is temporarily unavailable.");

    const elapsedAfterFailure = document.querySelector(".investigation-progress-elapsed")?.textContent;
    await vi.advanceTimersByTimeAsync(5000);
    const elapsedAfterWaiting = document.querySelector(".investigation-progress-elapsed")?.textContent;
    expect(elapsedAfterWaiting).toBe(elapsedAfterFailure);
  });

  // Requirement 7 (continued): the interval is cleaned up on unmount — no
  // pending timers remain, and no state update fires after unmount.
  it("cleans up the elapsed-timer interval on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<App />);
    await submit(user);

    unmount();
    await vi.advanceTimersByTimeAsync(5000);

    expect(consoleError).not.toHaveBeenCalled();
  });

  // A manual approval refresh, and the 409-conflict
  // convergence reload, must not rewrite an already-settled investigation
  // progress stage.
  describe("manual approval actions do not rewrite investigation progress", () => {
    it("a manual Refresh never moves the completed approval stage to Active or Failed", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
      vi.mocked(fetch)
        .mockResolvedValueOnce(fakeCapabilitiesResponse())
        .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
        .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
        .mockResolvedValueOnce(pollFallbackResponse())
        .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

      render(<App />);
      await submit(user);
      await waitFor(() => expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument());

      const deferredApproval = deferredResponse();
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(200, { data: runDetail() }))
        .mockImplementationOnce(() => deferredApproval.promise);
      await user.click(screen.getByRole("button", { name: "Refresh" }));

      // Held open — still Completed, not Active.
      expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument();

      deferredApproval.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));
      await screen.findByText("The database is temporarily unavailable.");

      // Failed — still Completed, not Failed.
      expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument();
    });

    it("the 409-conflict approval convergence reload never moves the completed approval stage to Active or Failed", async () => {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
      vi.mocked(fetch)
        .mockResolvedValueOnce(fakeCapabilitiesResponse())
        .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
        .mockResolvedValueOnce(jsonResponse(201, {
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
                suggestedActions: [],
              },
            },
          }),
        }))
        .mockResolvedValueOnce(pollFallbackResponse())
        .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

      window.history.replaceState({}, "", "/?approval-demo=1");
      render(<App />);
      await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
      await user.click(screen.getByRole("button", { name: "Start Investigation" }));
      await screen.findByRole("button", { name: "Approve" });
      await waitFor(() => expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument());

      const deferredConflictReload = deferredResponse();
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse(409, errorEnvelope("AGENT_RUN_APPROVAL_ALREADY_DECIDED", "This run was already decided.")))
        .mockImplementationOnce(() => deferredConflictReload.promise);

      await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await screen.findByText("This run was already decided.");

      // The 409 reload is in flight — still Completed, not Active.
      expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument();

      deferredConflictReload.resolve(
        jsonResponse(200, { data: approvalView({ status: "APPROVED", reviewerName: "Someone Else", decidedAt: "2026-07-23T10:15:00.000Z" }) }),
      );
      await screen.findByText("Someone Else");

      // Converged — still Completed, not Failed.
      expect(within(stageRow("Approval state loaded")).getByText("Done")).toBeInTheDocument();
    });
  });
});

// ── #40: nested events never duplicate across incremental poll observations ──
// A real v4-shaped UUID — InvestigationEventRecordSchema validates runId
// against the strict UUID pattern, so a placeholder like "run-1" would make
// every canonical event fixture fail reducer validation and silently land in
// `canonical-invalid`.
const POLL_RUN_ID = "22222222-2222-4222-8222-222222222222";

function pollMakeEvent(sequence: number, payload: InvestigationEventRecord["payload"]): InvestigationEventRecord {
  return { runId: POLL_RUN_ID, sequence, recordedAt: "2026-07-23T10:00:00.000Z", payload };
}

function pollRunningSnapshot(events: readonly InvestigationEventRecord[]): InvestigationStateResponse {
  return {
    job: jobResponse(),
    run: {
      id: POLL_RUN_ID,
      jobId: "job-1",
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-07-23T10:00:00.000Z",
      estimatedCostUsd: null,
    },
    trace: [],
    outcome: { type: "RUNNING" },
    events,
  };
}

/** URL-routed fetch stub for the two-observation test — each endpoint has its
 * own queue/fallback, so a polling tick can never wrongly consume a response
 * meant for job/run/approval (same shape as App.polling.test.tsx's mockFetch). */
function mockPollFetch(investigation: Response[]) {
  const investigationQueue = [...investigation];
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      return Promise.resolve(fakeCapabilitiesResponse());
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: pollRunningSnapshot([]) }));
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      if (next === undefined) {
        // No more scripted ticks — a harmless 404 stops polling.
        return Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "no more scripted ticks")));
      }
      return Promise.resolve(next);
    }
    if (url.endsWith("/approval")) {
      return Promise.resolve(jsonResponse(200, { data: approvalView() }));
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The nested-event labels under one execution-stage child row, in DOM order. */
function nestedEventLabels(stageLabel: string): string[] {
  const childrenList = progressRegion().querySelector(".investigation-progress-children-list");
  if (childrenList === null) throw new Error("no canonical child list rendered");
  const row = within(childrenList as HTMLElement).getByText(stageLabel).closest("li");
  if (row === null) throw new Error(`no child row for "${stageLabel}"`);
  return [...row.querySelectorAll(".investigation-progress-event-item")].map((el) => el.textContent ?? "");
}

describe("Investigation progress timeline — incremental poll observations never duplicate nested events (#40)", () => {
  it("appends events across two sequential observations without duplicating rows or regressing stage progress", async () => {
    const user = userEvent.setup();
    // Accepted observation 1: events [RUN_CREATED, AGENT_STARTED].
    const observationOne = [
      pollMakeEvent(1, { type: "RUN_CREATED" }),
      pollMakeEvent(2, { type: "AGENT_STARTED" }),
    ];
    // Newer accepted observation 2: events [RUN_CREATED, AGENT_STARTED,
    // TOOL_REQUESTED, TOOL_COMPLETED].
    const observationTwo = [
      ...observationOne,
      pollMakeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
      pollMakeEvent(4, { type: "TOOL_COMPLETED", toolCallId: "call-1", toolName: "get_service_status" }),
    ];
    mockPollFetch([
      jsonResponse(200, { data: pollRunningSnapshot(observationOne) }),
      jsonResponse(200, { data: pollRunningSnapshot(observationTwo) }),
    ]);

    render(<App />);
    await submit(user);

    // Observation 1 lands: each observed event nested exactly once under its
    // own stage.
    await waitFor(
      () => expect(nestedEventLabels("Investigation created")).toEqual(["Run created"]),
      { timeout: 5000 },
    );
    await waitFor(() => expect(nestedEventLabels("Agent analysis")).toEqual(["Agent started"]), { timeout: 5000 });

    // Observation 2 appends the newly observed tool events under
    // DIAGNOSTIC_EXECUTION, in canonical sequence order.
    await waitFor(
      () =>
        expect(nestedEventLabels("Diagnostic execution")).toEqual([
          "Tool requested: Get service status",
          "Tool completed: Get service status",
        ]),
      { timeout: 5000 },
    );

    // A remains exactly once, B exactly once — no duplicate DOM event rows.
    expect(nestedEventLabels("Investigation created")).toEqual(["Run created"]);
    expect(nestedEventLabels("Agent analysis")).toEqual(["Agent started"]);
    const allEventItems = [...progressRegion().querySelectorAll(".investigation-progress-event-item")];
    expect(allEventItems).toHaveLength(4);

    // Prior stage progress has not regressed: INVESTIGATION_CREATED and
    // AGENT_ANALYSIS stay completed, DIAGNOSTIC_EXECUTION is the active stage.
    const childrenList = progressRegion().querySelector(".investigation-progress-children-list") as HTMLElement;
    expect(within(childrenList).getByText("Investigation created").closest("li")).toHaveClass(
      "investigation-progress-item--completed",
    );
    expect(within(childrenList).getByText("Agent analysis").closest("li")).toHaveClass(
      "investigation-progress-item--completed",
    );
    expect(within(childrenList).getByText("Diagnostic execution").closest("li")).toHaveClass(
      "investigation-progress-item--active",
    );
  });
});

describe("Investigation progress timeline — HQ review polish (Issue #41 §1)", () => {
  it("once canonical stages exist, 'Investigation created' renders exactly once and there is no separate 'Agent investigation in progress…' row", async () => {
    const user = userEvent.setup();
    mockPollFetch([
      jsonResponse(200, {
        data: pollRunningSnapshot([pollMakeEvent(1, { type: "RUN_CREATED" }), pollMakeEvent(2, { type: "AGENT_STARTED" })]),
      }),
    ]);

    render(<App />);
    await submit(user);
    await waitFor(() => expect(progressRegion().querySelector(".investigation-progress-children-list")).not.toBeNull());

    // "Investigation created" is the first canonical row's own label — it
    // must not ALSO appear as a separate "job" system row.
    expect(within(progressRegion()).getAllByText("Investigation created")).toHaveLength(1);
    // The run's own aggregate label never renders as a row alongside its
    // four canonical children — that information now lives in the four rows
    // themselves.
    expect(within(progressRegion()).queryByText("Agent investigation in progress…")).toBeNull();
  });
});
