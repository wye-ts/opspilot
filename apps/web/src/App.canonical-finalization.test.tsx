import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, InvestigationStateResponse } from "./api/types";
import type { InvestigationEventRecord } from "@opspilot/contracts";

/**
 * Focused coverage for independent-review Finding 1: the blocking run POST
 * never carries canonical `events[]`, so when it is the FIRST terminal
 * observer, App.tsx must fetch one authoritative `getInvestigationState`
 * read (under the SAME main workflow generation) before permanently
 * freezing the canonical Timeline — never settling on a stale/empty
 * `eventsRef.current` and never fabricating completion it cannot support.
 */

const JOB_ID = "job-1";
// A real v4-shaped UUID — InvestigationEventRecordSchema validates `runId`
// against the strict UUID pattern.
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

function makeEvent(sequence: number, payload: InvestigationEventRecord["payload"]): InvestigationEventRecord {
  return { runId: RUN_ID, sequence, recordedAt: "2026-07-23T10:00:00.000Z", payload };
}

const COMPLETED_REPORT = {
  category: "UNKNOWN" as const,
  summary: "s",
  rootCause: "r",
  customerImpact: "c",
  recommendedResolution: "rr",
  confidence: 0.5,
  evidence: [],
  suggestedActions: [],
};

/** The run POST's OWN response — never carries canonical events, matching the real API. */
function runDetail(status: "RUNNING" | "COMPLETED" | "FAILED"): AgentRunDetail {
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
    trace: [],
    outcome:
      status === "RUNNING"
        ? { type: "RUNNING" }
        : status === "COMPLETED"
          ? { type: "COMPLETED", report: COMPLETED_REPORT }
          : { type: "FAILED", code: "TOOL_NOT_FOUND", message: "The requested diagnostic tool is not registered." },
  };
}

/** The AUTHORITATIVE investigation-state snapshot — this is what Finding 1's extra read supplies. */
function investigationState(
  status: "RUNNING" | "COMPLETED" | "FAILED",
  events: readonly InvestigationEventRecord[],
): InvestigationStateResponse {
  const detail = runDetail(status);
  return { job: detail.job, run: detail.run, trace: detail.trace, outcome: detail.outcome, events };
}

function approvalResponse() {
  return jsonResponse(200, { data: { runId: RUN_ID, status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null } });
}

function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface MockFetchOptions {
  readonly run?: () => Response | Promise<Response>;
  /** Responses for GET .../investigation calls, consumed in order. */
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
      return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve((options.run ?? (() => jsonResponse(201, { data: runDetail("COMPLETED") })))());
    }
    if (url.endsWith("/investigation")) {
      const next = investigationQueue.shift();
      if (next === undefined) {
        return Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "no more scripted reads")));
      }
      return Promise.resolve(next);
    }
    if (url.endsWith("/approval")) return Promise.resolve((options.approval ?? approvalResponse)());
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

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

function progressRegion() {
  return screen.getByRole("region", { name: "Investigation progress" });
}

