/**
 * A counting semaphore for in-flight LIVE runs that REJECTS rather than queues.
 *
 * Rejecting is the whole point. A LIVE run carries its own 120-second deadline,
 * so queuing a request behind one converts a fast, honest 429 into a slow
 * timeout the caller cannot distinguish from a broken server — and it hands an
 * abuser a free way to pin memory by parking requests. There is no queue, no
 * wait, and no timeout to tune.
 *
 * Honest scope: per process. On the free single-instance plan that is also the
 * global limit; on any multi-instance plan it is not, and the durable daily
 * budget is what actually bounds spend.
 *
 * This primitive accepts any limit >= 1 and is unit-tested at 2 and 3, because a
 * counting semaphore that only ever counted to one would be a worse-tested
 * abstraction. The RELEASE constraint lives one layer up, in configuration:
 * LIVE_RUN_MAX_CONCURRENCY accepts only `1`, because the documented cost-ceiling
 * overrun bound depends on it (see REQUIRED_MAX_CONCURRENCY in
 * run-execution-config.ts). Keeping that constraint at the configuration
 * boundary rather than here is deliberate — it is a policy decision about this
 * release, not a property of semaphores.
 */
export interface LiveRunConcurrencyLease {
  /**
   * Returns the slot. IDEMPOTENT — calling it twice releases one slot, not two.
   *
   * That matters because the controller releases in an inner `finally` that can
   * be reached on paths which have already released (a rethrow after cleanup,
   * for instance). A double release would inflate the available count and let
   * concurrency drift above the configured limit for the rest of the process's
   * life.
   */
  release(): void;
}

export interface LiveRunConcurrencyLimiter {
  /** Takes a slot, or returns null if all slots are in use. Never blocks. */
  tryAcquire(): LiveRunConcurrencyLease | null;
  /** In-flight count. Exposed for tests asserting release on every exit path. */
  readonly inFlight: number;
}

export function createLiveRunConcurrencyLimiter(maxConcurrency: number): LiveRunConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("createLiveRunConcurrencyLimiter requires an integer maxConcurrency of at least 1.");
  }

  let inFlight = 0;

  return {
    tryAcquire(): LiveRunConcurrencyLease | null {
      if (inFlight >= maxConcurrency) {
        return null;
      }

      inFlight += 1;
      let released = false;

      return {
        release(): void {
          // The idempotence guard is per-lease state, not a set of lease ids:
          // a lease that has already been returned simply does nothing.
          if (released) return;
          released = true;
          inFlight -= 1;
        },
      };
    },

    get inFlight(): number {
      return inFlight;
    },
  };
}
