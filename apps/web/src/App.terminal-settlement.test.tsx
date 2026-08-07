import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, InvestigationStateResponse } from "./api/types";

/**
 * Focused coverage for #38's terminal settlement coordinator, wired end to
 * end through App.tsx: the blocking POST and the poller are two independent
 * observers of the same run, and `resolveTerminalObservation` decides
 * ownership BEFORE any terminal state write, for every ordering.
 */

const JOB_ID = "job-1";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID_2 = "55555555-5555-4555-8555-555555555555";
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

function completedRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: RUN_ID,
      jobId: JOB_ID,
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:05.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
      estimatedCostUsd: null,
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
  };
}

function failedRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      ...completedRunDetail().run,
      status: "FAILED",
    },
    trace: [],
    outcome: { type: "FAILED", code: "TOOL_NOT_FOUND", message: "The requested diagnostic tool is not registered." },
  };
}

function investigationSnapshotFromRunDetail(detail: AgentRunDetail): InvestigationStateResponse {
  return { job: detail.job, run: detail.run, trace: detail.trace, outcome: detail.outcome, events: [] };
}

/** A strictly NEWER attempt of the SAME job — a different run id, attemptNumber 2. */
function runningAttempt2Snapshot(): InvestigationStateResponse {
  return {
    job: jobResponse(),
    run: {
      id: RUN_ID_2,
      jobId: JOB_ID,
      attemptNumber: 2,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:05:00.000Z",
      finishedAt: null,
      createdAt: "2026-07-23T10:05:00.000Z",
      estimatedCostUsd: null,
    },
    trace: [],
    outcome: { type: "RUNNING" },
    events: [],
  };
}

function attemptText(): string | null {
  return screen.getByText("Attempt").closest("div")?.querySelector("dd")?.textContent ?? null;
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
  readonly job?: () => Response | Promise<Response>;
  readonly run?: () => Response | Promise<Response>;
  readonly investigation?: (Response | Promise<Response>)[];
  readonly approval?: () => Response | Promise<Response>;
}

