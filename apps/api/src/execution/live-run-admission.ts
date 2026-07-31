import { PersistenceError, type LiveRunBudgetReservationInput } from "@opspilot/database";
import type { Request } from "express";

import { ApiError } from "../errors/api-error";
import { LIVE_RUN_ACCESS_TOKEN_HEADER } from "./live-run-access";
import {
  emitLogSafely,
  logLiveRunAdmissionDecision,
  type LiveRunAdmissionDecisionLogger,
} from "./live-run-budget-log";
import { createLiveRunConcurrencyLimiter, type LiveRunConcurrencyLease } from "./live-run-concurrency";
import { createLiveRunRateLimiter } from "./live-run-rate-limiter";
import type { RunExecutionConfig } from "./run-execution-config";

/**
 * What a successfully admitted LIVE request carries into execution.
 *
 * Two EXPLICIT resources, deliberately not one opaque `settle()` handle. An
 * earlier design combined reconciliation and lease release behind a single call,
 * which meant a reconciliation throw both replaced the real HTTP response and
 * leaked the concurrency slot. Separating them lets the caller structure cleanup
 * so that neither failure can affect the other — see the controller's nested
 * finally.
 */
export interface LiveRunAdmission {
  /** Consumed INSIDE the run-creation transaction, never reserved out here. */
  readonly reservationInput: LiveRunBudgetReservationInput;
  readonly concurrencyLease: LiveRunConcurrencyLease;
}

export interface LiveRunAdmissionController {
  /**
   * Runs admission steps 2–7 of the canonical order in exactly that sequence,
   * throwing an ApiError for any rejection.
   *
   * Steps 1 (request validation) and 8–12 (the authoritative transaction,
   * execution, reconciliation, release) are the caller's; this covers everything
   * decidable from local state before any durable write.
   */
  admit(request: Request): Promise<LiveRunAdmission>;
  /** Whether a new LIVE run could be admitted right now. Advisory; see below. */
  isAvailable(): Promise<boolean>;
}

export interface LiveRunAdmissionDependencies {
  readonly config: RunExecutionConfig;
  /**
   * Whether the durable daily budget still has room. Injected rather than taking
   * a PrismaClient, so this module stays free of persistence concerns and is
   * unit-testable with no database.
   */
  readonly isBudgetOpen: (budget: LiveRunBudgetReservationInput) => Promise<boolean>;
  /** Injected for deterministic window and UTC-date assertions. */
  readonly now?: () => Date;
  /**
   * Where the one-line-per-decision admission record goes. Injected so tests can
   * assert the emitted shape without reading stdout, and so nothing about how the
   * process logs leaks into the admission rules themselves.
   *
   * Defaults to the real logger rather than to a no-op: an unwired dependency
   * here would silently turn admission observability back into dead code.
   */
  readonly logDecision?: LiveRunAdmissionDecisionLogger;
}

/**
 * The UTC calendar day, as the "YYYY-MM-DD" key a reservation is recorded
 * against. Captured ONCE here at admission and carried through execution to
 * reconciliation — never recomputed later. A run admitted at 23:59:50Z and
 * finishing at 00:00:30Z must reconcile the day it reserved against.
 */
