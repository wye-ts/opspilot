import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

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

function apiCalls() {
  return vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities");
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

async function submitLive(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate", token = TOKEN) {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("radio", { name: /Live Claude/ }));
  await user.type(screen.getByLabelText("Live demo access token"), token);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
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
});

describe("Investigation progress timeline (#34/#35)", () => {
  // Requirement 1: no empty result/progress panels before submission.
  it("renders no Progress, Agent activity, Report, or Approval panel before submission", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse());

    render(<App />);

    expect(screen.queryByText("Submitted issue")).toBeNull();
    expect(screen.queryByText("Investigation progress")).toBeNull();
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(screen.queryByRole("region", { name: "Approval" })).toBeNull();
  });

  // Requirements 2 and 3: submitted summary + Progress Timeline appear
  // immediately while job creation is unresolved, and the Run button stays
  // disabled (duplicate submission remains prevented).
  it("shows the submitted summary and Progress Timeline immediately, with the button disabled, while job creation is unresolved", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user, "Elevated error rate on billing");

    const submittedSection = screen.getByText("Submitted issue").closest("section");
    if (submittedSection === null) throw new Error("no submitted-summary section");
    expect(within(submittedSection).getByText("Elevated error rate on billing")).toBeInTheDocument();
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(within(stageRow("Creating investigation…")).getByText("In progress")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Creating investigation…" })).toBeDisabled();

    // A second click while pending must not issue a second job POST.
    await user.click(screen.getByRole("button", { name: "Creating investigation…" }));
    expect(apiCalls()).toHaveLength(1);

    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
    await screen.findByText("Investigation created");
  });

  // Requirement 4: job stage Active -> Completed.
  it("moves the job stage from Active to Completed once job creation resolves", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    expect(within(stageRow("Creating investigation…")).getByText("In progress")).toBeInTheDocument();

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));

    await waitFor(() => expect(within(stageRow("Investigation created")).getByText("Done")).toBeInTheDocument());
  });

  // Requirement 5: run stage remains Active while startAgentRun is unresolved.
  it("keeps the run stage Active while the agent run request is unresolved", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
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
  // returns to idle, and every later stage remains Pending.
  it("keeps the failed stage visible and later stages Pending after a job-creation failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The request body failed validation.");

    // `phase` is back to idle here (the error resolved it), yet the stage
    // list must still show WHERE it stopped, not silently reset to Pending.
    expect(within(stageRow("Creating investigation…")).getByText("Failed")).toBeInTheDocument();
    expect(within(stageRow("Agent investigation in progress…")).getByText("Pending")).toBeInTheDocument();
    expect(within(stageRow("Loading approval state…")).getByText("Pending")).toBeInTheDocument();
  });

  // Requirement 10: approval idle/loading/loaded/failed are distinguishable.
  // "idle" is covered by the run-stage test above (the approval stage reads
  // Pending while the run itself is still unresolved); this test covers the
  // loading -> loaded transition, and the dedicated test below covers failed.
  it("distinguishes the approval stage's loading and loaded states", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const deferredApproval = deferredResponse();
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
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
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The database is temporarily unavailable.");

    expect(within(stageRow("Loading approval state…")).getByText("Failed")).toBeInTheDocument();

    // Requirement 13: an approval-load failure must not hide the completed
    // run/report that already succeeded.
    expect(screen.getByText("Agent activity")).toBeInTheDocument();
    expect(screen.getByText("Generated report")).toBeInTheDocument();
  });

  // Requirement 11: report/activity/actions appear only when run data exists,
  // and in the required DOM order.
  it("reveals Agent activity, Generated report, and Suggested actions only once run data exists, in order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(screen.queryByText("Generated report")).toBeNull();

    await submit(user);
    await screen.findByText("Agent activity");

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    const order = [
      "Submitted issue",
      "Investigation progress",
      "Agent activity",
      "Generated report",
    ].map((label) => headings.indexOf(label));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // An empty suggestedActions array renders no Suggested
    // actions heading/panel at all — see App.reveal-boundaries.test.tsx for
    // the full set of data-driven reveal-boundary assertions.
    expect(screen.queryByText("Suggested actions")).toBeNull();
  });

  // Requirement 12: Approval appears only when applicable and after its load
  // settles.
  it("does not render the Approval decision form until the approval fetch settles as PENDING", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
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
      .mockImplementationOnce(() => deferredApproval.promise);

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
    await user.click(screen.getByLabelText("Approval workflow demo"));
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Generated report");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Run overview")).toBeInTheDocument();

    deferredApproval.resolve(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));
    await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByText("Run overview")).toBeNull();
  });

  // Requirement 15: the LIVE-only availability stage is absent in FAKE mode
  // and present in LIVE mode.
  it("omits the availability stage in FAKE mode and includes it in LIVE mode", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    expect(within(progressRegion()).queryByText(/Live Claude availability/)).toBeNull();
  });

  it("includes the availability stage first, in LIVE mode", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(liveCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(201, { data: runDetail({ run: { ...runDetail().run, providerMode: "LIVE" } }) }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }))
      .mockResolvedValueOnce(liveCapabilitiesResponse());

    render(<App />);
    await submitLive(user);
    await screen.findByText("Agent activity");

    const stages = within(progressRegion())
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(stages[0]).toContain("Live Claude availability");
  });

  // Requirement 16: exactly one aria-live region remains.
  it("still has exactly one aria-live region once the Progress Timeline is mounted", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
  });

  // Requirement 17: no percentage is ever rendered.
  it("never renders a percentage while a submission is in progress", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);

    render(<App />);
    await submit(user);
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("%");
    deferredJob.resolve(jsonResponse(201, { data: jobResponse() }));
  });

  // Requirement 14: retry resets transient progress state (elapsed clock and
  // failed stage) rather than accumulating the earlier failed attempt's.
  it("resets the failed stage when Retry Run is used after a run-creation failure", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
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
    vi.stubGlobal("fetch", vi.fn());
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
    expect(screen.queryByText("Submitted issue")).toBeNull();
  });

  // Requirements 6 and 7: the elapsed timer stops on terminal success and on
  // failure, and does not keep ticking afterwards.
  it("stops the elapsed timer once the workflow reaches terminal success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
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
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeCapabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user);
    await screen.findByText("The request body failed validation.");

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
    vi.stubGlobal("fetch", vi.fn());
    const deferredJob = deferredResponse();
    vi.mocked(fetch).mockResolvedValueOnce(fakeCapabilitiesResponse()).mockImplementationOnce(() => deferredJob.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<App />);
    await submit(user);
    expect(screen.getByText("Investigation progress")).toBeInTheDocument();

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
      vi.stubGlobal("fetch", vi.fn());
      vi.mocked(fetch)
        .mockResolvedValueOnce(fakeCapabilitiesResponse())
        .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
        .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
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
      vi.stubGlobal("fetch", vi.fn());
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
        .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

      render(<App />);
      await user.type(screen.getByLabelText("Issue Summary"), "Approval demo issue");
      await user.click(screen.getByLabelText("Approval workflow demo"));
      await user.click(screen.getByRole("button", { name: "Run Investigation" }));
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