function mockFetch(options: MockFetchOptions = {}) {
  const investigationQueue = [...(options.investigation ?? [])];
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      return Promise.resolve(jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } }));
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      return Promise.resolve((options.job ?? (() => jsonResponse(201, { data: jobResponse() })))());
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve((options.run ?? (() => jsonResponse(201, { data: completedRunDetail() })))());
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      console.log("[DEBUG investigation call]", "remaining:", investigationQueue.length, "got-undefined:", next === undefined);
      if (next === undefined) return Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "no more scripted ticks")));
      return Promise.resolve(next);
    }
    if (url.endsWith("/approval")) return Promise.resolve((options.approval ?? approvalResponse)());
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function approvalCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/approval")).length;
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Terminal settlement coordinator (#38)", () => {
  // Also covers "duplicate terminal poll snapshot": the SECOND observer of
  // an identical terminal status, whichever source it is, is structurally
  // a "duplicate" decision — resolveTerminalObservation cannot distinguish
  // "poll observed twice" from "poll then POST observed the same status",
  // and the poll hook's own design (see useInvestigationPoll.ts) makes two
  // terminal ticks from the SAME session unreachable: the first terminal
  // tick's callback stops the session synchronously, before any next tick
  // could ever be scheduled.
  it("poll observes COMPLETED first, POST observes COMPLETED second — side effects exactly once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");
    expect(approvalCallCount(fetchMock)).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");

    // The late POST resolves with the IDENTICAL terminal status — a
    // "duplicate" decision, not a second "owner".
    deferredRun.resolve(jsonResponse(201, { data: completedRunDetail() }));
    await vi.advanceTimersByTimeAsync(0);

    expect(approvalCallCount(fetchMock)).toBe(1);
    expect(screen.getByText("Generated report")).toBeInTheDocument();
  });

  it("POST observes COMPLETED first, poll observes COMPLETED second — side effects exactly once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: completedRunDetail() }),
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
    });

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    expect(approvalCallCount(fetchMock)).toBe(1);

    // The poll tick (scheduled at delay 0, resolved after the POST already
    // settled) observes the SAME terminal status.
    await vi.advanceTimersByTimeAsync(0);

    expect(approvalCallCount(fetchMock)).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
  });

  it("poll observes COMPLETED first; a late POST observes FAILED for the same run — first state preserved, safe notice, no second settlement", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await screen.findByText("Agent activity");
    expect(approvalCallCount(fetchMock)).toBe(1);

    // The late POST reports FAILED for the identical run/attempt/generation
    // — a genuine internal-consistency contradiction.
    deferredRun.resolve(jsonResponse(201, { data: failedRunDetail() }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "This investigation reported inconsistent results and could not be settled. Refresh or start a new investigation.",
      ),
    );

    // The FIRST accepted terminal state (COMPLETED) stands, untouched — still
    // the COMPLETED report shape, never overwritten by the contradictory
    // FAILED candidate.
    expect(screen.getByText("No evidence was recorded.")).toBeInTheDocument();
    expect(screen.queryByText("The requested diagnostic tool is not registered.")).toBeNull();
    // No second approval fetch from the contradictory FAILED observation.
    expect(approvalCallCount(fetchMock)).toBe(1);
  });

  it("POST observes FAILED first; a late in-flight poll tick reporting COMPLETED is discarded — first state preserved, no state or notice change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredTick = deferredResponse();
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: failedRunDetail() }),
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs its OWN authoritative getInvestigationState read — which
      // hits this SAME /investigation queue, consuming its first slot,
      // BEFORE the poll's own delayed tick ever fires. A harmless 404 there
      // (caught by applyObservedRunOutcome's own try/catch, never reaching
      // the poll hook's not-found handling at all) falls back to the POST's
      // own FAILED candidate — leaving `deferredTick.promise` as the SECOND
      // slot, still reserved for the actually-late poll tick this test is
      // about.
      investigation: [jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "not needed for this test")), deferredTick.promise],
    });

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    expect(approvalCallCount(fetchMock)).toBe(0);
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");

    // The POST's FAILED observation already called poll.stop("terminal")
    // synchronously (before this tick could ever resolve) — the poll HOOK
    // itself discards a response from an already-stopped session (its own
    // internal generation no longer matches) before ever reaching the App's
    // callback. So the late tick resolving with a CONTRADICTORY status here
    // is silently dropped one layer earlier than resolveTerminalObservation
    // — an even safer outcome than surfacing the inconsistency notice, and
    // exactly why the reverse ordering (poll first, §"poll observes COMPLETED
    // first" above) is the one that reaches the coordinator's own
    // inconsistent-status branch: only the POST path has no such self-filter,
    // since poll.stop() never touches the MAIN workflow generation `isStale`
    // checks against.
    deferredTick.resolve(jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) }));
    await vi.advanceTimersByTimeAsync(0);

    // The FIRST accepted terminal state (FAILED) stands — the report panel
    // still shows the FAILURE shape (ReportPanel renders a "Generated
    // report" heading for both outcomes, so the failure-specific content is
    // the distinguishing check), no approval fetch, and the notice is
    // UNCHANGED (the late tick never reached the coordinator at all, so no
    // "inconsistent" notice is shown either).
    expect(screen.getByText("The requested diagnostic tool is not registered.")).toBeInTheDocument();
    expect(screen.queryByText("No evidence was recorded.")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(approvalCallCount(fetchMock)).toBe(0);
  });

  it("a stale POST from an abandoned investigation cannot mutate state after popstate navigates away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunA = deferredResponse();
    // No investigation-endpoint response is queued: any poll tick (including
    // the one scheduled at delay 0 right after job creation) must fall
    // through to the harmless 404 default, so the ONLY pending observer by
    // the time navigation happens is the run POST itself.
    const fetchMock = mockFetch({
      job: () => jsonResponse(201, { data: jobResponse({ id: "job-a" }) }),
      run: () => deferredRunA.promise,
    });

    render(<App />);
    await submit(user, "First issue elevated error rate");
    await vi.advanceTimersByTimeAsync(0);
    expect(window.location.search).toBe("?job=job-a");

    // Navigate away (Back to the fresh form) while job-a's run POST is still
    // pending — invalidateInFlightWorkflows bumps the main generation BEFORE
    // any state is reset.
    window.history.pushState(null, "", "?");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText("Submitted issue")).toBeNull();
    expect(screen.queryByText("job-a")).toBeNull();

    // job-a's run POST NOW resolves COMPLETED — a stale response from a
    // superseded workflow generation, which must be discarded entirely.
    deferredRunA.resolve(jsonResponse(201, { data: { ...completedRunDetail(), job: jobResponse({ id: "job-a" }) } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText("Submitted issue")).toBeNull();
    expect(screen.queryByText("Generated report")).toBeNull();
    expect(approvalCallCount(fetchMock)).toBe(0);
    expect(window.location.search).toBe("");
  });
});

