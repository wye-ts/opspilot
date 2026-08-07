import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, InvestigationStateResponse } from "./api/types";

/**
 * Independent review Finding 5 (Codex review): every accepted canonical
 * snapshot — regardless of entry point (poll, POST authoritative final
 * snapshot, mount resume, popstate resume) or run status (RUNNING,
 * COMPLETED, FAILED) — must route a reducer-invalid result through the
 * SAME fail-closed policy (`applyAcceptedSnapshotDerivation`, wired into
 * App.tsx via `applyDerivationForCandidate`). None may silently fall back
 * to `legacy`, and a RUNNING resume with a first-snapshot invalid stream
 * must not start an automatic polling loop.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const UUID_A = "33333333-3333-3333-3333-333333333333";

const NOTE_TEXT = "Detailed step-by-step progress isn't available for this run right now.";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return { id: JOB_ID, ticketId: `DEMO-${UUID_A}`, summary: "Elevated error rate", createdAt: "2026-07-23T10:00:00.000Z", ...overrides };
}

// A corrupt canonical stream: the marker (RUN_CREATED at sequence 1) is
// present — so `hasCanonicalInvestigationLifecycleMarker` returns true —
// but a duplicate AGENT_STARTED is a structural violation the shared
// reducer rejects with DUPLICATE_LIFECYCLE_FACT regardless of runStatus.
function corruptCanonicalEvents(): InvestigationStateResponse["events"] {
  return [
    { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
    { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
    { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "AGENT_STARTED" } },
  ];
}

function runDetailFor(status: "RUNNING" | "COMPLETED" | "FAILED"): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: RUN_ID,
      jobId: JOB_ID,
      attemptNumber: 1,
      status,
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: status === "RUNNING" ? null : "2026-07-23T10:00:05.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
      estimatedCostUsd: null,
    },
    trace: status === "RUNNING" ? [] : [{ type: "REPORT_GENERATED" }],
    outcome:
      status === "RUNNING"
        ? { type: "RUNNING" }
        : status === "COMPLETED"
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

function corruptInvestigationState(status: "RUNNING" | "COMPLETED" | "FAILED"): InvestigationStateResponse {
  const detail = runDetailFor(status);
  return {
    job: detail.job,
    run: detail.run,
    trace: detail.trace,
    outcome: detail.outcome,
    events: corruptCanonicalEvents(),
  };
}

function approvalResponse() {
  return jsonResponse(200, { data: { runId: RUN_ID, status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null } });
}

interface MockFetchOptions {
  readonly investigation?: (Response | Promise<Response>)[];
  readonly run?: () => Response | Promise<Response>;
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
      return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve((options.run ?? (() => jsonResponse(201, { data: runDetailFor("RUNNING") })))());
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      if (next === undefined) return Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "no more scripted ticks")));
      return Promise.resolve(next);
    }
    if (url.endsWith("/approval")) return Promise.resolve(approvalResponse());
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/investigation"));
}

function approvalCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/approval")).length;
}

function elapsedText(): string | null {
  return document.querySelector(".investigation-progress-elapsed")?.textContent ?? null;
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
  window.history.replaceState(null, "", "/");
});

describe("centralized canonical-invalid policy across every ingestion path (Finding 5)", () => {
  it("mount resume, first snapshot RUNNING and canonical-invalid — no silent legacy fallback, the detail-unavailable note is shown, data-corrupt paused with a functional Check again, and ZERO automatic requests before the click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: corruptInvestigationState("RUNNING") })] });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    // Final Codex re-review Finding 3: a resumable job-keyed "Check again"
    // session IS established (unlike the prior fix, which left the pause
    // unreachable) — offered via the paused(data-corrupt) affordance.
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    const callsAfterResume = investigationCalls(fetchMock).length;
    // ZERO automatic requests: advancing time produces no further
    // /investigation calls before the button is ever clicked.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(callsAfterResume);
  });

  it("mount resume, first snapshot COMPLETED and canonical-invalid — the terminal outcome remains visible, data-corrupt paused with a functional Check again, and ZERO automatic requests before the click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: corruptInvestigationState("COMPLETED") })] });

    render(<App />);
    await screen.findByText("Agent activity");
    // The terminal outcome/report is genuinely known and remains visible...
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
    // ...but the canonical child detail is NOT presented as trustworthy —
    // no silent legacy fallback (which would render neither children nor a
    // note at all, indistinguishable from a pre-#37 run) — and the
    // data-corrupt pause with its Check again affordance IS offered even
    // though the run itself is terminal.
    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    const callsAfterResume = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(callsAfterResume);
  });

  it("mount resume, first snapshot FAILED and canonical-invalid — the failure outcome remains visible, data-corrupt paused with a functional Check again, and ZERO automatic requests before the click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const fetchMock = mockFetch({ investigation: [jsonResponse(200, { data: corruptInvestigationState("FAILED") })] });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    const callsAfterResume = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(callsAfterResume);
  });

  it("a terminal POLL observation with a canonical-invalid stream — no silent legacy fallback, terminal outcome remains visible, data-corrupt paused with a functional Check again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => new Promise(() => {}), // never resolves — the POLL observes terminal first
      investigation: [jsonResponse(200, { data: corruptInvestigationState("COMPLETED") })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    const callsAfterTerminal = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(callsAfterTerminal);
  });

  it("a terminal POST authoritative final read with a canonical-invalid stream — no silent legacy fallback, terminal outcome remains visible, data-corrupt paused with a functional Check again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: runDetailFor("COMPLETED") }),
      // The POST becomes terminal owner and performs its OWN authoritative
      // getInvestigationState read (Finding 1) — this is that read,
      // carrying a canonical-invalid stream.
      investigation: [jsonResponse(200, { data: corruptInvestigationState("COMPLETED") })],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));

    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(document.querySelector(".investigation-progress-children-list")).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    const callsAfterTerminal = investigationCalls(fetchMock).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(investigationCalls(fetchMock).length).toBe(callsAfterTerminal);
  });

  // Manual-Refresh canonical-invalid coverage lives in
  // App.refresh-terminal-canonical.test.tsx, which already mocks the
  // legacy `GET /v1/agent-runs/:runId` endpoint Refresh's first read uses.
});

describe("Check again recovers valid canonical detail without duplicating terminal side effects (final Codex re-review Finding 3)", () => {
  it("RUNNING resume, first snapshot canonical-invalid — clicking Check again performs the one fresh bounded GET and, once it returns valid data, clears the pause and resumes live progress", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    // At least as many events as the corrupt fixture (3) — a poll-sourced
    // candidate carrying FEWER events than already held is discarded as
    // regressive by `isNewerInvestigationSnapshot`, independent of whether
    // the reducer itself would accept it.
    const validEvents: InvestigationStateResponse["events"] = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" } },
    ];
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: corruptInvestigationState("RUNNING") }),
        jsonResponse(200, { data: { ...corruptInvestigationState("RUNNING"), events: validEvents } }),
      ],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    const callsBeforeClick = investigationCalls(fetchMock).length;

    await user.click(screen.getByRole("button", { name: "Check again" }));
    // Exactly one fresh bounded GET is issued by the click.
    await waitFor(() => expect(investigationCalls(fetchMock).length).toBe(callsBeforeClick + 1));

    // Valid canonical detail is now applied: the note is gone, real child
    // rows render, and the pause/Check-again affordance is cleared.
    await waitFor(() => expect(screen.queryByText(NOTE_TEXT)).toBeNull());
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("terminal POST authoritative final read, first snapshot canonical-invalid — clicking Check again recovers valid canonical detail, remains COMPLETED, and does NOT re-fetch approval or re-announce completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const validCompletedEvents: InvestigationStateResponse["events"] = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" } },
      { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" } },
      { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" } },
    ];
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: runDetailFor("COMPLETED") }),
      investigation: [
        jsonResponse(200, { data: corruptInvestigationState("COMPLETED") }),
        jsonResponse(200, { data: { ...corruptInvestigationState("COMPLETED"), events: validCompletedEvents } }),
      ],
    });

    render(<App />);
    await submit(user);
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Investigation complete."));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/approval")).length).toBe(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByText(NOTE_TEXT)).toBeNull());

    // Remains COMPLETED — no duplicate terminal side effect: still exactly
    // ONE approval fetch total, and the completion notice was never
    // re-announced by this recovery.
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/approval")).length).toBe(1);
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});

/**
 * Final independent review P1: the resumed FAILED canonical-invalid branch
 * used to install the failure outcome directly and never route through
 * `resolveTerminalObservation` — so the workflow's durable terminal claim
 * stayed `null`. A later valid "Check again" observation for the SAME
 * job/run/attempt was then treated as a brand-new owner rather than a
 * duplicate (same status) or a contradiction (opposite status). App.tsx now
 * funnels the initial resumed FAILED observation through the SAME shared
 * `applyObservedRunOutcome` coordinator every other terminal path uses
 * (`skipAuthoritativeFinalRead: true`, since the resume read's `events`
 * already came from this same snapshot), while preserving the persisted
 * `run.finishedAt` via `resumeObservedFinishedAt` so the frozen elapsed
 * clock is never rewritten with `Date.now()` merely because FAILED resume
 * now uses the coordinator.
 */
