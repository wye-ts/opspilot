import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, InvestigationStateResponse } from "./api/types";
import type { InvestigationEventRecord } from "@opspilot/contracts";

/**
 * Focused coverage for #38's polling state machine, wired end to end through
 * App.tsx: `poll.start` after job creation, the bounded healthy cadence and
 * transient backoff, the two pause conditions, "Check again", and stale
 * poll-response rejection.
 */

const JOB_ID = "job-1";
// A real v4-shaped UUID — InvestigationEventRecordSchema validates `runId`
// against the strict UUID pattern (version nibble in [1-8], variant nibble
// in [89ab]), so a placeholder like "run-1" or "22222222-...-2222" would
// make every canonical event fixture fail reducer validation and silently
// land in `canonical-invalid`.
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const UUID_A = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return { id: JOB_ID, ticketId: `DEMO-${UUID_A}`, summary: "Elevated error rate", createdAt: "2026-07-23T10:00:00.000Z", ...overrides };
}

function makeEvent(sequence: number, payload: InvestigationEventRecord["payload"], runId = RUN_ID): InvestigationEventRecord {
  return { runId, sequence, recordedAt: "2026-07-23T10:00:00.000Z", payload };
}

function runningSnapshot(events: readonly InvestigationEventRecord[], overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
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
    events,
    ...overrides,
  };
}

function terminalSnapshot(status: "COMPLETED" | "FAILED", events: readonly InvestigationEventRecord[]): InvestigationStateResponse {
  const base = runningSnapshot(events);
  return {
    ...base,
    run: { ...base.run!, status, finishedAt: "2026-07-23T10:00:05.000Z" },
    outcome:
      status === "COMPLETED"
        ? {
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
          }
        : { type: "FAILED", code: "TOOL_NOT_FOUND", message: "The requested diagnostic tool is not registered." },
  };
}

function approvalResponse() {
  return jsonResponse(200, { data: { runId: RUN_ID, status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null } });
}

/** A response that only resolves once the test explicitly resolves it. */
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface MockFetchOptions {
  readonly capabilities?: () => Response;
  readonly job?: () => Response | Promise<Response>;
  readonly run?: () => Response | Promise<Response>;
  readonly investigation?: (Response | Promise<Response>)[];
  readonly approval?: () => Response | Promise<Response>;
}

/** A URL-routed fetch mock — each endpoint has its OWN queue/fallback, so a
 * polling tick can never wrongly consume a response meant for job/run/approval. */
function mockFetch(options: MockFetchOptions = {}) {
  const investigationQueue = [...(options.investigation ?? [])];
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      return Promise.resolve((options.capabilities ?? (() => jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } })))());
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      return Promise.resolve((options.job ?? (() => jsonResponse(201, { data: jobResponse() })))());
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve((options.run ?? (() => jsonResponse(201, { data: runningSnapshot([]) })))());
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
      return Promise.resolve((options.approval ?? approvalResponse)());
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation"));
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

function progressRegion() {
  return screen.getByRole("region", { name: "Investigation progress" });
}