const TERMINAL_INCONSISTENCY_TEXT =
  "This investigation reported inconsistent results and could not be settled. Refresh or start a new investigation.";

/**
 * Independent review Finding 3 (Codex review): terminal ownership is
 * claimed BEFORE any asynchronous finalization work, but the owner only
 * checked staleness (`isStale(generation)`) after its awaits — never
 * whether a CONTRADICTORY observation had, in the meantime, already marked
 * this identity `inconsistent`. Both races below use REAL deferred promises
 * so the dangerous interleaving (owner mid-await when the contradiction
 * arrives) is actually exercised, not simulated via serial responses.
 */
describe("durable contradiction handling survives an in-flight owner continuation (Finding 3)", () => {
  it("Case A: POST FAILED claims owner, its authoritative final read is deferred, a poll COMPLETED tick contradicts it, then the deferred read resolves — the inconsistency notice remains authoritative, no FAILED continuation writes, no approval/clock rewrite", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredFinalRead = deferredResponse();
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: failedRunDetail() }),
      // Slot 1: the FAILED POST's own authoritative final read (Finding 1's
      // mechanism) — deferred, so it is genuinely in flight when the
      // contradiction below arrives. Slot 2: the poll's own first tick.
      investigation: [deferredFinalRead.promise, jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
    });

    render(<App />);
    await submit(user);

    // The POST's own authoritative-read fetch fires via plain promise
    // chaining (no timer involved) and always wins the race to consume
    // slot 1 before the poll's setTimeout-scheduled tick can fire — proven
    // here by waiting for exactly one /investigation call to have been made
    // while `deferredFinalRead` is still unresolved (asserted below).
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length).toBeGreaterThanOrEqual(1));

    // The poll's tick fires (immediately, or passively via
    // `shouldAdvanceTime` — either way it is the SECOND /investigation
    // call) and reports COMPLETED for the SAME identity: a genuine
    // contradiction while the FAILED owner's authoritative read is still
    // pending on `deferredFinalRead`, which nothing above has resolved yet.
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT));
    expect(approvalCallCount(fetchMock)).toBe(0);

    // NOW resolve the deferred final read the FAILED owner's continuation
    // was awaiting.
    deferredFinalRead.resolve(jsonResponse(200, { data: investigationSnapshotFromRunDetail(failedRunDetail()) }));
    await vi.advanceTimersByTimeAsync(0);

    // The inconsistency notice remains — the FAILED owner's continuation
    // must NOT have resumed and overwritten it with the ordinary
    // "Investigation failed…" notice, and must not have fetched approval.
    expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);
    expect(approvalCallCount(fetchMock)).toBe(0);
  });

  it("Case B: poll COMPLETED claims owner, its approval fetch is deferred, a contradictory POST FAILED arrives, then the deferred approval resolves — the inconsistency notice remains authoritative, no approval result is applied, no completion notice overwrite", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunPost = deferredResponse();
    const deferredApproval = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRunPost.promise,
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
      approval: () => deferredApproval.promise,
    });

    render(<App />);
    await submit(user);

    // The poll's first tick (delay 0) fires and observes COMPLETED — it
    // becomes owner BEFORE the (deferred) run POST resolves at all.
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/approval"))).toBe(true));
    expect(screen.queryByRole("status")).not.toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);

    // The run POST NOW resolves FAILED for the SAME run/attempt/generation
    // — a genuine contradiction while the poll-COMPLETED owner's approval
    // fetch is still pending.
    deferredRunPost.resolve(jsonResponse(201, { data: failedRunDetail() }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT));

    // NOW resolve the deferred approval GET the poll-COMPLETED owner's
    // continuation was awaiting, with a PENDING approval.
    deferredApproval.resolve(
      jsonResponse(200, { data: { runId: RUN_ID, status: "PENDING", reviewerName: null, note: null, decidedAt: null } }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // The inconsistency notice remains — the poll-COMPLETED owner's
    // continuation must NOT have overwritten it with the ordinary
    // completion notice, and the resolved PENDING approval must NOT be
    // applied (no ActionRequiredBanner, no Approve button).
    expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // Final Codex re-review Finding 2: NO approval-stage completion either —
    // `approvalLoadStatus` must not have moved to "loaded" from this
    // now-unauthorized continuation. It was written "loading" before the
    // contradiction (a legitimate write, made while still the authorized
    // owner) and stays there — never "Approval state loaded".
    expect(screen.getByText("Loading approval state…")).toBeInTheDocument();
    expect(screen.queryByText("Approval state loaded")).toBeNull();
  });

  it("Case B (failure ordering, final Codex re-review Finding 2): poll COMPLETED claims owner, its approval fetch is deferred, a contradictory POST FAILED arrives, then the deferred approval REJECTS — zero writes from the stale continuation: no error banner, no status/notice change, no approval-stage change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunPost = deferredResponse();
    const deferredApproval = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRunPost.promise,
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
      approval: () => deferredApproval.promise,
    });

    render(<App />);
    await submit(user);

    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/approval"))).toBe(true));

    deferredRunPost.resolve(jsonResponse(201, { data: failedRunDetail() }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT));

    // NOW reject the deferred approval GET the poll-COMPLETED owner's
    // continuation was awaiting — a network/server failure arriving AFTER
    // the identity was already marked inconsistent.
    deferredApproval.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db unreachable")));
    await vi.advanceTimersByTimeAsync(0);

    // Zero writes from the now-unauthorized continuation: the inconsistency
    // notice stands (never overwritten by an error banner's message, and no
    // separate ErrorBanner element appears), the approval stage never moved
    // to "failed", and `approval` was never cleared/rewritten by this
    // rejection (nothing to clear — it was already null).
    expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);
    expect(document.querySelector(".error-banner")).toBeNull();
    expect(screen.getByText("Loading approval state…")).toBeInTheDocument();
    expect(screen.queryByText("Approval state loaded")).toBeNull();
  });
});