function utcBudgetDate(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createLiveRunAdmissionController(
  dependencies: LiveRunAdmissionDependencies,
): LiveRunAdmissionController {
  const { config, isBudgetOpen } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  /**
   * The injected sink, wrapped ONCE so no call site can forget.
   *
   * The sink is a dependency this module does not control, and admission is the
   * worst possible place for it to throw: by the time an admitted request is
   * logged, the concurrency lease is already held. An escaping throw would skip
   * the `return` that hands that lease to the caller, so nothing would ever
   * release it — permanently wedging the single LIVE slot until the process
   * restarts. On the rejection path it would replace a precise ApiError
   * (LIVE_RUN_ACCESS_DENIED, say) with whatever the logger threw, changing the
   * caller's status code because a log line failed.
   *
   * Wrapping at construction rather than at each call makes that structural: the
   * raw sink is not in scope below.
   */
  const rawLogDecision = dependencies.logDecision ?? logLiveRunAdmissionDecision;
  const logDecision: LiveRunAdmissionDecisionLogger = (params) =>
    emitLogSafely(() => rawLogDecision(params));
  const { liveRunSafeguards } = config;

  const rateLimiter = createLiveRunRateLimiter({
    max: liveRunSafeguards.rateLimitMax,
    windowMs: liveRunSafeguards.rateLimitWindowMs,
    now: () => now().getTime(),
  });
  const concurrencyLimiter = createLiveRunConcurrencyLimiter(liveRunSafeguards.maxConcurrency);

  function reservationInput(): LiveRunBudgetReservationInput {
    return {
      budgetDate: utcBudgetDate(now()),
      dailyLimit: liveRunSafeguards.dailyLimit,
      costCeilingNanoUsd: liveRunSafeguards.dailyCostCeilingNanoUsd,
    };
  }

  /**
   * The advisory read, with a database outage translated at the boundary.
   *
   * A `PersistenceError` escaping here would reach the catch-all filter as a 500
   * INTERNAL_ERROR, while the very same outage during the authoritative
   * run-creation transaction already maps to 503 PERSISTENCE_UNAVAILABLE. One
   * database failure must not produce two different public contracts, so the
   * translation happens here rather than being left to whatever catches it.
   *
   * Fails CLOSED: the throw propagates out of `admit`, so no lease is taken, no
   * transaction is opened, no run row is created, and no provider is built. An
   * unreadable budget is treated as a reason not to spend, never as permission.
   *
   * Non-persistence failures are re-thrown untouched — inventing a 503 for an
   * unknown fault would hide a real bug behind a "try again later".
   */
  async function budgetOpen(budget: LiveRunBudgetReservationInput): Promise<boolean> {
    try {
      return await isBudgetOpen(budget);
    } catch (error) {
      if (error instanceof PersistenceError) {
        // The catalog message is fixed; `cause` carries the original for internal
        // debugging only and is never serialized (see ApiError).
        throw new ApiError("PERSISTENCE_UNAVAILABLE", { cause: error });
      }
      throw error;
    }
  }

  async function admitOnce(request: Request): Promise<LiveRunAdmission> {
    // ── Step 2. Capability ─────────────────────────────────────────────────
    // Checked before the kill switch so an operator reading logs on a server
    // with no credential sees LIVE_NOT_CONFIGURED rather than a misleading
    // "disabled".
    if (config.liveCapability.kind !== "present") {
      throw new ApiError("LIVE_NOT_CONFIGURED");
    }

    // ── Step 3. Kill switch ────────────────────────────────────────────────
    // Fail closed. A capable, correctly configured deployment still refuses
    // live runs until someone deliberately turns them on, so adding a
    // credential is not by itself sufficient to start spending.
    if (!config.liveAgentRunsEnabled) {
      throw new ApiError("LIVE_RUNS_DISABLED");
    }

    // ── Step 4. Shared access token ────────────────────────────────────────
    // Before the rate limiter on purpose: an unauthenticated caller should not
    // be able to consume another client's rate-limit budget, and the token
    // check is pure local computation.
    //
    // The provided value is read straight into verify() and never stored,
    // logged, echoed, or copied anywhere else.
    if (config.liveRunAccess.kind !== "token-required") {
      // Unreachable by construction: startup fails when capability is present
      // and the switch is on but no token is configured (see
      // parseLiveRunAccess). Refusing here rather than trusting that keeps the
      // failure closed even if that invariant is ever weakened.
      throw new ApiError("LIVE_RUN_ACCESS_DENIED");
    }

    const presented = request.header(LIVE_RUN_ACCESS_TOKEN_HEADER);
    if (!config.liveRunAccess.verify(presented)) {
      throw new ApiError("LIVE_RUN_ACCESS_DENIED");
    }

    // ── Step 5. Per-client rate limit ──────────────────────────────────────
    // `req.ip`, which is only meaningful because main.ts set a NUMERIC
    // `trust proxy` hop count. This raises the cost of casual abuse; it is not
    // identity and not a spend guarantee.
    const rateDecision = rateLimiter.check(request.ip ?? "unknown");
    if (!rateDecision.allowed) {
      throw new ApiError("LIVE_RUN_RATE_LIMITED", {
        retryAfterSeconds: rateDecision.retryAfterSeconds,
      });
    }

    // ONE reservation input per admission attempt, captured here — after the
    // rate-limit decision, before the first thing that reads it — and never
    // recomputed. An earlier version called reservationInput() twice: once for
    // the advisory check and again for the returned value. Two clock reads can
    // straddle UTC midnight, and when they do the request asks "is the 29th
    // open?" and then reserves against the 30th — checking one day's headroom
    // to authorize spending on another. Capturing once makes that impossible by
    // construction rather than by the two reads happening to be microseconds
    // apart.
    const budget = reservationInput();

    // ── Step 6. Advisory budget pre-check ──────────────────────────────────
    // Cheap and explicitly NON-authoritative: it exists to fail an obviously
    // exhausted day without taking a concurrency slot or opening a
    // transaction. The real gate is the WHERE clause inside the reservation
    // statement, which is the only place that can decide without a race. A
    // false "open" here is harmless — the transaction still refuses.
    if (!(await budgetOpen(budget))) {
      throw new ApiError("LIVE_RUN_BUDGET_EXHAUSTED");
    }

    // ── Step 7. Concurrency lease ──────────────────────────────────────────
    // Acquired AFTER every cheap check and BEFORE the authoritative
    // transaction, so a request that loses the concurrency race touches no
    // durable state at all.
    const concurrencyLease = concurrencyLimiter.tryAcquire();
    if (concurrencyLease === null) {
      throw new ApiError("LIVE_RUN_CONCURRENCY_LIMIT");
    }

    return { reservationInput: budget, concurrencyLease };
  }

  return {
    /**
     * Wraps admitOnce so EXACTLY ONE decision line is emitted per LIVE request,
     * on every exit path.
     *
     * Logging out here rather than at each `throw` is what makes the "exactly
     * one" part structural: a rejection added inside admitOnce later is logged
     * automatically, and no path can log twice because there is only one call
     * site. The logger is invoked before the error propagates, so an admitted run
     * and a rejected one are recorded in the same order they were decided.
     */
    async admit(request: Request): Promise<LiveRunAdmission> {
      let admission: LiveRunAdmission;
      try {
        admission = await admitOnce(request);
      } catch (error) {
        // Only the ApiError CODE — a fixed catalog identifier. Never the message,
        // the presented token, the client address, the budget figures, or the
        // remaining headroom. A non-ApiError has no public code, so it logs as
        // `null` rather than having an internal message pressed into service.
        logDecision({
          decision: "rejected",
          code: error instanceof ApiError ? error.code : null,
        });
        throw error;
      }

      logDecision({ decision: "admitted", code: null });
      return admission;
    },

    async isAvailable(): Promise<boolean> {
      // Every unavailable reason collapses to a single boolean on purpose — see
      // the capabilities controller. A caller learns that LIVE cannot be started,
      // never which safeguard is engaged or how much headroom remains.
      //
      // NOT logged: this is the anonymous capabilities probe the browser makes on
      // every page load, not an admission decision, and one line per page view
      // would bury the decisions that matter.
      if (config.liveCapability.kind !== "present") return false;
      if (!config.liveAgentRunsEnabled) return false;
      if (config.liveRunAccess.kind !== "token-required") return false;

      try {
        return await isBudgetOpen(reservationInput());
      } catch (error) {
        // Fails closed, and stays opaque: an unreadable budget row reports
        // UNAVAILABLE like every other reason rather than turning a public,
        // unauthenticated endpoint into a database-health oracle. Unknown faults
        // still propagate — only a persistence failure has a defined safe answer.
        if (error instanceof PersistenceError) return false;
        throw error;
      }
    },
  };
}