describe("Resumed FAILED canonical-invalid — Check again terminal settlement (final independent review P1)", () => {
  const JOB_ID_B = "44444444-4444-4444-8444-444444444444";
  const RUN_ID_B = "55555555-5555-4555-8555-555555555555";

  it("mount resume FAILED canonical-invalid, Check again returns valid FAILED for the same identity — duplicate-safe: FAILED remains, canonical detail recovers, no approval request, no repeated failure notice, and the frozen elapsed clock is unchanged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    // At least as many events as the corrupt fixture (3) — a poll-sourced
    // candidate carrying FEWER events than already held is discarded as
    // regressive by `isNewerInvestigationSnapshot`.
    const validFailedEvents: InvestigationStateResponse["events"] = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" } },
      { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "TOOL_FAILED", toolCallId: "call-1", toolName: "get_service_status", failureCode: "TOOL_NOT_FOUND" } },
      { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_FAILED", failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" } },
    ];
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: corruptInvestigationState("FAILED") }), // resume's own initial read: persisted finishedAt T1
        jsonResponse(200, { data: { ...corruptInvestigationState("FAILED"), events: validFailedEvents } }), // Check again: SAME identity, SAME status, now valid
      ],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(screen.getByText(NOTE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(0);
    const elapsedBefore = elapsedText();

    const callsBeforeClick = investigationCalls(fetchMock).length;
    await user.click(screen.getByRole("button", { name: "Check again" }));
    // Exactly one fresh bounded GET is issued by the click.
    await waitFor(() => expect(investigationCalls(fetchMock).length).toBe(callsBeforeClick + 1));

    // Valid canonical detail recovers, and the pause/Check-again affordance
    // clears.
    await waitFor(() => expect(screen.queryByText(NOTE_TEXT)).toBeNull());
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

    // FAILED remains, treated as a harmless DUPLICATE — not a fresh owner:
    // no approval request (FAILED never loads approval), and the frozen
    // elapsed clock set once at resume from the persisted `finishedAt` is
    // untouched by this second observation.
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(approvalCallCount(fetchMock)).toBe(0);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(elapsedText()).toBe(elapsedBefore);
  });

  it("mount resume FAILED canonical-invalid, Check again returns COMPLETED for the same identity — fixed terminal inconsistency: FAILED is preserved, no approval fetch/install, no Approve/Reject controls, and the frozen elapsed clock is unchanged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const corruptFailed = corruptInvestigationState("FAILED");
    const validCompletedEvents: InvestigationStateResponse["events"] = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" } },
      { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" } },
      { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" } },
    ];
    // SAME job/run/attempt as `corruptFailed`, but COMPLETED — an internal
    // contradiction that must never overwrite the already-known FAILED
    // outcome or load approval.
    const oppositeCompleted: InvestigationStateResponse = {
      job: corruptFailed.job,
      run: { ...corruptFailed.run!, status: "COMPLETED", finishedAt: "2026-07-23T10:05:00.000Z" },
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
      events: validCompletedEvents,
    };
    const fetchMock = mockFetch({
      investigation: [jsonResponse(200, { data: corruptFailed }), jsonResponse(200, { data: oppositeCompleted })],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(0);
    const elapsedBefore = elapsedText();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "This investigation reported inconsistent results and could not be settled. Refresh or start a new investigation.",
      ),
    );

    // FAILED — the first accepted terminal state — remains authoritative:
    // never overwritten by the contradictory COMPLETED candidate, and no
    // approval is ever fetched or installed for it.
    expect(screen.getByText("The requested diagnostic tool is not registered.")).toBeInTheDocument();
    expect(screen.queryByText("No evidence was recorded.")).toBeNull();
    expect(approvalCallCount(fetchMock)).toBe(0);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    // Zero completion announcement for the rejected COMPLETED candidate.
    expect(screen.queryByText("Investigation complete.")).toBeNull();
    expect(elapsedText()).toBe(elapsedBefore);
  });

  it("popstate variant — job A resumes normally, popstate to job B resumes FAILED canonical-invalid, Check again returns COMPLETED for job B's identity — the same shared coordinator applies via popstate, not just mount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.pushState(null, "", `?job=${JOB_ID}`);

    const corruptFailedB: InvestigationStateResponse = {
      ...corruptInvestigationState("FAILED"),
      job: jobResponse({ id: JOB_ID_B }),
      run: { ...corruptInvestigationState("FAILED").run!, id: RUN_ID_B, jobId: JOB_ID_B },
      events: corruptCanonicalEvents().map((event) => ({ ...event, runId: RUN_ID_B })),
    };
    const oppositeCompletedB: InvestigationStateResponse = {
      job: jobResponse({ id: JOB_ID_B }),
      run: { ...corruptFailedB.run!, status: "COMPLETED", finishedAt: "2026-07-23T10:05:00.000Z" },
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
      events: [
        { runId: RUN_ID_B, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
        { runId: RUN_ID_B, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
        { runId: RUN_ID_B, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" } },
        { runId: RUN_ID_B, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" } },
        { runId: RUN_ID_B, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" } },
      ],
    };
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: corruptInvestigationState("COMPLETED") }), // job A's own mount resume
        jsonResponse(200, { data: corruptFailedB }), // job B's resume — FAILED, canonical-invalid
        jsonResponse(200, { data: oppositeCompletedB }), // job B's Check again — opposite status, same identity
      ],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    expect(screen.getByText(JOB_ID)).toBeInTheDocument();
    // Job A is itself a COMPLETED (canonical-invalid) resume, so it loads
    // its OWN approval exactly once — the baseline every assertion below is
    // relative to, proving job B's FAILED path never adds a second fetch.
    await waitFor(() => expect(approvalCallCount(fetchMock)).toBe(1));
    const approvalBaseline = approvalCallCount(fetchMock);

    window.history.pushState(null, "", `?job=${JOB_ID_B}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByText(JOB_ID_B)).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Investigation failed while running the agent investigation.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(approvalBaseline);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "This investigation reported inconsistent results and could not be settled. Refresh or start a new investigation.",
      ),
    );

    // Job B's FAILED outcome remains authoritative — the same terminal
    // coordinator semantics apply whether B was reached by mount or
    // popstate, because both share the ONE resume function.
    expect(screen.getByText("The requested diagnostic tool is not registered.")).toBeInTheDocument();
    expect(approvalCallCount(fetchMock)).toBe(approvalBaseline);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  // Regression (final independent review §4D): the pre-existing resumed
  // COMPLETED canonical-invalid path (already routed through the shared
  // coordinator before this fix) must remain duplicate-safe on a same-status
  // Check again, unweakened by this pass's FAILED-branch change.
  it("regression — mount resume COMPLETED canonical-invalid, Check again returns valid COMPLETED for the same identity — remains duplicate-safe: exactly one approval fetch total, no re-announced completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    window.history.pushState(null, "", `?job=${JOB_ID}`);
    const validCompletedEvents: InvestigationStateResponse["events"] = [
      { runId: RUN_ID, sequence: 1, recordedAt: "2026-07-23T10:00:00.000Z", payload: { type: "RUN_CREATED" } },
      { runId: RUN_ID, sequence: 2, recordedAt: "2026-07-23T10:00:01.000Z", payload: { type: "AGENT_STARTED" } },
      { runId: RUN_ID, sequence: 3, recordedAt: "2026-07-23T10:00:02.000Z", payload: { type: "REPORT_SUBMITTED" } },
      { runId: RUN_ID, sequence: 4, recordedAt: "2026-07-23T10:00:03.000Z", payload: { type: "REPORT_VALIDATED" } },
      { runId: RUN_ID, sequence: 5, recordedAt: "2026-07-23T10:00:04.000Z", payload: { type: "RUN_COMPLETED" } },
    ];
    const fetchMock = mockFetch({
      investigation: [
        jsonResponse(200, { data: corruptInvestigationState("COMPLETED") }),
        jsonResponse(200, { data: { ...corruptInvestigationState("COMPLETED"), events: validCompletedEvents } }),
      ],
    });

    render(<App />);
    await screen.findByText("Agent activity");
    await waitFor(() => expect(approvalCallCount(fetchMock)).toBe(1));
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByText(NOTE_TEXT)).toBeNull());

    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
    expect(approvalCallCount(fetchMock)).toBe(1);
    expect(document.querySelector(".investigation-progress-children-list")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });
});
