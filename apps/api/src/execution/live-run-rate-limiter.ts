/**
 * A fixed-window, per-client request guard for the LIVE admission path.
 *
 * In-process on purpose. `@nestjs/throttler` would give the same guarantee on
 * this single-instance deployment — its default storage is also in-memory — but
 * its distributed story needs a Redis instance that does not exist here, so it
 * would add a production dependency for about sixty reviewable lines. The
 * moment this becomes multi-instance, throttler is the right answer and the
 * swap is mechanical: `ThrottlerModule.forRoot`, `ThrottlerGuard`, `getTracker`,
 * and a pluggable `ThrottlerStorage` map onto this surface one-to-one.
 *
 * Honest scope: this raises the cost of casual abuse. It is NOT identity, and
 * it is NOT a spend guarantee — the durable daily budget is (see §13). State is
 * per process and resets on restart.
 */
export interface LiveRunRateLimiterOptions {
  readonly max: number;
  readonly windowMs: number;
  /**
   * Injected so window boundaries are exercised deterministically instead of
   * with sleeps. Defaults to the real clock.
   */
  readonly now?: () => number;
}

export type LiveRunRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface LiveRunRateLimiter {
  /** Records an attempt by `clientKey` and reports whether it is permitted. */
  check(clientKey: string): LiveRunRateLimitDecision;
  /** Number of tracked buckets. Exposed for tests asserting that pruning happens. */
  readonly trackedClients: number;
}

interface ClientBucket {
  count: number;
  windowStartMs: number;
}

export function createLiveRunRateLimiter(options: LiveRunRateLimiterOptions): LiveRunRateLimiter {
  const { max, windowMs } = options;
  const now = options.now ?? Date.now;

  if (!Number.isInteger(max) || max < 1) {
    throw new Error("createLiveRunRateLimiter requires an integer max of at least 1.");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error("createLiveRunRateLimiter requires an integer windowMs of at least 1.");
  }

  const buckets = new Map<string, ClientBucket>();

  /**
   * Drops buckets whose window has already closed.
   *
   * Without this, one request per unique spoofable client key would grow the
   * map forever — a slow memory leak reachable from unauthenticated traffic,
   * which is a worse problem than the rate limiting solves. Pruning on each
   * check keeps the map proportional to *currently active* clients, and the
   * work is bounded by that same size.
   */
  function pruneExpired(currentMs: number): void {
    for (const [key, bucket] of buckets) {
      if (currentMs - bucket.windowStartMs >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(clientKey: string): LiveRunRateLimitDecision {
      const currentMs = now();
      pruneExpired(currentMs);

      const existing = buckets.get(clientKey);

      // A fresh window: either no bucket at all, or one whose window has
      // closed. Fixed-window, not sliding — the count resets wholesale at the
      // boundary rather than decaying, which is both simpler to reason about
      // and simpler to explain in a 429.
      if (existing === undefined || currentMs - existing.windowStartMs >= windowMs) {
        buckets.set(clientKey, { count: 1, windowStartMs: currentMs });
        return { allowed: true };
      }

      if (existing.count < max) {
        existing.count += 1;
        return { allowed: true };
      }

      // Rejected. The attempt is deliberately NOT counted: letting a blocked
      // client push its own count higher would extend nothing (the window start
      // is fixed) but would make the counter meaningless.
      const elapsedMs = currentMs - existing.windowStartMs;
      const remainingMs = windowMs - elapsedMs;

      return {
        allowed: false,
        // Rounded UP, and never below 1: Retry-After is in whole seconds, and a
        // value of 0 would invite an immediate retry that is guaranteed to be
        // rejected again.
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    },

    get trackedClients(): number {
      return buckets.size;
    },
  };
}