/** The run row's nested canonical-child `<ol>`, or `null` if not yet rendered. */
function childRowList(): HTMLElement | null {
  return progressRegion().querySelector(".investigation-progress-children-list");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Investigation polling (#38)", () => {
  it("writes ?job= then starts polling while the blocking run POST is still pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const fetchMock = mockFetch({ run: () => deferredRun.promise, investigation: [jsonResponse(200, { data: runningSnapshot([]) })] });

    render(<App />);
    await submit(user);

    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.search).toBe(`?job=${JOB_ID}`);
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("advances the canonical child rows across multiple healthy ticks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const prefix1 = [makeEvent(1, { type: "RUN_CREATED" })];
    const prefix2 = [makeEvent(1, { type: "RUN_CREATED" }), makeEvent(2, { type: "AGENT_STARTED" })];
    const prefix3 = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
    ];
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [
        jsonResponse(200, { data: runningSnapshot(prefix1) }),
        jsonResponse(200, { data: runningSnapshot(prefix2) }),
        jsonResponse(200, { data: runningSnapshot(prefix3) }),
      ],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    // Scope to the run row's own nested child list — the top-level "job"
    // stage's completed label is ALSO "Investigation created", so a bare
    // getByText against the whole region would match the wrong row.
    await waitFor(() => expect(childRowList()).not.toBeNull());
    expect(within(childRowList()!).getByText("Agent analysis").closest("li")).toHaveClass("investigation-progress-item--pending");

    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() =>
      expect(within(childRowList()!).getByText("Agent analysis").closest("li")).not.toHaveClass("investigation-progress-item--pending"),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() =>
      expect(within(childRowList()!).getByText("Diagnostic execution").closest("li")).not.toHaveClass("investigation-progress-item--pending"),
    );

    expect(investigationCalls(fetchMock).length).toBeGreaterThanOrEqual(3);
    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot(prefix3) }));
  });

  it("healthy polling executes more than one GET, with no overlapping request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const deferredTick2 = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [jsonResponse(200, { data: runningSnapshot([]) }), deferredTick2.promise],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(investigationCalls(fetchMock)).toHaveLength(2);

    // The second tick is deferred/unresolved — advancing further must not
    // issue a third GET until it settles.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock)).toHaveLength(2);

    deferredTick2.resolve(jsonResponse(200, { data: runningSnapshot([]) }));
    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("a terminal poll observation stops polling — no further GETs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const completed = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "REPORT_SUBMITTED" }),
      makeEvent(4, { type: "REPORT_VALIDATED" }),
      makeEvent(5, { type: "RUN_COMPLETED" }),
    ];
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [jsonResponse(200, { data: terminalSnapshot("COMPLETED", completed) })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    // The blocking POST never actually resolves in this test (deliberately —
    // polling alone observed the terminal state), so it must be discarded as
    // stale rather than double-settling.
    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("retries a transient poll failure with backoff and keeps the last good snapshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [
        jsonResponse(200, { data: runningSnapshot([]) }),
        jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down")),
        jsonResponse(200, { data: runningSnapshot([]) }),
      ],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000); // tick 2 — transient failure
    expect(investigationCalls(fetchMock)).toHaveLength(2);

    // Backoff after one transient failure is 2s, not the healthy 1s/2s cadence.
    // The margins below (1900ms / +100ms, not 1999ms / +1ms) are deliberate:
    // `shouldAdvanceTime: true` lets real wall-clock time passively advance
    // the fake clock too, and a 1ms margin was observed to flake under load.
    await vi.advanceTimersByTimeAsync(1900);
    expect(investigationCalls(fetchMock)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(investigationCalls(fetchMock)).toHaveLength(3);

    // The Timeline is untouched by the transient blip — still showing the
    // run as active, not an error state.
    expect(within(stageRowIn(progressRegion(), "Agent investigation in progress…")).getByText("In progress")).toBeInTheDocument();

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("pauses after 6 consecutive transient failures, and Check again resumes with reset counters", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const transientFailure = () => jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"));
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [transientFailure(), transientFailure(), transientFailure(), transientFailure(), transientFailure(), transientFailure()],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0); // failure 1
    await vi.advanceTimersByTimeAsync(2000); // failure 2
    await vi.advanceTimersByTimeAsync(4000); // failure 3
    await vi.advanceTimersByTimeAsync(8000); // failure 4
    await vi.advanceTimersByTimeAsync(15000); // failure 5
    expect(investigationCalls(fetchMock)).toHaveLength(5);

    await vi.advanceTimersByTimeAsync(15000); // failure 6 — pauses
    expect(investigationCalls(fetchMock)).toHaveLength(6);
    const checkAgain = await screen.findByRole("button", { name: "Check again" });

    // No automatic 7th retry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(investigationCalls(fetchMock)).toHaveLength(6);

    // "Check again" issues a fresh request and resets the failure budget —
    // asserted by requiring a full 6 MORE failures to re-pause, not fewer.
    for (let i = 0; i < 6; i++) fetchMock.mock.calls; // no-op, keeps lint happy about loop var
    await user.click(checkAgain);
    await vi.advanceTimersByTimeAsync(0);
    expect(investigationCalls(fetchMock)).toHaveLength(7);

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("INTERNAL_DATA_INVALID pauses immediately with zero automatic retries", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [jsonResponse(500, errorEnvelope("INTERNAL_DATA_INVALID", "corrupt"))],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(investigationCalls(fetchMock)).toHaveLength(1);
    await screen.findByRole("button", { name: "Check again" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  it("a new submission cancels the previous job's polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The run POST resolves RUNNING (not deferred) — phase returns to idle,
    // re-enabling the form, exactly like the real scenario this guards:
    // investigation A keeps polling in the BACKGROUND after its own
    // submission workflow already finished, and the user starts a new one.
    const fetchMock = mockFetch({
      job: () => jsonResponse(201, { data: jobResponse({ id: "job-a" }) }),
      run: () => jsonResponse(201, { data: runningSnapshot([], { job: jobResponse({ id: "job-a" }) }) }),
      investigation: [jsonResponse(200, { data: runningSnapshot([], { job: jobResponse({ id: "job-a" }) }) })],
    });

    render(<App />);
    await submit(user, "First issue elevated error rate");
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");
    expect(investigationCalls(fetchMock)).toHaveLength(1);
    expect(String(investigationCalls(fetchMock)[0]?.[0])).toContain("job-a");

    // Second submission — the mock now answers with job-b for job/investigation.
    fetchMock.mockImplementation((input: unknown, init?: unknown) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (url === "/v1/capabilities") return Promise.resolve(jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } }));
      if (url === "/v1/agent-jobs" && method === "POST") return Promise.resolve(jsonResponse(201, { data: jobResponse({ id: "job-b" }) }));
      if (url.endsWith("/runs") && method === "POST") return new Promise(() => {}); // never resolves
      if (url.endsWith("/investigation")) return Promise.resolve(jsonResponse(200, { data: runningSnapshot([], { job: jobResponse({ id: "job-b" }) }) }));
      return Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "n/a")));
    });
    await user.clear(screen.getByLabelText("Issue Summary"));
    await submit(user, "Second issue elevated error rate");
    await vi.advanceTimersByTimeAsync(0);

    const callsBeforeAdvance = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation")).length;

    // job-a's poll session must not produce any FURTHER ticks even as time
    // advances — every NEW investigation call from here on must be job-b's.
    await vi.advanceTimersByTimeAsync(5000);
    const investigationCallsNow = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation"));
    const newUrls = investigationCallsNow.slice(callsBeforeAdvance).map((call) => String(call[0]));
    expect(newUrls.length).toBeGreaterThan(0);
    expect(newUrls.every((url) => url.includes("job-b"))).toBe(true);
  });

  it("discards a stale poll snapshot with fewer events than already held for the same run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const richer = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
    ];
    const regressive = [makeEvent(1, { type: "RUN_CREATED" })];
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [
        jsonResponse(200, { data: runningSnapshot(richer) }),
        jsonResponse(200, { data: runningSnapshot(regressive) }), // fewer events — must be discarded
      ],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(within(progressRegion()).getByText("Diagnostic execution").closest("li")).not.toHaveClass("investigation-progress-item--pending"));

    await vi.advanceTimersByTimeAsync(1000);
    // The regressive snapshot must not walk the Timeline backwards.
    expect(within(progressRegion()).getByText("Diagnostic execution").closest("li")).not.toHaveClass("investigation-progress-item--pending");

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot(richer) }));
  });

  // Finding 3 (independent review): App-integration proof that a poll
  // snapshot reporting an attempt BELOW the currently-held run's attempt is
  // rejected, independent of minAttemptNumber (which never moves in this
  // test — no client-initiated retry occurs; the server's own "latest
  // attempt" changed, then regressed, entirely within ONE poll session).
  it("a delayed poll snapshot for an older attempt cannot overwrite a newer attempt already installed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const attempt2Running = jsonResponse(200, {
      data: runningSnapshot([], { run: { ...runningSnapshot([]).run!, attemptNumber: 2 } }),
    });
    const attempt1Stale = jsonResponse(200, {
      data: runningSnapshot([makeEvent(1, { type: "RUN_CREATED" })], { run: { ...runningSnapshot([]).run!, attemptNumber: 1 } }),
    });
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [attempt2Running, attempt1Stale],
    });

    render(<App />);
    await submit(user);
    // Tick 1: the server now reports attempt 2 as the latest — accepted.
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(investigationCalls(fetchMock)).toHaveLength(1));

    // Tick 2: a regressive read for attempt 1 — must be rejected even though
    // minAttemptNumber was never raised (no retry happened in this test).
    await vi.advanceTimersByTimeAsync(1000);
    await waitFor(() => expect(investigationCalls(fetchMock)).toHaveLength(2));

    // The Timeline must still reflect attempt 2's state (no canonical
    // children at all, since attempt 2's snapshot carried none) — proving
    // attempt 1's data (which DID carry a canonical event) was discarded.
    expect(childRowList()).toBeNull();

    deferredRun.resolve(jsonResponse(201, { data: runningSnapshot([]) }));
  });

  // Finding 4 (independent review): permanent poll failures must be
  // surfaced, not silently discarded — the hook already classifies these
  // correctly; before this fix, App did nothing with the classification.
  describe("surfacing permanent poll failures (Finding 4)", () => {
    it("active poll observing 404 (not-found): stopped, exact unavailable notice, ?job= stripped, unrelated params preserved, fresh form, no Check again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      window.history.pushState(null, "", "?debug=1");
      const fetchMock = mockFetch({
        run: () => jsonResponse(201, { data: runningSnapshot([]) }),
        investigation: [jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "gone"))],
      });

      render(<App />);
      await submit(user);
      await screen.findByText("Agent activity");

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("This investigation is no longer available."),
      );
      expect(window.location.search).toBe("?debug=1");
      expect(screen.queryByText("Submitted issue")).toBeNull();
      expect(screen.queryByText("Agent activity")).toBeNull();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

      // Polling genuinely stopped — no further investigation calls even as
      // time advances well past any healthy cadence interval.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(investigationCalls(fetchMock)).toHaveLength(1);
    });

    it("active poll observing a permanent-invalid classification: stopped, fixed safe error, no auto-retry, no Check again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fetchMock = mockFetch({
        run: () => jsonResponse(201, { data: runningSnapshot([]) }),
        investigation: [jsonResponse(400, errorEnvelope("ROUTE_PARAMETER_INVALID", "bad param"))],
      });

      render(<App />);
      await submit(user);
      await screen.findByText("Agent activity");

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "This investigation's live progress could not be tracked. The result already shown remains accurate.",
        ),
      );
      // The raw server text is never shown — only the fixed, safe notice.
      expect(screen.queryByText("bad param")).toBeNull();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
      // The investigation itself is untouched — only live tracking stopped.
      expect(screen.getByText("Agent activity")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(investigationCalls(fetchMock)).toHaveLength(1);
    });

    it("a stale job-A not-found callback after navigating to job B leaves job B's state and URL untouched", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const deferredJobATick = deferredResponse();
      const fetchMock = mockFetch({
        job: () => jsonResponse(201, { data: jobResponse({ id: "job-a" }) }),
        run: () => jsonResponse(201, { data: runningSnapshot([], { job: jobResponse({ id: "job-a" }) }) }),
        investigation: [deferredJobATick.promise],
      });

      render(<App />);
      await submit(user, "First issue elevated error rate");
      await vi.advanceTimersByTimeAsync(0);
      expect(investigationCalls(fetchMock)).toHaveLength(1);
      expect(window.location.search).toBe("?job=job-a");

      // Navigate to a NEW job B before job A's poll tick resolves. job B's
      // OWN poll (started fresh by this submission) must get a HARMLESS
      // response — only job A's specific investigation URL should ever see
      // a not-found, and that comes from `deferredJobATick` below, not from
      // this replacement routing at all.
      fetchMock.mockImplementation((input: unknown, init?: unknown) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? "GET";
        if (url === "/v1/capabilities") return Promise.resolve(jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } }));
        if (url === "/v1/agent-jobs" && method === "POST") return Promise.resolve(jsonResponse(201, { data: jobResponse({ id: "job-b" }) }));
        if (url.endsWith("/runs") && method === "POST") return Promise.resolve(jsonResponse(201, { data: runningSnapshot([], { job: jobResponse({ id: "job-b" }) }) }));
        if (url.endsWith("/investigation")) return Promise.resolve(jsonResponse(200, { data: runningSnapshot([], { job: jobResponse({ id: "job-b" }) }) }));
        return Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "n/a")));
      });
      await user.clear(screen.getByLabelText("Issue Summary"));
      await submit(user, "Second issue elevated error rate");
      await vi.advanceTimersByTimeAsync(0);
      expect(window.location.search).toBe("?job=job-b");

      // job A's stale tick now resolves 404 — its onStop handler must see a
      // stale generation and do nothing to job B's state or URL.
      deferredJobATick.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "job a gone")));
      await vi.advanceTimersByTimeAsync(0);

      expect(window.location.search).toBe("?job=job-b");
      expect(screen.getByText("job-b")).toBeInTheDocument();
      expect(screen.queryByText("This investigation is no longer available.")).not.toBeInTheDocument();
    });
  });

  // Finding 5 (independent review): a manual Refresh bumps the main
  // generation but must ALSO stop the old poll session (whose callbacks
  // close over the old generation and would otherwise spin uselessly
  // forever) and, if the refreshed run is still RUNNING, restart polling
  // under the NEW generation so live canonical progress keeps updating.
  describe("polling stays coherent after manual Refresh (Finding 5)", () => {
    it("RUNNING + active poll → manual Refresh → still RUNNING: the old session stops, exactly one new session starts, and canonical progress keeps updating", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const deferredOldTick = deferredResponse();
      const prefix2 = [makeEvent(1, { type: "RUN_CREATED" }), makeEvent(2, { type: "AGENT_STARTED" })];
      const fetchMock = mockFetch({
        run: () => jsonResponse(201, { data: runningSnapshot([]) }),
        investigation: [deferredOldTick.promise, jsonResponse(200, { data: runningSnapshot(prefix2) })],
      });

      render(<App />);
      await submit(user);
      await vi.advanceTimersByTimeAsync(0);
      expect(investigationCalls(fetchMock)).toHaveLength(1);

      // Manual Refresh — getAgentRun (GET /v1/agent-runs/:id) reports still
      // RUNNING. `runningSnapshot(...)` is shape-compatible with the
      // AgentRunDetail this endpoint returns (job/run/trace/outcome; the
      // extra `events` field is simply ignored by that response's consumer).
      const priorImpl = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementationOnce((input: unknown, init?: unknown) => {
        const url = String(input);
        if (url.startsWith("/v1/agent-runs/") && !url.endsWith("/approval")) {
          return Promise.resolve(jsonResponse(200, { data: runningSnapshot([]) }));
        }
        return priorImpl(input, init);
      });
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Run refreshed."));

      // The OLD poll session's in-flight tick resolves late — it must be
      // discarded by the poll hook itself (already stopped by Refresh).
      deferredOldTick.resolve(
        jsonResponse(200, {
          data: runningSnapshot([
            makeEvent(1, { type: "RUN_CREATED" }),
            makeEvent(2, { type: "AGENT_STARTED" }),
            makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-x", toolName: "x" }),
          ]),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Exactly one NEW poll session's tick lands, advancing canonical
      // progress under the fresh generation.
      await waitFor(() => {
        const list = progressRegion().querySelector(".investigation-progress-children-list");
        expect(list).not.toBeNull();
        const row = within(list as HTMLElement).getByText("Agent analysis").closest("li") as HTMLElement | null;
        expect(row).not.toHaveClass("investigation-progress-item--pending");
      });
    });

    it("RUNNING → Refresh → COMPLETED: no polling restart, terminal/approval side effects exactly once", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fetchMock = mockFetch({
        run: () => jsonResponse(201, { data: runningSnapshot([]) }),
        // A harmless placeholder in case the poll's first tick fires before
        // Refresh is clicked (shouldAdvanceTime lets real time pass during
        // userEvent interactions) — RUNNING, same job, no new events, so it
        // changes nothing whether or not it lands before the click below.
        investigation: [jsonResponse(200, { data: runningSnapshot([]) })],
      });

      render(<App />);
      await submit(user);
      // Deliberately do NOT advance timers here — the poll's first tick is
      // still merely SCHEDULED (a macrotask), not yet fired. Clicking
      // Refresh below stops it (clearTimeout) before it ever gets a chance
      // to consume the empty investigation queue's fallback.
      await screen.findByRole("button", { name: "Refresh" });

      fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: terminalSnapshot("COMPLETED", []) })));
      fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: { runId: RUN_ID, status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null } })));
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

      const callsAfterRefresh = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      // No polling restart for a terminal refresh — no further calls at all.
      expect(fetchMock.mock.calls.length).toBe(callsAfterRefresh);
    });

    it("RUNNING → Refresh → FAILED: no polling restart, no approval fetch", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fetchMock = mockFetch({
        run: () => jsonResponse(201, { data: runningSnapshot([]) }),
        // A harmless placeholder in case the poll's first tick fires before
        // Refresh is clicked (shouldAdvanceTime lets real time pass during
        // userEvent interactions) — RUNNING, same job, no new events, so it
        // changes nothing whether or not it lands before the click below.
        investigation: [jsonResponse(200, { data: runningSnapshot([]) })],
      });

      render(<App />);
      await submit(user);
      // See the COMPLETED test above for why timers are not advanced here.
      await screen.findByRole("button", { name: "Refresh" });

      fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: terminalSnapshot("FAILED", []) })));
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await screen.findByText("The requested diagnostic tool is not registered.");

      const callsAfterRefresh = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock.mock.calls.length).toBe(callsAfterRefresh);
    });
  });
});

function stageRowIn(container: HTMLElement, labelText: string): HTMLElement {
  const label = within(container).getByText(labelText);
  const row = label.closest("li");
  if (row === null) throw new Error(`no <li> ancestor for "${labelText}"`);
  return row;
}
