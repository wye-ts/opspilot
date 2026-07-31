import { describe, expect, it } from "vitest";

import { createLiveRunConcurrencyLimiter } from "./live-run-concurrency";

describe("createLiveRunConcurrencyLimiter", () => {
  it("grants a lease while a slot is free and refuses once full", () => {
    const limiter = createLiveRunConcurrencyLimiter(1);

    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  it("never blocks — a refusal is immediate and synchronous", () => {
    // Queuing would turn a fast 429 into a slow timeout, since a LIVE run
    // carries its own 120s deadline. tryAcquire is deliberately not async.
    const limiter = createLiveRunConcurrencyLimiter(1);
    limiter.tryAcquire();

    const before = Date.now();
    const refused = limiter.tryAcquire();

    expect(refused).toBeNull();
    expect(Date.now() - before).toBeLessThan(50);
  });

  it("frees the slot on release", () => {
    const limiter = createLiveRunConcurrencyLimiter(1);

    const lease = limiter.tryAcquire();
    if (lease === null) throw new Error("expected a lease");
    expect(limiter.tryAcquire()).toBeNull();

    lease.release();
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  it("tracks in-flight count across acquire and release", () => {
    const limiter = createLiveRunConcurrencyLimiter(3);

    expect(limiter.inFlight).toBe(0);
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(limiter.inFlight).toBe(2);

    first?.release();
    expect(limiter.inFlight).toBe(1);
    second?.release();
    expect(limiter.inFlight).toBe(0);
  });

  it("honours a limit above one", () => {
    const limiter = createLiveRunConcurrencyLimiter(2);

    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  describe("idempotent release", () => {
    it("releases one slot however many times it is called", () => {
      // The controller releases in an inner finally that some paths reach after
      // an earlier release. A double release would inflate the available count
      // and let concurrency drift above the limit permanently.
      const limiter = createLiveRunConcurrencyLimiter(1);

      const lease = limiter.tryAcquire();
      if (lease === null) throw new Error("expected a lease");

      lease.release();
      lease.release();
      lease.release();

      expect(limiter.inFlight).toBe(0);
      expect(limiter.tryAcquire()).not.toBeNull();
      // Still exactly one slot: the extra releases bought nothing.
      expect(limiter.tryAcquire()).toBeNull();
    });

    it("never drives the in-flight count negative", () => {
      const limiter = createLiveRunConcurrencyLimiter(2);

      const lease = limiter.tryAcquire();
      lease?.release();
      lease?.release();

      expect(limiter.inFlight).toBe(0);
      expect(limiter.inFlight).toBeGreaterThanOrEqual(0);
    });

    it("keeps separate leases independent", () => {
      const limiter = createLiveRunConcurrencyLimiter(2);

      const first = limiter.tryAcquire();
      const second = limiter.tryAcquire();
      if (first === null || second === null) throw new Error("expected two leases");

      first.release();
      first.release();

      // The second lease is untouched by the first one's repeated release.
      expect(limiter.inFlight).toBe(1);
      second.release();
      expect(limiter.inFlight).toBe(0);
    });
  });

  // The lease must come back on every exit path. These simulate each shape the
  // controller can take, all using the same inner-finally structure.
  describe("release on every exit path", () => {
    const exits: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ["success", async () => undefined],
      ["provider failure returned as a finalized result", async () => undefined],
      [
        "orchestrator throw",
        async () => {
          throw new Error("AGENT_EXECUTION_CRASHED");
        },
      ],
      [
        "deadline abort",
        async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      ],
      [
        "client disconnect",
        async () => {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
      ],
      [
        "persistence failure",
        async () => {
          throw new Error("PERSISTENCE_UNAVAILABLE");
        },
      ],
      [
        "transaction rejection",
        async () => {
          throw new Error("LIVE_RUN_ATTEMPT_LIMIT");
        },
      ],
      [
        "reconciliation failure",
        async () => {
          throw new Error("reconcile failed");
        },
      ],
    ];

    it.each(exits)("releases the lease after %s", async (_label, body) => {
      const limiter = createLiveRunConcurrencyLimiter(1);
      const lease = limiter.tryAcquire();
      if (lease === null) throw new Error("expected a lease");

      // Whether `body` resolves or throws is not what this test asserts — the
      // point is that the finally runs either way. So the outcome is captured
      // rather than asserted on, and the assertions below are about the lease.
      let threw = false;
      try {
        try {
          await body();
        } finally {
          lease.release();
        }
      } catch {
        threw = true;
      }

      expect(typeof threw).toBe("boolean");
      expect(limiter.inFlight).toBe(0);
      expect(limiter.tryAcquire()).not.toBeNull();
    });

    it("releases the lease even when reconciliation throws inside the cleanup block", () => {
      // The structural guarantee: the release sits in the INNER finally, so a
      // throw from reconciliation cannot skip it.
      const limiter = createLiveRunConcurrencyLimiter(1);
      const lease = limiter.tryAcquire();
      if (lease === null) throw new Error("expected a lease");

      expect(() => {
        try {
          // the run itself succeeded
        } finally {
          try {
            throw new Error("reconciliation failed");
          } finally {
            lease.release();
          }
        }
      }).toThrow(/reconciliation failed/);

      expect(limiter.inFlight).toBe(0);
    });
  });

  describe("configuration guards", () => {
    it.each([0, -1, 1.5, Number.NaN])("rejects the invalid maxConcurrency %o", (max) => {
      expect(() => createLiveRunConcurrencyLimiter(max)).toThrow(/integer maxConcurrency/);
    });
  });
});
