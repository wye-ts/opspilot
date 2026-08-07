import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, InvestigationStateResponse } from "./api/types";

/**
 * Focused coverage for #38's resume path: mount-time `?job=` restoration,
 * `popstate` Back/Forward using the SAME resume function, and every failure
 * mode (malformed link, 404, network/503) — wired end to end through
 * App.tsx's `resumeInvestigationFromJobParam`.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID_B = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const UUID_A = "44444444-4444-4444-4444-444444444444";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return { id: JOB_ID, ticketId: `DEMO-${UUID_A}`, summary: "Elevated error rate on billing", createdAt: "2026-07-23T10:00:00.000Z", ...overrides };
}

function runningState(overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
  return {
    job: jobResponse(),
    run: {
      id: RUN_ID,
      jobId: JOB_ID,
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
    events: [],
    ...overrides,
  };
}

function completedState(overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
  const base = runningState();
  return {
    ...base,
    run: { ...base.run!, status: "COMPLETED", finishedAt: "2026-07-23T10:00:05.000Z" },
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

function failedState(overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
  const base = runningState();
  return {
    ...base,
    run: { ...base.run!, status: "FAILED", finishedAt: "2026-07-23T10:00:05.000Z" },
    outcome: { type: "FAILED", code: "TOOL_NOT_FOUND", message: "The requested diagnostic tool is not registered." },
    ...overrides,
  };
}

function jobOnlyState(): InvestigationStateResponse {
  return { job: jobResponse(), run: null, trace: [], outcome: null, events: [] };
}

function approvalResponse() {
  return jsonResponse(200, { data: { runId: RUN_ID, status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null } });
}

function unavailableCapabilities(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

function availableCapabilities(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

interface MockFetchOptions {
  readonly investigation?: (Response | Promise<Response>)[];
  readonly approval?: (url: string) => Response | Promise<Response>;
  /** Consumed, in order, for EVERY GET /v1/capabilities call; falls back to UNAVAILABLE once exhausted. */
  readonly capabilities?: (Response | Promise<Response>)[];
}

function mockFetch(options: MockFetchOptions = {}) {
  const investigationQueue = [...(options.investigation ?? [])];
  const capabilitiesQueue = [...(options.capabilities ?? [])];
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      const next = capabilitiesQueue.shift();
      return Promise.resolve(next ?? unavailableCapabilities());
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      if (next === undefined) return Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "no more scripted reads")));
      return Promise.resolve(next);
    }
    if (url.endsWith("/approval")) return Promise.resolve((options.approval ?? (() => approvalResponse()))(url));
    if (url === "/v1/agent-jobs" && method === "POST") return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation"));
}

function capabilityCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/v1/capabilities");
}

function approvalCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/approval")).length;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Investigation resume (#38)", () => {
  it("mount with a valid ?job= restores state from exactly one snapshot read", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: completedState() })] });

    render(<App />);

    await screen.findByText("Agent activity");
    expect(investigationCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByText(JOB_ID)).toBeInTheDocument();
    expect(screen.getByText("Elevated error rate on billing")).toBeInTheDocument();
  });

  it("a resumed RUNNING run starts polling", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({
      investigation: [jsonResponse(200, { data: runningState() }), jsonResponse(200, { data: runningState() })],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(investigationCalls(fetchMock).length).toBeGreaterThanOrEqual(1);

    // A subsequent poll tick proves polling actually started, not just the
    // one-time resume read. Real timers are used in this test (no fake-timer
    // control), so the exact count at the first checkpoint above is not
    // asserted precisely — only that at least one more tick eventually lands.
    await waitFor(() => expect(investigationCalls(fetchMock).length).toBeGreaterThanOrEqual(2));
  });

  it("a resumed COMPLETED run loads approval exactly once", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: completedState() })] });

    render(<App />);
    await screen.findByText("Agent activity");
    await waitFor(() => expect(approvalCallCount(fetchMock)).toBe(1));
    expect(screen.getByText("No evidence was recorded.")).toBeInTheDocument();
  });

  it("a resumed FAILED run does not load approval", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: failedState() })] });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByText("The requested diagnostic tool is not registered.")).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(0);
  });

  it("a resumed job-only state (no run yet) is handled safely, with no retry affordance offered", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    mockFetch({ investigation: [jsonResponse(200, { data: jobOnlyState() })] });

    render(<App />);
    await screen.findByText(JOB_ID);
    expect(screen.queryByText("Agent activity")).toBeNull();
    // No persisted record of the original provider selection exists for a
    // job-only resume — Retry Run must not be offered (see App.tsx's
    // `resumedJobOnly` guard).
    expect(screen.queryByRole("button", { name: "Retry Run" })).toBeNull();
  });

  /**
   * Independent review Finding 1 (Codex review): the API/plan explicitly
   * model "job exists, run not committed yet" as a real, expected window —
   * the original server request (from before this reload) may still be
   * executing and can commit/complete the run at any moment. A fresh
   * submission keeps polling through this window; resume must not do less.
   */
  it("a resumed job-only state polls for the run that commits moments later — no run/POST is ever issued, the run hydrates automatically once a poll tick observes it, and its persisted LIVE mode is synchronized everywhere (final Codex re-review Finding 5)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const runningLiveEvents = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" as const } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" as const } },
    ];
    const runningLiveSnapshot: InvestigationStateResponse = {
      ...runningState(),
      run: { ...runningState().run!, providerMode: "LIVE" },
      events: runningLiveEvents,
    };
    const terminalLiveSnapshot: InvestigationStateResponse = {
      ...completedState(),
      run: { ...completedState().run!, providerMode: "LIVE" },
      events: [
        ...runningLiveEvents,
        { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" as const } },
        { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" as const } },
        { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" as const } },
      ],
    };
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: jobOnlyState() }), // resume's own initial read
        jsonResponse(200, { data: runningLiveSnapshot }), // poll tick 1 — the run committed
        jsonResponse(200, { data: terminalLiveSnapshot }), // poll tick 2 — terminal
      ],
    });

    render(<App />);
    await screen.findByText(JOB_ID);
    expect(screen.queryByText("Agent activity")).toBeNull();

    // The run commits — the poll session started under resume's own
    // generation observes it (its first tick may already have fired
    // passively above, under `shouldAdvanceTime: true`; advancing once
    // more here guarantees it has).
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");

    // Exactly four canonical child rows appear, and the provisional
    // job-only FAKE guess is replaced by the persisted run's actual LIVE
    // mode (RunContextPanel reads the real run object directly).
    const runContextRegion = screen.getByRole("complementary", { name: "Run context" });
    expect(within(runContextRegion).getByText("LIVE")).toBeInTheDocument();
    // Final Codex re-review Finding 5: the persisted LIVE mode must replace
    // the provisional FAKE guess EVERYWHERE it is read from, not only Run
    // Context — the "Submitted issue" section (`submittedSummary`) and the
    // Progress Timeline's stage composition (which only includes the
    // "availability" stage for LIVE) must also agree.
    expect(screen.getByText("Submitted issue").closest("section")).toHaveTextContent("LIVE");
    expect(screen.getByText("Live Claude availability confirmed")).toBeInTheDocument();
    // Scoped to the nested canonical child list specifically — the outer
    // "job" stage's own completed label is ALSO literally "Investigation
    // created", so querying the whole Timeline region would be ambiguous.
    const childList = document.querySelector(".investigation-progress-children-list");
    expect(childList).not.toBeNull();
    for (const label of ["Investigation created", "Agent analysis", "Diagnostic execution", "Report generation"]) {
      expect(within(childList as HTMLElement).getByText(label)).toBeInTheDocument();
    }

    // Polling settles normally at terminal.
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

    // No provider/run POST was ever issued from the job-only resume path,
    // and no LIVE recovery execution occurred — only GET .../investigation
    // reads (the resume read plus two poll ticks).
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/runs"))).toBe(false);
    expect(investigationCalls(fetchMock)).toHaveLength(3);
  });

  it("a resumed job-only state that later discovers a FAKE run remains consistently FAKE everywhere (final Codex re-review Finding 5)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({
      investigation: [jsonResponse(200, { data: jobOnlyState() }), jsonResponse(200, { data: runningState() })],
    });

    render(<App />);
    await screen.findByText(JOB_ID);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");

    expect(screen.getByText("Submitted issue").closest("section")).toHaveTextContent("FAKE");
    const runContextRegion = screen.getByRole("complementary", { name: "Run context" });
    expect(within(runContextRegion).getByText("FAKE")).toBeInTheDocument();
    // FAKE never gets an "availability" Timeline row.
    expect(screen.queryByText("Live Claude availability confirmed")).toBeNull();
    expect(screen.queryByText("Checking Live Claude availability…")).toBeNull();
  });

  it("a malformed ?job= makes no request, shows a notice, and strips the param", async () => {
    window.history.pushState(null, "", "?job=not-a-uuid");
    const fetchMock = mockFetch();

    render(<App />);
    await screen.findByText("That investigation link isn't valid.");
    expect(investigationCalls(fetchMock)).toHaveLength(0);
    expect(window.location.search).toBe("");
  });

  it("a 404 on resume shows 'no longer available' and strips ?job=", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    mockFetch({ investigation: [jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "gone"))] });

    render(<App />);
    await screen.findByText("This investigation is no longer available.");
    expect(window.location.search).toBe("");
  });

  it("a network/503 failure on resume preserves the URL/job identity for retry", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    mockFetch({ investigation: [jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable."))] });

    render(<App />);
    await screen.findByText("The database is temporarily unavailable.");
    expect(window.location.search).toBe(`?job=${JOB_ID}`);
  });

  it("preserves an unrelated query parameter across resume/strip", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}&debug=1`);
    mockFetch({ investigation: [jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "gone"))] });

    render(<App />);
    await screen.findByText("This investigation is no longer available.");
    expect(window.location.search).toContain("debug=1");
    expect(window.location.search).not.toContain("job=");
  });

  it("Back/Forward between two jobs uses the same resume function for both", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: completedState() }),
        jsonResponse(200, { data: completedState({ job: jobResponse({ id: JOB_ID_B }) }) }),
      ],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByText(JOB_ID)).toBeInTheDocument();

    window.history.pushState(null, "", `?job=${JOB_ID_B}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByText(JOB_ID_B)).toBeInTheDocument());
    expect(investigationCalls(fetchMock)).toHaveLength(2);
  });

  it("a stale resume read from job A cannot mutate state after popstate navigates to job B", async () => {
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    let resolveJobA!: (value: Response) => void;
    const jobAPromise = new Promise<Response>((r) => {
      resolveJobA = r;
    });
    const fetchMock = mockFetch({
      investigation: [jobAPromise, jsonResponse(200, { data: completedState({ job: jobResponse({ id: JOB_ID_B }) }) })],
    });

    render(<App />);
    // job A's resume read is in flight (deferred) when we navigate away.
    window.history.pushState(null, "", `?job=${JOB_ID_B}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await screen.findByText(JOB_ID_B);

    // job A's stale read now resolves — it must not overwrite job B's state.
    resolveJobA(jsonResponse(200, { data: completedState() }));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(JOB_ID_B)).toBeInTheDocument();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(investigationCalls(fetchMock)).toHaveLength(2);
  });

  // Finding 6 (independent review): invalidateInFlightWorkflows() aborts
  // whatever capability read was already in flight (including the very
  // first one, from the mount-time capabilities effect) without ever
  // starting a replacement — capabilities stayed `null` (LIVE reads as
  // unavailable) until an unrelated focus/visibility event. A fresh,
  // generation-safe read must fire as part of resume.
  describe("capabilities are restarted after mount-time resume (Finding 6)", () => {
    it("mount with a valid ?job=: the first capability request is invalidated, a replacement is made, and LIVE availability reflects the replacement's result", async () => {
      const fetchMock = mockFetch({
        investigation: [jsonResponse(200, { data: runningState() })],
        // Two capability responses: the mount-time one (which gets aborted
        // by resume before it can apply) and the replacement resume fires.
        capabilities: [unavailableCapabilities(), availableCapabilities()],
      });
      window.history.pushState(null, "", `?job=${JOB_ID}`);

      render(<App />);
      await screen.findByText("Agent activity");

      // A replacement capability read landed and populated state — LIVE
      // becomes selectable, which could only happen from the SECOND
      // (post-invalidation) response, never the first (UNAVAILABLE) one.
      await waitFor(() => expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeEnabled());
      expect(capabilityCalls(fetchMock).length).toBeGreaterThanOrEqual(2);
    });

    it("a stale first capability response arriving late cannot overwrite the replacement's result", async () => {
      let resolveFirstCapabilities!: (value: Response) => void;
      const firstCapabilities = new Promise<Response>((r) => {
        resolveFirstCapabilities = r;
      });
      mockFetch({
        investigation: [jsonResponse(200, { data: runningState() })],
        capabilities: [firstCapabilities, availableCapabilities()],
      });
      window.history.pushState(null, "", `?job=${JOB_ID}`);

      render(<App />);
      await screen.findByText("Agent activity");
      await waitFor(() => expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeEnabled());

      // The FIRST (mount-time) capability request — aborted by resume,
      // never actually cancelled at the fetch-mock level — resolves late
      // with the OPPOSITE answer. Its generation is stale; it must be
      // discarded.
      resolveFirstCapabilities(unavailableCapabilities());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByRole("radio", { name: /Live Claude/ })).toBeEnabled();
    });

    it("resume's 404/malformed/no-job paths do not create duplicate or unbounded capability loops", async () => {
      // 404 path.
      {
        const fetchMock = mockFetch({ investigation: [jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "gone"))], capabilities: [availableCapabilities()] });
        window.history.pushState(null, "", `?job=${JOB_ID}`);
        const { unmount } = render(<App />);
        await screen.findByText("This investigation is no longer available.");
        const countAfterSettle = capabilityCalls(fetchMock).length;
        await new Promise((r) => setTimeout(r, 50));
        expect(capabilityCalls(fetchMock).length).toBe(countAfterSettle);
        unmount();
      }
      // Malformed path.
      {
        const fetchMock = mockFetch({ capabilities: [availableCapabilities()] });
        window.history.pushState(null, "", "?job=not-a-uuid");
        const { unmount } = render(<App />);
        await screen.findByText("That investigation link isn't valid.");
        // No resume ever ran (malformed short-circuits before
        // invalidateInFlightWorkflows), so only the ordinary mount-time
        // capability read fires — never a duplicate.
        expect(capabilityCalls(fetchMock)).toHaveLength(1);
        unmount();
      }
      // No-job path.
      {
        const fetchMock = mockFetch({ capabilities: [availableCapabilities()] });
        const { unmount } = render(<App />);
        await waitFor(() => expect(capabilityCalls(fetchMock)).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 50));
        expect(capabilityCalls(fetchMock)).toHaveLength(1);
        unmount();
      }
    });
  });

  /**
   * Final Codex re-review Finding 4: a resumed job's approval must never
   * remain visible or actionable under a DIFFERENTLY-resumed job/run.
   * `resumeInvestigationFromJobParam` clears `approval`/`approvalLoadStatus`
   * before hydrating any target snapshot, so job A's reviewer/note/status
   * (and the action-required banner/decision controls it drives) cannot
   * leak onto job B, and only a COMPLETED current run loads its own
   * approval afterward.
   */
  describe("approval is isolated by resumed job/run identity (Finding 4)", () => {
    const RUN_ID_B = "66666666-6666-4666-8666-666666666666";

    function stateFor(jobId: string, runId: string, status: "RUNNING" | "COMPLETED" | "FAILED"): InvestigationStateResponse {
      const base = status === "RUNNING" ? runningState() : status === "COMPLETED" ? completedState() : failedState();
      return { ...base, job: jobResponse({ id: jobId }), run: { ...base.run!, id: runId, jobId } };
    }

    function pendingApproval(runId: string) {
      return jsonResponse(200, { data: { runId, status: "PENDING", reviewerName: null, note: null, decidedAt: null } });
    }
    function approvedApproval(runId: string, reviewerName: string) {
      return jsonResponse(200, {
        data: { runId, status: "APPROVED", reviewerName, note: "looks good", decidedAt: "2026-07-23T10:05:00.000Z" },
      });
    }

    it("job A COMPLETED with a PENDING approval, popstate to job B RUNNING — no old banner/decision controls remain, and B never fetches an approval it cannot use", async () => {
      window.history.pushState(null, "", `?job=${JOB_ID}`);
      const fetchMock = mockFetch({
        investigation: [
          jsonResponse(200, { data: stateFor(JOB_ID, RUN_ID, "COMPLETED") }),
          jsonResponse(200, { data: stateFor(JOB_ID_B, RUN_ID_B, "RUNNING") }),
        ],
        approval: () => pendingApproval(RUN_ID),
      });

      render(<App />);
      await screen.findByText("Agent activity");
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
      expect(screen.getByText("Investigation completed. Human action required — review the proposed action.")).toBeInTheDocument();

      window.history.pushState(null, "", `?job=${JOB_ID_B}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitFor(() => expect(screen.getByText(JOB_ID_B)).toBeInTheDocument());

      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByText("Investigation completed. Human action required — review the proposed action.")).toBeNull();
      // job B is RUNNING — never eligible for approval, so it never issues
      // a second approval fetch; job A's is the only one that ever happened.
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/approval")).length).toBe(1);
    });

    it("job A COMPLETED with an APPROVED (terminal) approval, popstate to job B FAILED — no old reviewer/note/decided-at record remains", async () => {
      window.history.pushState(null, "", `?job=${JOB_ID}`);
      const fetchMock = mockFetch({
        investigation: [
          jsonResponse(200, { data: stateFor(JOB_ID, RUN_ID, "COMPLETED") }),
          jsonResponse(200, { data: stateFor(JOB_ID_B, RUN_ID_B, "FAILED") }),
        ],
        approval: () => approvedApproval(RUN_ID, "job-a-reviewer"),
      });

      render(<App />);
      await screen.findByText("Agent activity");
      await waitFor(() => expect(screen.getByText("job-a-reviewer")).toBeInTheDocument());

      window.history.pushState(null, "", `?job=${JOB_ID_B}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitFor(() => expect(screen.getByText(JOB_ID_B)).toBeInTheDocument());

      expect(screen.queryByText("job-a-reviewer")).toBeNull();
      expect(screen.queryByText("looks good")).toBeNull();
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/approval")).length).toBe(1);
    });

    it("job A PENDING approval, popstate to job B COMPLETED — B loads and shows only its OWN approval, never A's", async () => {
      window.history.pushState(null, "", `?job=${JOB_ID}`);
      const fetchMock = mockFetch({
        investigation: [
          jsonResponse(200, { data: stateFor(JOB_ID, RUN_ID, "COMPLETED") }),
          jsonResponse(200, { data: stateFor(JOB_ID_B, RUN_ID_B, "COMPLETED") }),
        ],
        approval: (input) => {
          const runId = String(input);
          return runId.includes(RUN_ID_B) ? approvedApproval(RUN_ID_B, "job-b-reviewer") : pendingApproval(RUN_ID);
        },
      });

      render(<App />);
      await screen.findByText("Agent activity");
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());

      window.history.pushState(null, "", `?job=${JOB_ID_B}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitFor(() => expect(screen.getByText(JOB_ID_B)).toBeInTheDocument());

      // B's OWN (COMPLETED/APPROVED) approval loads — never A's stale
      // PENDING state (no decision controls, no action-required banner).
      await waitFor(() => expect(screen.getByText("job-b-reviewer")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByText("Investigation completed. Human action required — review the proposed action.")).toBeNull();
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/approval")).length).toBe(2);
    });
  });
});
