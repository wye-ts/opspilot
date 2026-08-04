import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatElapsed, useElapsedTime } from "./useElapsedTime";

afterEach(() => {
  vi.useRealTimers();
});

describe("useElapsedTime", () => {
  it("returns 0 when nothing has started", () => {
    const { result } = renderHook(() => useElapsedTime(null, null));
    expect(result.current).toBe(0);
  });

  it("ticks upward while started and not yet finished", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { result } = renderHook(() => useElapsedTime(start, null));
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBeGreaterThanOrEqual(3000);
  });

  it("freezes at finishedAt - startedAt and does not keep counting", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const finish = start + 4200;
    const { result, rerender } = renderHook(({ startedAt, finishedAt }) => useElapsedTime(startedAt, finishedAt), {
      initialProps: { startedAt: start as number | null, finishedAt: null as number | null },
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender({ startedAt: start, finishedAt: finish });
    const frozen = result.current;
    expect(frozen).toBe(4200);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(frozen);
  });

  it("cleans up its interval when unmounted", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useElapsedTime(Date.now(), null));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
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
});
