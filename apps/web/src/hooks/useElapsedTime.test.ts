import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatElapsed, useElapsedTime } from "./useElapsedTime";

afterEach(() => {
  vi.useRealTimers();
});

describe("useElapsedTime", () => {
  it("returns 0 when nothing has started", () => {
    const { result } = renderHook(() => useElapsedTime(null, null, false));
    expect(result.current).toBe(0);
  });

  it("RUNNING: elapsed advances against the current time while started and not yet finished", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { result } = renderHook(() => useElapsedTime(start, null, false));
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBeGreaterThanOrEqual(3000);
  });

  it("COMPLETED: elapsed freezes at finishedAt - startedAt the moment a persisted finish time arrives", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const finish = start + 4200;
    const { result, rerender } = renderHook(
      ({ startedAt, finishedAt, isTerminal }) => useElapsedTime(startedAt, finishedAt, isTerminal),
      {
        initialProps: { startedAt: start as number | null, finishedAt: null as number | null, isTerminal: false },
      },
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // The run transitions to COMPLETED with its real persisted finishedAt.
    rerender({ startedAt: start, finishedAt: finish, isTerminal: true });
    expect(result.current).toBe(4200);
  });

  it("FAILED: elapsed freezes at finishedAt - startedAt the moment a persisted finish time arrives", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const finish = start + 1500;
    const { result, rerender } = renderHook(
      ({ startedAt, finishedAt, isTerminal }) => useElapsedTime(startedAt, finishedAt, isTerminal),
      {
        initialProps: { startedAt: start as number | null, finishedAt: null as number | null, isTerminal: false },
      },
    );

    act(() => {
      vi.advanceTimersByTime(900);
    });
    rerender({ startedAt: start, finishedAt: finish, isTerminal: true });
    expect(result.current).toBe(1500);
  });

  it("advancing timers after completion does not change the frozen value", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const finish = start + 4200;
    const { result } = renderHook(() => useElapsedTime(start, finish, true));
    const frozen = result.current;
    expect(frozen).toBe(4200);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(frozen);

    // Even a very long advance (the reported bug: minutes of real time
    // passing) must never move a frozen terminal value.
    act(() => {
      vi.advanceTimersByTime(40 * 60 * 1000);
    });
    expect(result.current).toBe(frozen);
  });

  it("reloading/resuming a completed run preserves the same elapsed duration no matter how much real time has passed", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const finish = start + 15000; // the run actually took 15s

    // First "page load" — resume observes the persisted finishedAt immediately.
    const first = renderHook(() => useElapsedTime(start, finish, true));
    expect(first.result.current).toBe(15000);
    first.unmount();

    // 40+ minutes of real wall-clock time pass before a second "page load"
    // (a fresh mount, exactly as a browser refresh would produce). The SAME
    // persisted startedAt/finishedAt must produce the SAME value — never
    // something derived from `Date.now()` at this later moment.
    act(() => {
      vi.advanceTimersByTime(40 * 60 * 1000);
    });
    const second = renderHook(() => useElapsedTime(start, finish, true));
    expect(second.result.current).toBe(15000);
  });

  it("a terminal run with no trustworthy finishedAt fails safe: never ticks, never derives a value from Date.now()", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { result } = renderHook(() => useElapsedTime(start, null, true));
    expect(result.current).toBeNull();

    // If this were mistaken for "still running", it would tick upward here.
    // It must not — no interval is ever started for a terminal-but-unknown
    // finish time.
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current).toBeNull();
  });

  it("cleans up its interval when unmounted", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useElapsedTime(Date.now(), null, false));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("does not start an interval for a terminal-but-unknown finish time", () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    renderHook(() => useElapsedTime(Date.now(), null, true));
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe("formatElapsed", () => {
  it("renders whole seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(45000)).toBe("45s");
  });

  it("renders minutes and seconds at or beyond a minute", () => {
    expect(formatElapsed(60000)).toBe("1m 0s");
    expect(formatElapsed(90000)).toBe("1m 30s");
  });

  it("renders the placeholder for a fail-safe null value", () => {
    expect(formatElapsed(null)).toBe("—");
  });
});
