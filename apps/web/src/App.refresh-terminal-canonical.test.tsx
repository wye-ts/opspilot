import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, InvestigationStateResponse } from "./api/types";

/**
 * Independent review Finding 2 (Codex review): a manual Refresh that
 * observes a terminal outcome for the FIRST time (the run was RUNNING a
 * moment ago) must obtain authoritative canonical facts before permanently
 * settling the Timeline — the legacy `getAgentRun` read Refresh uses has no
 * `events[]` at all, so without this fix a partial canonical RUNNING prefix
 * already displayed freezes forever beneath a terminal parent.
 *
 * Every race below uses a REAL deferred promise so the dangerous
 * interleaving (a stale poll tick resolving AFTER Refresh already
 * committed to a new generation) is actually exercised.
 */

const JOB_ID = "job-1";
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

function runningRunDetail(): AgentRunDetail {
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
  };
}

const PARTIAL_CANONICAL_EVENTS = [
  { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" as const } },
  { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" as const } },
];

const FULL_COMPLETED_EVENTS = [
  ...PARTIAL_CANONICAL_EVENTS,
  { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" as const } },
  { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" as const } },
  { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" as const } },
];

const FULL_FAILED_EVENTS = [
  ...PARTIAL_CANONICAL_EVENTS,
  { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "TOOL_REQUESTED" as const, toolCallId: "call-1", toolName: "get_service_status" } },
  {
    runId: RUN_ID,
    sequence: 4,
    recordedAt: "2026-07-23T10:00:03.000Z",
    payload: { type: "TOOL_FAILED" as const, toolCallId: "call-1", toolName: "get_service_status", failureCode: "TOOL_EXECUTION_FAILED" as const },
  },
  {
    runId: RUN_ID,
    sequence: 5,
    recordedAt: "2026-07-23T10:00:04.000Z",
    payload: { type: "RUN_FAILED" as const, failureCode: "TOOL_EXECUTION_FAILED" as const, failedStage: "DIAGNOSTIC_EXECUTION" as const },
  },
];

function legacyCompletedRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: { ...runningRunDetail().run, status: "COMPLETED", finishedAt: "2026-07-23T10:00:05.000Z" },
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

function legacyFailedRunDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: { ...runningRunDetail().run, status: "FAILED", finishedAt: "2026-07-23T10:00:05.000Z" },
    trace: [],
    outcome: { type: "FAILED", code: "TOOL_NOT_FOUND", message: "The requested diagnostic tool is not registered." },
  };
}

function investigationState(run: AgentRunDetail, events: readonly unknown[]): InvestigationStateResponse {
  return { job: run.job, run: run.run, trace: run.trace, outcome: run.outcome, events: events as InvestigationStateResponse["events"] };
}

function partialRunningSnapshot(): InvestigationStateResponse {
  return investigationState(runningRunDetail(), PARTIAL_CANONICAL_EVENTS);
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
  readonly investigation?: (Response | Promise<Response>)[];
  readonly agentRun?: () => Response | Promise<Response>;
  readonly approval?: () => Response | Promise<Response>;
}

/**
 * `setPostRefreshInvestigationResponse` is deliberately a MUTABLE holder,
 * not a one-shot queue entry: `shouldAdvanceTime: true` can let an EXTRA
 * poll tick fire passively (racing real wall-clock time against the fake
 * clock) at an unpredictable point relative to when a test clicks Refresh.
 * Once set, every `/investigation` call — whether it is Refresh's own
 * authoritative read or a stray extra poll tick — receives the SAME
 * terminal snapshot, which is safe and idempotent from the app's
 * perspective either way (the terminal snapshot's `matchesExpectedIdentity`
 * check, or the poll-source acceptance rules, both accept it consistently).
 */
function mockFetch(options: MockFetchOptions = {}) {
  const investigationQueue = [...(options.investigation ?? [])];
  let postRefreshInvestigationResponse: Response | null = null;
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      return Promise.resolve(jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } }));
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: runningRunDetail() }));
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (postRefreshInvestigationResponse !== null) return Promise.resolve(postRefreshInvestigationResponse);
      // A harmless TRANSIENT fallback — never AGENT_JOB_NOT_FOUND, which
      // Finding 4 (independent review) correctly treats as a reason to
      // reset the whole investigation. A queue simply running out of
      // scripted ticks must never tear anything down.
      return Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "no more scripted ticks")));
    }
    if (url === `/v1/agent-runs/${RUN_ID}` && method === "GET") {
      return Promise.resolve((options.agentRun ?? (() => jsonResponse(200, { data: runningRunDetail() })))());
    }
    if (url.endsWith("/approval")) return Promise.resolve((options.approval ?? approvalResponse)());
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    setPostRefreshInvestigationResponse: (response: Response) => {
      postRefreshInvestigationResponse = response;
    },
  };
}

function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation"));
}

function approvalCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/approval")).length;
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

function childList(): HTMLElement {
  const list = document.querySelector(".investigation-progress-children-list");
  if (list === null) throw new Error("no canonical child list rendered");
  return list as HTMLElement;
}