/**
 * Independent review Finding 4 (Codex review): current-attempt monotonicity
 * was enforced only for `source === "poll"` — a POST-sourced terminal
 * candidate (or its authoritative final-read continuation) could still
 * regress a strictly newer attempt already accepted by polling. Both races
 * below use a REAL deferred promise for attempt 1's authoritative final
 * read so attempt 2 can genuinely be accepted by polling WHILE that read is
 * still in flight — not simulated via serial responses.
 */
describe("cross-attempt monotonicity for POST/final-read continuations (Finding 4)", () => {
  /**
   * Both tests below fully control the ORDER of every fetch, via a
   * deferred run POST, rather than relying on the implicit ordering
   * between a microtask-chained fetch (the run POST's own continuation)
   * and a timer-scheduled one (the poll's tick) — that ordering is not
   * guaranteed under `shouldAdvanceTime: true` combined with userEvent's
   * own internal timer advancement, and was observed to vary. Sequence:
   * poll tick 1 (job-only, ignored) → run POST resolves terminal attempt 1
   * and starts its OWN authoritative final read (deterministically the
   * NEXT investigation call) → poll tick 2 (healthy cadence, ~1s later)
   * accepts attempt 2 WHILE attempt 1's final read is still pending.
   */
  const jobOnlySnapshot: InvestigationStateResponse = { job: jobResponse(), run: null, trace: [], outcome: null, events: [] };

  it("attempt 1's deferred final read resolves MATCHING attempt 1, after polling already accepted attempt 2 — attempt 2 remains current", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunPost = deferredResponse();
    const deferredFinalRead = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRunPost.promise,
      investigation: [jsonResponse(200, { data: jobOnlySnapshot }), deferredFinalRead.promise, jsonResponse(200, { data: runningAttempt2Snapshot() })],
    });

    render(<App />);
    await submit(user);
    // Poll's first tick observes job-only — ignored by onSnapshot ("keep
    // polling"). The run POST is still fully deferred: nothing terminal
    // has happened yet.
    await vi.advanceTimersByTimeAsync(0);

    // NOW resolve the run POST as attempt 1's terminal COMPLETED candidate
    // — it claims owner and deterministically starts its OWN authoritative
    // final read next (consuming slot 2, `deferredFinalRead`, which stays
    // pending).
    deferredRunPost.resolve(jsonResponse(201, { data: completedRunDetail() }));
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length).toBeGreaterThanOrEqual(2));

    // Attempt 1's final read is now genuinely in flight. The poll's NEXT
    // tick (healthy cadence, ~1s) fires and observes that a DIFFERENT
    // client/tab already started attempt 2 — consuming slot 3.
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(attemptText()).toBe("2"));
    const investigationCallsBeforeResolve = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length;

    // NOW resolve attempt 1's deferred final read, MATCHING attempt 1's own
    // identity exactly (a clean, non-mismatched authoritative confirmation
    // of the ORIGINAL, now-superseded candidate).
    deferredFinalRead.resolve(jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) }));
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 2 remains current — never regressed to attempt 1's terminal
    // state — and its own polling session was never stopped by attempt 1's
    // (now-discarded) continuation: a further tick still gets through.
    expect(attemptText()).toBe("2");
    expect(screen.queryByRole("status")).not.toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length).toBeGreaterThan(investigationCallsBeforeResolve);
  });

  it("attempt 1's deferred final read instead resolves with the LATEST attempt 2 — attempt 2 remains current, its events remain current, and its polling session stays live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunPost = deferredResponse();
    const deferredFinalRead = deferredResponse();
    const fetchMock = mockFetch({
      run: () => deferredRunPost.promise,
      investigation: [jsonResponse(200, { data: jobOnlySnapshot }), deferredFinalRead.promise, jsonResponse(200, { data: runningAttempt2Snapshot() })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);

    deferredRunPost.resolve(jsonResponse(201, { data: completedRunDetail() }));
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length).toBeGreaterThanOrEqual(2));

    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(attemptText()).toBe("2"));

    // Attempt 1's final read resolves with a MISMATCHED identity — it
    // reports the LATEST attempt (2), not attempt 1. `matchesExpectedIdentity`
    // rejects this as a match for the ORIGINAL attempt-1 candidate, so the
    // fallback path is exercised too; either way, attempt 2 (already
    // current) must never be replaced by a fallback to the stale attempt-1
    // candidate.
    deferredFinalRead.resolve(jsonResponse(200, { data: runningAttempt2Snapshot() }));
    await vi.advanceTimersByTimeAsync(0);

    expect(attemptText()).toBe("2");
    expect(screen.queryByRole("status")).not.toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT);

    // The polling session that delivered attempt 2 is still live — proven
    // by a further tick still updating the Timeline once attempt 2 itself
    // terminates.
    const completedAttempt2: InvestigationStateResponse = {
      ...runningAttempt2Snapshot(),
      run: { ...runningAttempt2Snapshot().run!, status: "COMPLETED", finishedAt: "2026-07-23T10:06:00.000Z" },
      outcome: {
        type: "COMPLETED",
        report: {
          category: "UNKNOWN",
          summary: "s2",
          rootCause: "r2",
          customerImpact: "c2",
          recommendedResolution: "rr2",
          confidence: 0.5,
          evidence: [],
          suggestedActions: [],
        },
      },
    };
    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: completedAttempt2 })));
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));
    expect(attemptText()).toBe("2");
  });
});

