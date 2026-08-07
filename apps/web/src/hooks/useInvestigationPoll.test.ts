import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InvestigationStateResponse } from "../api/types";
import {
  useInvestigationPoll,
  type PollCallbacks,
  type PollError,
  type PollSnapshot,
  type PollStopReason,
} from "./useInvestigationPoll";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function runningSnapshot(overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
  return {
    job: { id: "job-1", ticketId: "DEMO-1", summary: "Elevated error rate", createdAt: "2026-01-01T00:00:00.000Z" },
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      estimatedCostUsd: null,
    },
    trace: [],
    outcome: { type: "RUNNING" },
    events: [],
    ...overrides,
  };
}

function terminalSnapshot(): InvestigationStateResponse {
  const base = runningSnapshot();
  return {
    ...base,
    run: { ...base.run!, status: "COMPLETED", finishedAt: "2026-01-01T00:00:05.000Z" },
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

/** A response that only resolves once the test explicitly resolves it. */
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RecordingCallbacks extends PollCallbacks {
  readonly snapshots: PollSnapshot[];
  readonly errors: PollError[];
  readonly stops: PollStopReason[];
}

function makeCallbacks(onSnapshot?: (event: PollSnapshot) => void): RecordingCallbacks {
  const snapshots: PollSnapshot[] = [];
  const errors: PollError[] = [];
  const stops: PollStopReason[] = [];
  return {
    snapshots,
    errors,
    stops,
    onSnapshot: (event) => {
      snapshots.push(event);
      onSnapshot?.(event);
    },
    onError: (event) => errors.push(event),
    onStop: (reason) => stops.push(reason),
  };
}

/** Advances fake timers AND flushes the resulting React state updates. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useInvestigationPoll", () => {
  it("schedules a second tick after the first successful snapshot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() }))));
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);
    expect(callbacks.snapshots).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    // The second tick fires ~1s later (healthy cadence) — proves scheduling
    // actually happened rather than the loop dying after one success.
    await advance(1000);
    expect(callbacks.snapshots).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("follows the 1s → 2s → 5s healthy cadence at the documented elapsed boundaries", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() }))));
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0); // tick @ t=0
    expect(callbacks.snapshots).toHaveLength(1);

    // < 10s: 1s cadence — 9 more ticks land at t=1000..9000.
    await advance(9000);
    expect(callbacks.snapshots).toHaveLength(10);

    // Crossing the 10s boundary switches to 2s cadence.
    await advance(2000);
    expect(callbacks.snapshots).toHaveLength(11);

    // Advance to just past the 60s boundary — cadence becomes 5s from here.
    await advance(48_000); // t=60000, still on 2s cadence until >=60000
    const countAt60s = callbacks.snapshots.length;
    await advance(5000);
    expect(callbacks.snapshots.length).toBe(countAt60s + 1);
  });

  it("never has more than one in-flight GET", async () => {
    vi.useFakeTimers();
    const deferred = deferredResponse();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advancing time while the first request is still unresolved must not
    // issue a second GET — the next tick is scheduled only after this one
    // settles.
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferred.resolve(jsonResponse(200, { data: runningSnapshot() }));
    await advance(0);
    expect(callbacks.snapshots).toHaveLength(1);
  });

  it("stops synchronously from the terminal callback with no next timer scheduled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { data: terminalSnapshot() })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks(() => {
      // Simulates App.tsx's terminal-observation coordinator stopping the
      // session synchronously from inside onSnapshot.
      result.current.stop("terminal");
    });

    act(() => result.current.start("job-1", callbacks));
    await advance(0);
    expect(callbacks.snapshots).toHaveLength(1);
    expect(callbacks.stops).toEqual(["terminal"]);
    expect(result.current.status).toBe("idle");

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows the 2s → 4s → 8s → 15s → 15s transient backoff sequence", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expectedDelays = [2000, 4000, 8000, 15000, 15000];
    for (let i = 0; i < expectedDelays.length; i++) {
      await advance(expectedDelays[i]! - 1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 2);
    }
  });

  it("pauses on the sixth consecutive transient failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0); // failure 1
    await advance(2000); // failure 2
    await advance(4000); // failure 3
    await advance(8000); // failure 4
    await advance(15000); // failure 5
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.status).toBe("polling");

    await advance(15000); // failure 6 — pauses
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(callbacks.stops).toEqual(["transient-ceiling"]);
    expect(result.current.status).toBe("paused");

    // No automatic 7th retry.
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("resets the transient failure counter after one success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));

    // Two failures, then a success, then five more failures — since the
    // counter reset, a 6th failure (not a 5th) is required to re-pause.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db"))));
    await advance(0); // failure 1
    await advance(2000); // failure 2

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() })));
    await advance(4000); // success — counter resets to 0
    expect(result.current.status).toBe("polling");

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db"))));
    await advance(1000); // failure 1 (post-reset)
    await advance(2000); // failure 2
    await advance(4000); // failure 3
    await advance(8000); // failure 4
    await advance(15000); // failure 5
    expect(result.current.status).toBe("polling"); // not yet paused — proves the reset
    await advance(15000); // failure 6 — pauses
    expect(callbacks.stops).toEqual(["transient-ceiling"]);
  });

  it("pauses at time-ceiling after five minutes of healthy RUNNING polling", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() }))));
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(305_000);

    expect(callbacks.stops).toEqual(["time-ceiling"]);
    expect(result.current.status).toBe("paused");
  });

  it("pauses immediately on INTERNAL_DATA_INVALID with zero automatic retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(500, errorEnvelope("INTERNAL_DATA_INVALID", "corrupt"))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);

    expect(callbacks.stops).toEqual(["data-corrupt"]);
    expect(result.current.status).toBe("paused");

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resume() after a transient-ceiling pause polls again and resets the failure/time budgets", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    await advance(15000);
    await advance(15000); // 6th failure — paused
    expect(result.current.status).toBe("paused");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() })));
    act(() => result.current.resume());
    // resume() must not emit a spurious onStop("aborted") for the paused session.
    expect(callbacks.stops).toEqual(["transient-ceiling"]);

    await advance(0);
    expect(result.current.status).toBe("polling");
    expect(callbacks.snapshots).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // The failure budget reset: a fresh run of 5 failures must NOT yet pause
    // (proving the counter did not carry over from before the pause).
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db down"))),
    );
    await advance(1000);
    await advance(2000);
    await advance(4000);
    await advance(8000);
    await advance(15000);
    expect(result.current.status).toBe("polling");

    // The time budget reset: this resumed session should not already be
    // near its own 5-minute ceiling just because the ORIGINAL session
    // started 5 pauses/backoffs ago.
    await advance(15000); // 6th failure of THIS resumed session
    expect(callbacks.stops).toEqual(["transient-ceiling", "transient-ceiling"]);
  });

  it("cannot resume a not-found, permanent-invalid, terminal, or aborted session", async () => {
    vi.useFakeTimers();

    // not-found
    {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(404, errorEnvelope("AGENT_JOB_NOT_FOUND", "gone"))));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useInvestigationPoll());
      const callbacks = makeCallbacks();
      act(() => result.current.start("job-1", callbacks));
      await advance(0);
      expect(callbacks.stops).toEqual(["not-found"]);

      act(() => result.current.resume());
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("idle");
    }

    // permanent-invalid
    {
      const fetchMock = vi.fn(() =>
        Promise.resolve(jsonResponse(400, errorEnvelope("ROUTE_PARAMETER_INVALID", "bad"))),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useInvestigationPoll());
      const callbacks = makeCallbacks();
      act(() => result.current.start("job-1", callbacks));
      await advance(0);
      expect(callbacks.stops).toEqual(["permanent-invalid"]);

      act(() => result.current.resume());
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // terminal
    {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { data: terminalSnapshot() })));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useInvestigationPoll());
      const callbacks = makeCallbacks(() => result.current.stop("terminal"));
      act(() => result.current.start("job-1", callbacks));
      await advance(0);
      expect(callbacks.stops).toEqual(["terminal"]);

      act(() => result.current.resume());
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // aborted
    {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot() })));
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useInvestigationPoll());
      const callbacks = makeCallbacks();
      act(() => result.current.start("job-1", callbacks));
      await advance(0);
      act(() => result.current.stop("aborted"));

      act(() => result.current.resume());
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("stop() invalidates an in-flight response", async () => {
    vi.useFakeTimers();
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => deferred.promise));
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacks = makeCallbacks();

    act(() => result.current.start("job-1", callbacks));
    await advance(0);

    act(() => result.current.stop("aborted"));
    deferred.resolve(jsonResponse(200, { data: runningSnapshot() }));
    await advance(0);

    expect(callbacks.snapshots).toHaveLength(0);
    expect(callbacks.errors).toHaveLength(0);
  });

  it("starting job B invalidates job A's in-flight response", async () => {
    vi.useFakeTimers();
    const deferredA = deferredResponse();
    const fetchMock = vi.fn(() => deferredA.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useInvestigationPoll());
    const callbacksA = makeCallbacks();
    const callbacksB = makeCallbacks();

    act(() => result.current.start("job-a", callbacksA));
    await advance(0);

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { data: runningSnapshot({ job: { ...runningSnapshot().job, id: "job-b" } }) })));
    act(() => result.current.start("job-b", callbacksB));
    expect(callbacksA.stops).toEqual(["aborted"]);

    deferredA.resolve(jsonResponse(200, { data: runningSnapshot() }));
    await advance(0);

    // Job A's late response must never reach job A's callbacks.
    expect(callbacksA.snapshots).toHaveLength(0);
    // Job B's own tick proceeds normally.
    expect(callbacksB.snapshots).toHaveLength(1);
  });
});