function childRowClass(label: string): string {
  const row = within(childList()).getByText(label).closest("li");
  if (row === null) throw new Error(`no <li> ancestor for "${label}"`);
  return row.className;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Refresh terminal canonical finalization (Finding 2)", () => {
  it("a partial canonical RUNNING prefix, then Refresh observes COMPLETED for the first time — the authoritative read supplies the full terminal canonical stream, approval loads exactly once, and polling does not restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { fetchMock, setPostRefreshInvestigationResponse } = mockFetch({
      investigation: [jsonResponse(200, { data: partialRunningSnapshot() })],
      agentRun: () => jsonResponse(200, { data: legacyCompletedRunDetail() }),
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(childRowClass("Agent analysis")).toContain("--active"));
    // Report generation has not started yet — still Pending.
    expect(childRowClass("Report generation")).toContain("--pending");

    const investigationCallsBefore = investigationCalls(fetchMock).length;
    setPostRefreshInvestigationResponse(jsonResponse(200, { data: investigationState(legacyCompletedRunDetail(), FULL_COMPLETED_EVENTS) }));

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

    // All four canonical child rows reflect the TERMINAL persisted stream
    // — Report generation is no longer Pending.
    expect(childRowClass("Investigation created")).toContain("--completed");
    expect(childRowClass("Agent analysis")).toContain("--completed");
    expect(childRowClass("Report generation")).toContain("--completed");
    expect(approvalCallCount(fetchMock)).toBe(1);

    // No polling restart: advancing time further produces no additional
    // /investigation calls.
    const investigationCallsAfter = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(investigationCallsAfter);
    expect(investigationCallsAfter).toBeGreaterThan(investigationCallsBefore);
  });

  it("a partial canonical RUNNING prefix, then Refresh observes FAILED for the first time — the failed canonical stage is correct, no approval fetch, and polling does not restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { fetchMock, setPostRefreshInvestigationResponse } = mockFetch({
      investigation: [jsonResponse(200, { data: partialRunningSnapshot() })],
      agentRun: () => jsonResponse(200, { data: legacyFailedRunDetail() }),
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(childRowClass("Agent analysis")).toContain("--active"));

    setPostRefreshInvestigationResponse(jsonResponse(200, { data: investigationState(legacyFailedRunDetail(), FULL_FAILED_EVENTS) }));

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation."));

    expect(childRowClass("Diagnostic execution")).toContain("--failed");
    expect(approvalCallCount(fetchMock)).toBe(0);

    const investigationCallsAfter = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(investigationCallsAfter);
  });

  it("a stale poll response resolving AFTER Refresh cannot overwrite the refreshed/terminal state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredStalePollTick = deferredResponse();
    const { fetchMock, setPostRefreshInvestigationResponse } = mockFetch({
      investigation: [deferredStalePollTick.promise],
      agentRun: () => jsonResponse(200, { data: legacyCompletedRunDetail() }),
    });

    render(<App />);
    await submit(user);
    // Poll's first tick is deferred — still genuinely in flight when
    // Refresh is clicked below.
    await vi.advanceTimersByTimeAsync(0);

    setPostRefreshInvestigationResponse(jsonResponse(200, { data: investigationState(legacyCompletedRunDetail(), FULL_COMPLETED_EVENTS) }));

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));
    expect(approvalCallCount(fetchMock)).toBe(1);

    // NOW the OLD, still-deferred poll tick (from before Refresh) resolves,
    // reporting a DIFFERENT canonical stream (partial RUNNING) than what
    // Refresh already committed — it must be discarded (Refresh's
    // `poll.stop` bumped the poll session's own generation, and
    // `beginWorkflow()` bumped the main workflow generation `isStale`
    // checks against).
    deferredStalePollTick.resolve(jsonResponse(200, { data: partialRunningSnapshot() }));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
    expect(childRowClass("Report generation")).toContain("--completed");
    expect(approvalCallCount(fetchMock)).toBe(1);
  });
});

const CORRUPT_CANONICAL_EVENTS = [
  { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" as const } },
  { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" as const } },
  // A duplicate AGENT_STARTED is a structural violation the shared reducer
  // rejects (DUPLICATE_LIFECYCLE_FACT) even though the canonical marker
  // (RUN_CREATED at sequence 1) is present.
  { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "AGENT_STARTED" as const } },
];

/**
 * Final Codex re-review Finding 3: the canonical-invalid data-corrupt pause
 * policy must apply to a manual Refresh's own terminal authoritative final
 * read exactly like every other ingestion path — not only derivation
 * storage, but the App-level paused(data-corrupt)/Check-again policy too.
 */
describe("Refresh's terminal authoritative final read enters the data-corrupt pause on a canonical-invalid stream (final Codex re-review Finding 3)", () => {
  it("a partial canonical RUNNING prefix, then Refresh's authoritative final read is canonical-invalid — the frozen last-good child rows and terminal report remain visible, data-corrupt paused with a functional Check again, and normal terminal side effects (approval) still occur", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { fetchMock, setPostRefreshInvestigationResponse } = mockFetch({
      investigation: [jsonResponse(200, { data: partialRunningSnapshot() })],
      agentRun: () => jsonResponse(200, { data: legacyCompletedRunDetail() }),
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(childRowClass("Agent analysis")).toContain("--active"));

    setPostRefreshInvestigationResponse(
      jsonResponse(200, { data: investigationState(legacyCompletedRunDetail(), CORRUPT_CANONICAL_EVENTS) }),
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

    // Known terminal report/outcome remains visible — canonical-stream
    // trust and terminal settlement are independent facts.
    expect(screen.getByText("Generated report")).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(1);
    // Same-run last-good stages are preserved (frozen at their
    // pre-corruption RUNNING values) rather than the null "detail
    // unavailable" note or silently claiming fresh (untrustworthy) detail.
    expect(childRowClass("Agent analysis")).toContain("--active");
    expect(screen.queryByText("Detailed step-by-step progress isn't available for this run right now.")).toBeNull();
    // Data-corrupt paused with a functional "Check again", and ZERO
    // automatic requests before it is clicked.
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    const investigationCallsAfter = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(investigationCallsAfter);
  });
});