function childRowList(): HTMLElement | null {
  return progressRegion().querySelector(".investigation-progress-children-list");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Terminal POST canonical finalization (Finding 1)", () => {
  it("POST COMPLETED before any run-bearing poll tick: the authoritative final read supplies complete canonical events, children render correctly, no legacy fallback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fullStream = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "REPORT_SUBMITTED" }),
      makeEvent(4, { type: "REPORT_VALIDATED" }),
      makeEvent(5, { type: "RUN_COMPLETED" }),
    ];
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: runDetail("COMPLETED") }),
      investigation: [jsonResponse(200, { data: investigationState("COMPLETED", fullStream) })],
    });

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    await waitFor(() => expect(approvalCallCount(fetchMock)).toBe(1));

    // The authoritative read happened exactly once (the run POST's own
    // response never carried events; without Finding 1 this test would
    // never see canonical children at all).
    expect(investigationCalls(fetchMock)).toHaveLength(1);

    const children = childRowList();
    expect(children).not.toBeNull();
    // Every canonical child row reflects the FULL authoritative stream —
    // none stuck pending, proving no legacy fallback occurred (a legacy
    // fallback renders NO children at all).
    const pendingChildren = within(children!).queryAllByText("Pending");
    expect(pendingChildren).toHaveLength(0);
  });

  it("a partial RUNNING canonical prefix from an earlier poll tick is REPLACED by the authoritative final read on POST COMPLETED — Report generation does not remain Active/Pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const deferredRun = deferredResponse();
    const partialPrefix = [makeEvent(1, { type: "RUN_CREATED" }), makeEvent(2, { type: "AGENT_STARTED" })];
    const fullStream = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "REPORT_SUBMITTED" }),
      makeEvent(4, { type: "REPORT_VALIDATED" }),
      makeEvent(5, { type: "RUN_COMPLETED" }),
    ];
    const fetchMock = mockFetch({
      run: () => deferredRun.promise,
      investigation: [
        jsonResponse(200, { data: investigationState("RUNNING", partialPrefix) }), // poll tick 1 — partial prefix
        jsonResponse(200, { data: investigationState("COMPLETED", fullStream) }), // Finding 1's authoritative final read
      ],
    });

    render(<App />);
    await submit(user);
    // Let the first poll tick land with the partial RUNNING prefix.
    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => expect(childRowList()).not.toBeNull());
    // "Report generation" is still Pending at this point — the partial
    // prefix never reached it.
    expect(within(childRowList()!).getByText("Report generation").closest("li")).toHaveClass(
      "investigation-progress-item--pending",
    );

    // Now the run POST resolves COMPLETED — Finding 1 fetches the
    // authoritative final read and REPLACES the partial prefix.
    deferredRun.resolve(jsonResponse(201, { data: runDetail("COMPLETED") }));
    await waitFor(() =>
      expect(within(childRowList()!).getByText("Report generation").closest("li")).not.toHaveClass(
        "investigation-progress-item--pending",
      ),
    );
    expect(investigationCalls(fetchMock)).toHaveLength(2);
  });

  it("POST FAILED: the authoritative final read's persisted failed-stage state is used, no approval fetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const failedStream = [
      makeEvent(1, { type: "RUN_CREATED" }),
      makeEvent(2, { type: "AGENT_STARTED" }),
      makeEvent(3, { type: "TOOL_REQUESTED", toolCallId: "call-1", toolName: "get_service_status" }),
      makeEvent(4, { type: "TOOL_FAILED", toolCallId: "call-1", toolName: "get_service_status", failureCode: "TOOL_NOT_FOUND" }),
      makeEvent(5, { type: "RUN_FAILED", failureCode: "TOOL_NOT_FOUND", failedStage: "DIAGNOSTIC_EXECUTION" }),
    ];
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: runDetail("FAILED") }),
      investigation: [jsonResponse(200, { data: investigationState("FAILED", failedStream) })],
    });

    render(<App />);
    await submit(user);
    await screen.findByText("The requested diagnostic tool is not registered.");
    expect(investigationCalls(fetchMock)).toHaveLength(1);
    expect(approvalCallCount(fetchMock)).toBe(0);

    const children = childRowList();
    expect(children).not.toBeNull();
    expect(within(children!).getByText("Diagnostic execution").closest("li")).toHaveClass(
      "investigation-progress-item--failed",
    );
  });

  it("a transient failure on the authoritative final read does not undo the terminal outcome, runs settlement side effects exactly once, and fabricates no child completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = mockFetch({
      run: () => jsonResponse(201, { data: runDetail("COMPLETED") }),
      investigation: [jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"))],
    });

    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");
    await waitFor(() => expect(approvalCallCount(fetchMock)).toBe(1));

    // The terminal outcome is still fully visible — the POST's own report
    // data is intact regardless of the failed authoritative read.
    expect(screen.getByText("No evidence was recorded.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Investigation complete.");
    // Settlement side effects ran exactly once — no retry of the approval
    // fetch or a second notice.
    expect(approvalCallCount(fetchMock)).toBe(1);

    // No canonical child completion is fabricated: eventsRef.current was
    // empty when the POST won the race (no poll tick landed first), so the
    // derivation stays "legacy" — no children rendered AT ALL, never a
    // synthesized "all stages completed" row set.
    expect(childRowList()).toBeNull();
  });
});