/**
 * Final Codex re-review Finding 1 (P1): the previous fix only rechecked
 * monotonicity AFTER the authoritative final read resolved by comparing
 * against `runRef.current` — but if the read itself is what FIRST discovers
 * the newer attempt (i.e. no attempt-2 poll tick has landed yet),
 * `matchesExpectedIdentity` rejected the mismatch and fell back to settling
 * the OLD attempt, stopping polling in the process. And a same-identity
 * authoritative read reporting the OPPOSITE terminal status from the POST's
 * own candidate fell into the same "mismatch -> fallback" bucket instead of
 * being treated as the internal-consistency contradiction it is.
 */
describe("authoritative final-read newer-attempt and same-identity contradiction handling (final Codex re-review Finding 1)", () => {
  const jobOnlySnapshot: InvestigationStateResponse = { job: jobResponse(), run: null, trace: [], outcome: null, events: [] };

  it("authoritative final read discovers a newer attempt BEFORE any attempt-2 poll tick — attempt 1 never settles, attempt 2 is retained, and its polling session remains live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRunPost = deferredResponse();
    const completedAttempt2: InvestigationStateResponse = {
      ...runningAttempt2Snapshot(),
      run: { ...runningAttempt2Snapshot().run!, status: "COMPLETED", finishedAt: "2026-07-23T10:06:00.000Z" },
      outcome: {
        type: "COMPLETED",
        report: {
          category: "UNKNOWN",
          summary: "s2",
          rootCause: "r2",
          customerImpact: "c2",
          recommendedResolution: "rr2",
          confidence: 0.5,
          evidence: [],
          suggestedActions: [],
        },
      },
    };
    const fetchMock = mockFetch({
      run: () => deferredRunPost.promise,
      investigation: [
        jsonResponse(200, { data: jobOnlySnapshot }), // poll tick 1 — job-only, ignored
        jsonResponse(200, { data: runningAttempt2Snapshot() }), // attempt-1 POST's OWN authoritative final read — discovers attempt 2, RUNNING, strictly before attempt 2's own poll tick
        jsonResponse(200, { data: completedAttempt2 }), // the SAME (never-stopped) poll session's next tick
      ],
    });

    render(<App />);
    await submit(user);
    // Poll's first tick observes job-only — ignored. The run POST is still
    // fully deferred: nothing terminal has happened yet, so no attempt-2
    // poll tick can have fired either.
    await vi.advanceTimersByTimeAsync(0);

    // NOW resolve the run POST as attempt 1's terminal COMPLETED candidate
    // — it claims owner, and its OWN authoritative final read (the
    // deterministic next /investigation call, via plain promise chaining
    // rather than a timer) resolves with attempt 2 immediately — strictly
    // BEFORE the poll session's next tick (healthy cadence, ~1s later)
    // could ever fire.
    deferredRunPost.resolve(jsonResponse(201, { data: completedRunDetail() }));
    await waitFor(() => expect(attemptText()).toBe("2"));

    // Attempt 1 never settled: no completion notice, no approval fetch —
    // the Timeline reflects attempt 2 instead.
    expect(screen.queryByText("Investigation complete.")).toBeNull();
    expect(approvalCallCount(fetchMock)).toBe(0);

    const investigationCallsSoFar = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length;
    expect(investigationCallsSoFar).toBe(2);

    // Attempt 2's polling session remains LIVE — a further tick still
    // fetches, and here observes attempt 2 itself go terminal.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/investigation")).length).toBeGreaterThan(investigationCallsSoFar);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));
    expect(attemptText()).toBe("2");
  });

  it("POST candidate COMPLETED, authoritative final read reports FAILED for the identical job/run/attempt — marked inconsistent, never falls back to the POST candidate", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: completedRunDetail() }),
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(failedRunDetail()) })],
    });

    render(<App />);
    await submit(user);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT));
    // Neither the POST's COMPLETED candidate nor the authoritative FAILED
    // read was ever applied as a settled run.
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(approvalCallCount(fetchMock)).toBe(0);
  });

  it("POST candidate FAILED, authoritative final read reports COMPLETED for the identical job/run/attempt — marked inconsistent, never falls back to the POST candidate", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: failedRunDetail() }),
      investigation: [jsonResponse(200, { data: investigationSnapshotFromRunDetail(completedRunDetail()) })],
    });

    render(<App />);
    await submit(user);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(TERMINAL_INCONSISTENCY_TEXT));
    expect(screen.queryByText("Agent activity")).toBeNull();
    expect(approvalCallCount(fetchMock)).toBe(0);
  });
});
