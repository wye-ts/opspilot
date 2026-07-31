import { describe, expect, it } from "vitest";

import { createLiveRunRateLimiter } from "./live-run-rate-limiter";

// An injected clock, so window boundaries are asserted exactly rather than
// approximated with sleeps.
function fixedClock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("createLiveRunRateLimiter", () => {
  it("allows up to max requests in a window and rejects the next", () => {
    const clock = fixedClock();
    const limiter = createLiveRunRateLimiter({ max: 2, windowMs: 60_000, now: clock.now });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("resets exactly at the window boundary, not before", () => {
    const clock = fixedClock();
    const limiter = createLiveRunRateLimiter({ max: 2, windowMs: 60_000, now: clock.now });

    limiter.check("a");
    limiter.check("a");

    // One millisecond short of the boundary: still the same window.
    clock.advance(59_999);
    expect(limiter.check("a").allowed).toBe(false);

    // Exactly at the boundary: a new window opens.
    clock.advance(1);
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("starts the next window from the request that opened it, not from the previous boundary", () => {
    const clock = fixedClock();
    const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 10_000, now: clock.now });

    limiter.check("a");
    clock.advance(25_000);
    expect(limiter.check("a").allowed).toBe(true);

    // 5s into the window opened at +25s, so still blocked.
    clock.advance(5_000);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("keeps client buckets independent", () => {
    const clock = fixedClock();
    const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);

    // A different client is entirely unaffected by the first one's exhaustion.
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("does not count a rejected attempt, so a blocked client cannot extend its own window", () => {
    const clock = fixedClock();
    const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 10_000, now: clock.now });

    limiter.check("a");

    clock.advance(5_000);
    const first = limiter.check("a");
    clock.advance(1_000);
    const second = limiter.check("a");

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    // Retry-After keeps shrinking toward the ORIGINAL boundary at +10s.
    if (first.allowed || second.allowed) throw new Error("expected both to be rejected");
    expect(first.retryAfterSeconds).toBe(5);
    expect(second.retryAfterSeconds).toBe(4);
  });

  describe("Retry-After", () => {
    it("reports whole seconds to the end of the current window", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

      limiter.check("a");
      clock.advance(15_000);
      const decision = limiter.check("a");

      if (decision.allowed) throw new Error("expected a rejection");
      expect(decision.retryAfterSeconds).toBe(45);
    });

    it("rounds a partial second up rather than down", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

      limiter.check("a");
      clock.advance(15_500);
      const decision = limiter.check("a");

      // 44.5s remain; rounding down to 44 would invite a retry that is still
      // inside the window.
      if (decision.allowed) throw new Error("expected a rejection");
      expect(decision.retryAfterSeconds).toBe(45);
    });

    it("never reports zero, even at the last millisecond of the window", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

      limiter.check("a");
      clock.advance(59_999);
      const decision = limiter.check("a");

      // Retry-After: 0 would mean "retry immediately", which is guaranteed to
      // be rejected again.
      if (decision.allowed) throw new Error("expected a rejection");
      expect(decision.retryAfterSeconds).toBe(1);
    });

    it("is absent from an allowed decision", () => {
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000 });
      const decision = limiter.check("a");

      expect(decision).toEqual({ allowed: true });
    });
  });

  describe("pruning", () => {
    it("drops buckets once their window has closed", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000, now: clock.now });

      limiter.check("a");
      limiter.check("b");
      limiter.check("c");
      expect(limiter.trackedClients).toBe(3);

      // A single later request prunes every expired bucket, leaving only the
      // one it just created.
      clock.advance(60_000);
      limiter.check("d");
      expect(limiter.trackedClients).toBe(1);
    });

    it("keeps the map proportional to active clients rather than to total traffic", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 1_000, now: clock.now });

      // Without pruning this would be a slow memory leak reachable from
      // unauthenticated traffic with a spoofable client key.
      for (let i = 0; i < 500; i += 1) {
        limiter.check(`client-${i}`);
        clock.advance(1_000);
      }

      expect(limiter.trackedClients).toBe(1);
    });

    it("does not prune a bucket that is still inside its window", () => {
      const clock = fixedClock();
      const limiter = createLiveRunRateLimiter({ max: 5, windowMs: 60_000, now: clock.now });

      limiter.check("a");
      clock.advance(30_000);
      limiter.check("b");

      expect(limiter.trackedClients).toBe(2);
    });
  });

  describe("configuration guards", () => {
    it.each([0, -1, 1.5, Number.NaN])("rejects the invalid max %o", (max) => {
      expect(() => createLiveRunRateLimiter({ max, windowMs: 60_000 })).toThrow(/integer max/);
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects the invalid windowMs %o", (windowMs) => {
      expect(() => createLiveRunRateLimiter({ max: 1, windowMs })).toThrow(/integer windowMs/);
    });
  });

  it("defaults to the real clock when none is injected", () => {
    const limiter = createLiveRunRateLimiter({ max: 1, windowMs: 60_000 });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });
});
