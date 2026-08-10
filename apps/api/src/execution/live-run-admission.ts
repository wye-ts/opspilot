import {
  LiveRunAdmissionError,
  PersistenceError,
  type LiveRunBudgetReservationInput,
  type PublicTrialReservationInput,
} from "@opspilot/database";
import type { Request, Response } from "express";

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
import type { TurnstileVerifier } from "./turnstile-verifier";
import type { VisitorIdentity } from "./visitor-identity";

/**
 * The header carrying a solved Turnstile token, PUBLIC trial requests only
 * (issue #39). Never read on the private-token path, and never a body field —
 * same reasoning as LIVE_RUN_ACCESS_TOKEN_HEADER: a token in a URL or body
 * ends up in more places than a header does, none of which the gate could
 * then undo.
 */
export const TURNSTILE_TOKEN_HEADER = "x-opspilot-turnstile-token";

/**
 * What a successfully admitted NEW LIVE run carries into execution.
 *
 * Two EXPLICIT resources, deliberately not one opaque `settle()` handle. An
 * earlier design combined reconciliation and lease release behind a single call,
 * which meant a reconciliation throw both replaced the real HTTP response and
 * leaked the concurrency slot. Separating them lets the caller structure cleanup
 * so that neither failure can affect the other — see the controller's nested
 * finally.
 *
 * A REPLAY never receives one of these, because a replay acquires nothing: no
 * lease to release, no reservation input to consume. That is the whole reason
 * admission is split in two.
 */
export interface NewRunAdmissionLease {
  /** Consumed INSIDE the run-creation transaction, never reserved out here. */
  readonly reservationInput: LiveRunBudgetReservationInput;
  readonly concurrencyLease: LiveRunConcurrencyLease;
}

/**
 * Proof that Stage A passed — and the handle that records how the request ended.
 *
 * A VALUE rather than a boolean, so `admitNewRun` cannot be called without it.
 * Authorization and spend admission are separate stages precisely so a replay can
 * skip the second; making the second take the first's result is what stops that
 * separation from also becoming a way to skip the first.
 *
 * NONE of these three methods is called by this module on the caller's behalf
 * once `admitNewRun` has returned a lease. That is deliberate: passing every
 * spend gate is not the same fact as the authoritative transaction actually
 * creating a new run. A concurrent same-key request can still commit first, in
 * which case THIS request's own authoritative transaction resolves as a replay
 * — so only the caller, after it has that result in hand, knows which of
 * `recordAdmitted` / `recordReplayed` applies. See the controller.
 */
export interface AuthorizedLiveRequest {
  /**
   * Records that this request genuinely started (and, if the provider or
   * finalization later failed, already ran) a NEW LIVE execution.
   *
   * Called only once the authoritative transaction's result is known —
   * `execution: "started"`, a finalization-stage persistence failure (the
   * provider ran; only persisting the outcome failed), or a crash after the
   * provider was invoked. Never called merely because the rate limit, the
   * budget gate, and the concurrency lease were passed: at that point the
   * transaction has not run yet and may still resolve as a replay.
   */
  readonly recordAdmitted: () => void;
  /**
   * Records that this request was answered by REPLAYING an existing run.
   *
   * Two different callers reach this for two different reasons: the Stage-B
   * lookup (`replayLiveRun`) found a row before any spend gate ran, or the
   * authoritative transaction itself resolved `execution: "replayed"` after a
   * concurrent same-key request won the race. Both are the same fact from the
   * admission log's point of view — no allowance was consumed, nothing was
   * created by this request — so both record identically.
   */
  readonly recordReplayed: () => void;
  /**
   * Records a rejection — whether raised between the two stages (a failed
   * replay lookup) or inside the authoritative transaction (attempt limit,
   * budget exhausted, context invalid, or a run-creation persistence failure).
   * Same closed-field treatment as any other rejection: only an ApiError's
   * catalog code is emitted, never a message.
   */
  readonly recordRejected: (error: unknown) => void;
}

export interface LiveRunAdmissionController {
  /**
   * STAGE A — steps 2–4: capability, kill switch, shared access token.
   *
   * Everything a request must satisfy REGARDLESS of whether it turns out to be a
   * recovery or a new execution. Synchronous and pure: it reads config and one
   * header, touches no database, takes no lease, and consumes no allowance.
   *
   * Runs before the replay lookup so idempotency is never an authentication
   * bypass, and so no unauthenticated caller can learn whether a key exists.
   */
  authorize(request: Request): AuthorizedLiveRequest;
  /**
   * STAGE C — steps 5–7: per-client rate limit, advisory budget gate, concurrency
   * lease. The gates that decide whether a NEW PAID EXECUTION may be ATTEMPTED.
   *
   * Reached only after the replay lookup found nothing, so a closed budget, an
   * exhausted rate window, or a busy concurrency slot can no longer prevent an
   * already-created run from being recovered. None of them is weakened for a new
   * key: this is the same sequence, in the same order, with the same codes.
   *
   * RESOLVING THIS PROMISE IS NOT THE FINAL ADMISSION DECISION, and this method
   * does not log one. Passing steps 5–7 means only that the request MAY proceed
   * to the authoritative transaction (step 8) — that transaction can still
   * discover the same key was just committed by a concurrent request and answer
   * `execution: "replayed"` instead. The caller settles `recordAdmitted` /
   * `recordReplayed` on `authorized` only once that result is known.
   *
   * Steps 1 (request validation) and 8–12 (the authoritative transaction,
   * execution, reconciliation, release) remain the caller's.
   */
  admitNewRun(request: Request, authorized: AuthorizedLiveRequest): Promise<NewRunAdmissionLease>;
  /**
   * STAGE B (issue #39) — PUBLIC trial only: Turnstile verification, then
   * visitor identity resolution. A no-op on the private-token path — resolves
   * to `null` immediately, no network call, no cookie read or write — because
   * `authorize` already fully authorized that request.
   *
   * MUST run between `authorize` and any database access (the replay lookup
   * included): docs/reviews/23-issue-39-public-live-trial-plan.md §9 requires
   * Turnstile to be the first thing checked on the PUBLIC path, before any
   * database access at all, so a missing/failed challenge never lets an
   * unauthenticated caller learn whether a client key already names a run.
   *
   * A failed Turnstile check throws LIVE_RUN_TURNSTILE_FAILED, through the
   * SAME one-shot recorder `authorize` created — consuming no visitor quota,
   * no public budget, and creating no reservation, exactly like every other
   * Stage A/B rejection.
   *
   * On success, sets the signed visitor cookie on `response` UNCONDITIONALLY
   * — regardless of what the eventual admission transaction decides — so a
   * quota-exhausted visitor converges on a stable identity instead of
   * re-solving Turnstile for nothing on a later attempt (§5).
   */
  authorizePublicTrial(
    request: Request,
    response: Response,
    authorized: AuthorizedLiveRequest,
  ): Promise<PublicTrialReservationInput | null>;
  /**
   * Issue #39 — the current visitor's own remaining PUBLIC trial allowance for
   * `/v1/capabilities`. READ-ONLY: resolves an existing cookie if present but
   * never mints or sets one — a caller with no cookie is a new visitor with
   * the default allowance of 1, not something this probe should ever create
   * state for merely because a page loaded. Advisory, like `isAvailable`; the
   * authoritative gate remains the visitor-day reservation inside
   * `startLiveRunWithAttemptLimit`.
   */
  getVisitorRunsRemaining(request: Request): Promise<0 | 1>;
  /**
   * Whether a new LIVE run could be admitted right now. Advisory; see below.
   *
   * When `publicTrial` is `true`, also verifies the PUBLIC sub-ceilings
   * (5/day, $0.50/day) against the budget row. When absent/false, checks
   * only the overall budget — the private path's existing behavior, unchanged.
   */
  isAvailable(publicTrial?: boolean): Promise<boolean>;
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
  /**
   * Issue #39 — required iff `config.livePublicTrial.enabled`. Absent on a
   * private-only deployment, where `authorizePublicTrial` never reaches the
   * code that would use them.
   */
  readonly turnstileVerifier?: TurnstileVerifier;
  readonly visitorIdentity?: VisitorIdentity;
  /**
   * Whether the given visitor could still start today's PUBLIC trial run.
   * Injected exactly like `isBudgetOpen`, so this module stays free of
   * persistence concerns.
   */
  readonly isVisitorTrialAvailable?: (visitorId: string, budgetDate: string) => Promise<boolean>;
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
  const { config, isBudgetOpen, turnstileVerifier, visitorIdentity, isVisitorTrialAvailable } = dependencies;
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

  /**
   * The per-request, ONE-SHOT decision recorder.
   *
   * "Exactly one decision line per LIVE request" used to be structural for free:
   * there was a single `admit` call, so a single wrapper around it could not
   * possibly log twice. Splitting admission into two stages — with a database
   * lookup in between that has outcomes of its own — removes that guarantee and
   * would leave "log once" as a rule four call sites have to remember.
   *
   * So the guarantee moves into the recorder itself. It is created once per
   * request by `authorize`, every stage records through it, and the first record
   * wins: a later one is a silent no-op. A request therefore emits one line or
   * none, whatever sequence of stages it took and whichever of them threw.
   */
  function createDecisionRecorder() {
    let settled = false;
    // `reason` is OMITTED from the call to `logDecision` entirely (not passed
    // as `null`) unless a genuine classification exists — see
    // LiveRunAdmissionDecisionLogger. Keeping the two-key shape for every
    // other decision is deliberate, not an oversight: it is what every
    // existing "emits {decision, code}" assertion in this suite continues to
    // mean unchanged.
    const record = (decision: "admitted" | "replayed" | "rejected", code: string | null, reason: string | null = null) => {
      if (settled) return;
      settled = true;
      logDecision(reason !== null ? { decision, code, reason } : { decision, code });
    };
    return {
      admitted: () => record("admitted", null),
      replayed: () => record("replayed", null),
      // Only the ApiError CODE — a fixed catalog identifier. Never the message,
      // the presented token, the client address, the budget figures, or the
      // remaining headroom. A non-ApiError has no public code, so it logs as
      // `null` rather than having an internal message pressed into service.
      //
      // Issue #39 — the one exception to "no figures": when the rejection is a
      // LIVE_RUN_BUDGET_EXHAUSTED wrapping a LiveRunAdmissionError that carries
      // an internal `reason` classification (see agent-run-repository.ts's
      // classifyBudgetRejection), that closed six-value enum rides along too.
      // It is not a figure or a count — it names WHICH condition closed the
      // gate, never how close any of them were.
      rejected: (error: unknown) => {
        const code = error instanceof ApiError ? error.code : null;
        const reason =
          error instanceof ApiError && error.cause instanceof LiveRunAdmissionError && error.cause.reason !== undefined
            ? error.cause.reason
            : null;
        record("rejected", code, reason);
      },
    };
  }

  type DecisionRecorder = ReturnType<typeof createDecisionRecorder>;

  /**
   * The recorder behind an `AuthorizedLiveRequest`, resolved by identity.
   *
   * `admitNewRun` needs the recorder its own request's `authorize` created, and
   * the handle it is given is a public interface a caller could in principle
   * construct. A WeakMap keyed on the handle keeps the association private
   * without putting the recorder on the interface, and without leaking entries
   * for requests that ended before Stage C.
   */
  const recorders = new WeakMap<AuthorizedLiveRequest, DecisionRecorder>();

  /**
   * Issue #39 — tracks which `AuthorizedLiveRequest` handles have already
   * consumed their rate-limit slot inside `authorizePublicTrial`. When present,
   * `admitNewRunOnce` skips its own rate-limit check, so a single PUBLIC
   * request consumes exactly one slot — not one before Turnstile and a second
   * one in Stage C.
   */
  const rateLimitConsumed = new WeakSet<AuthorizedLiveRequest>();

  function authorizeOnce(request: Request): void {
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

    // ── Step 4. Shared access token, OR the PUBLIC trial path (issue #39) ───
    // Before the rate limiter on purpose: an unauthenticated caller should not
    // be able to consume another client's rate-limit budget, and the token
    // check is pure local computation.
    //
    // Before the REPLAY LOOKUP for a stronger reason: a replay reads a run row,
    // and the endpoint stays protected. An unauthenticated caller must not be
    // able to learn whether a key names an existing run, which is exactly what a
    // 200-versus-429 difference would tell them.
    //
    // The provided value is read straight into verify() and never stored,
    // logged, echoed, or copied anywhere else.
    if (config.liveRunAccess.kind === "token-required") {
      const presented = request.header(LIVE_RUN_ACCESS_TOKEN_HEADER);
      if (config.liveRunAccess.verify(presented)) {
        // Valid private token — private path. authorizePublicTrial is a no-op
        // for this request.
        return;
      }
      // A token was EXPLICITLY presented but is invalid. This caller is on the
      // private path — deny unconditionally, even when the public trial flag is
      // also on. An invalid token is never downgraded to PUBLIC, never reaches
      // Turnstile, never touches visitor identity, and never enters public
      // admission.
      if (presented !== undefined) {
        throw new ApiError("LIVE_RUN_ACCESS_DENIED");
      }
      // No token presented at all. When the PUBLIC trial flag is on, the
      // request is eligible for the public path — Stage B (authorizePublicTrial)
      // will gate it with Turnstile + visitor identity.
      if (config.livePublicTrial.enabled) {
        return;
      }
      // No token, no public flag — nothing left to try.
      throw new ApiError("LIVE_RUN_ACCESS_DENIED");
    }

    // No token configured. Valid ONLY when the PUBLIC trial flag supplies a
    // different admission control for this request — Turnstile + visitor
    // identity, checked next by authorizePublicTrial (Stage B), never here.
    // This method deliberately does nothing more in that case: no token to
    // check, and Stage B's own gate is what makes the request safe.
    if (config.livePublicTrial.enabled) {
      return;
    }

    // Unreachable by construction: startup fails when capability is present,
    // the switch is on, no token is configured, AND the public flag is off
    // (see parseLiveRunAccess). Refusing here rather than trusting that keeps
    // the failure closed even if that invariant is ever weakened.
    throw new ApiError("LIVE_RUN_ACCESS_DENIED");
  }

  async function admitNewRunOnce(
    request: Request,
    authorized: AuthorizedLiveRequest,
  ): Promise<NewRunAdmissionLease> {
    // ── Step 5. Per-client rate limit ──────────────────────────────────────
    // `req.ip`, which is only meaningful because main.ts set a NUMERIC
    // `trust proxy` hop count. This raises the cost of casual abuse; it is not
    // identity and not a spend guarantee.
    //
    // Skipped when the PUBLIC path already consumed this request's rate-limit
    // slot inside authorizePublicTrial (issue #39) — one request, one slot,
    // never two.
    if (!rateLimitConsumed.has(authorized)) {
      const rateDecision = rateLimiter.check(request.ip ?? "unknown");
      if (!rateDecision.allowed) {
        throw new ApiError("LIVE_RUN_RATE_LIMITED", {
          retryAfterSeconds: rateDecision.retryAfterSeconds,
        });
      }
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
     * Stage A, with the request's one-shot decision recorder created here.
     *
     * Every rejection inside authorizeOnce is logged automatically, because there
     * is one call site rather than one per `throw` — the same property the old
     * single-stage wrapper had, preserved across the split by the recorder.
     */
    authorize(request: Request): AuthorizedLiveRequest {
      const recorder = createDecisionRecorder();
      try {
        authorizeOnce(request);
      } catch (error) {
        recorder.rejected(error);
        throw error;
      }

      const authorized: AuthorizedLiveRequest = {
        recordAdmitted: () => recorder.admitted(),
        recordReplayed: () => recorder.replayed(),
        recordRejected: (error: unknown) => recorder.rejected(error),
      };
      recorders.set(authorized, recorder);
      return authorized;
    },

    /**
     * Stage C, recording through the SAME recorder Stage A created.
     *
     * An `authorized` handle this controller did not issue falls back to a fresh
     * recorder rather than throwing: a request that somehow reached here without
     * a known handle has still been decided, and losing its log line is a better
     * failure than losing its response. The gates below run either way.
     *
     * DOES NOT RECORD `admitted` ON SUCCESS. That used to happen here, and it was
     * wrong: passing the rate limit, the budget gate, and the concurrency lease
     * proves only that the request MAY reach the authoritative transaction, not
     * that the transaction will create a new run. A concurrent same-key request
     * can still commit first, so this request's own transaction may yet resolve
     * as `execution: "replayed"` — at which point logging `admitted` here would
     * already have been a false record of a paid execution that never happened.
     * The caller settles the recorder once that result is known.
     */
    async admitNewRun(
      request: Request,
      authorized: AuthorizedLiveRequest,
    ): Promise<NewRunAdmissionLease> {
      const recorder = recorders.get(authorized) ?? createDecisionRecorder();

      try {
        return await admitNewRunOnce(request, authorized);
      } catch (error) {
        recorder.rejected(error);
        throw error;
      }
    },

    async authorizePublicTrial(
      request: Request,
      response: Response,
      authorized: AuthorizedLiveRequest,
    ): Promise<PublicTrialReservationInput | null> {
      if (config.liveRunAccess.kind === "token-required") {
        // If THIS request bears a valid private token, it is on the private
        // path — Turnstile is unnecessary. Return null immediately (no-op).
        // The deployment may have BOTH a token and the public flag on; a
        // request with a valid token takes the private path, a request
        // without one falls through to Turnstile below.
        const presented = request.header(LIVE_RUN_ACCESS_TOKEN_HEADER);
        if (config.liveRunAccess.verify(presented)) {
          return null;
        }
      }

      if (!config.livePublicTrial.enabled || turnstileVerifier === undefined || visitorIdentity === undefined) {
        // Unreachable by construction: authorizeOnce already refused any
        // request that reaches here unless config.livePublicTrial.enabled,
        // and createLiveRunAdmissionController's factory (run-execution.module.ts)
        // supplies both dependencies whenever that flag is on. Fail closed
        // rather than trust the invariant.
        const recorder = recorders.get(authorized) ?? createDecisionRecorder();
        const error = new ApiError("INTERNAL_ERROR");
        recorder.rejected(error);
        throw error;
      }

      const recorder = recorders.get(authorized) ?? createDecisionRecorder();

      // ── Step 5 (public). Per-client rate limit (same limiter, same window,
      // same bucket as admitNewRunOnce). Applied BEFORE Turnstile so a bot
      // that fails the challenge repeatedly still hits the 2/60s burst
      // limiter — a missing Turnstile check must not be cheaper than a
      // missing token check. Consumes no visitor quota, no public budget, and
      // creates no reservation.
      const rateDecision = rateLimiter.check(request.ip ?? "unknown");
      if (!rateDecision.allowed) {
        const error = new ApiError("LIVE_RUN_RATE_LIMITED", {
          retryAfterSeconds: rateDecision.retryAfterSeconds,
        });
        recorder.rejected(error);
        throw error;
      }
      // The rate-limit slot is consumed NOW — before Turnstile — so that
      // admitNewRunOnce skips its own duplicate check. One PUBLIC request
      // consumes exactly one slot regardless of whether Turnstile or the
      // admission transaction later passes or fails.
      rateLimitConsumed.add(authorized);

      // ── Step 6 (public). Turnstile — before ANY database access, including
      // the replay lookup the caller runs immediately after this resolves.
      // See docs/reviews/23-issue-39-public-live-trial-plan.md §9: a missing
      // or failed challenge is a generic client-visible rejection, consumes
      // no visitor quota and no public budget, and creates no reservation.
      const verified = await turnstileVerifier.verify(request.header(TURNSTILE_TOKEN_HEADER), request.ip);
      if (!verified) {
        const error = new ApiError("LIVE_RUN_TURNSTILE_FAILED");
        recorder.rejected(error);
        throw error;
      }

      // ── Step 7 (public). Visitor identity — resolve, else mint fresh.
      const visitorId = visitorIdentity.resolveVisitorId(request) ?? visitorIdentity.mintVisitorId();
      // UNCONDITIONAL, regardless of what admission decides next — see the
      // interface doc comment: a quota-exhausted visitor must still converge
      // on a stable identity rather than re-solving Turnstile for nothing.
      visitorIdentity.setVisitorCookie(response, visitorId);

      return {
        visitorId,
        publicDailyLimit: config.livePublicTrial.dailyLimit,
        publicCostCeilingNanoUsd: config.livePublicTrial.costCeilingNanoUsd,
      };
    },

    async getVisitorRunsRemaining(request: Request): Promise<0 | 1> {
      // A caller with a valid private token is on the private path — the
      // PUBLIC trial visitor allowance is not relevant for them, and 0 is
      // the honest answer.
      if (
        config.liveRunAccess.kind === "token-required" &&
        config.liveRunAccess.verify(request.header(LIVE_RUN_ACCESS_TOKEN_HEADER))
      ) {
        return 0;
      }
      // A caller who explicitly presented a token (even invalid) is on the
      // private path — never evaluate their PUBLIC visitor allowance.
      if (
        config.liveRunAccess.kind === "token-required" &&
        request.header(LIVE_RUN_ACCESS_TOKEN_HEADER) !== undefined
      ) {
        return 0;
      }
      // Token-only deployment — no PUBLIC trial to query.
      if (!config.livePublicTrial.enabled) {
        return 0;
      }
      if (visitorIdentity === undefined || isVisitorTrialAvailable === undefined) {
        return 0;
      }

      const visitorId = visitorIdentity.resolveVisitorId(request);
      if (visitorId === null) {
        // No trustworthy cookie at all — a new visitor with the default
        // allowance. See visitor-identity.ts and §5: never minted here.
        return 1;
      }

      try {
        const available = await isVisitorTrialAvailable(visitorId, utcBudgetDate(now()));
        return available ? 1 : 0;
      } catch (error) {
        // Fails closed toward the safer under-promise — mirrors isAvailable:
        // an unreadable row must never claim a trial is available when the
        // server cannot actually confirm it.
        if (error instanceof PersistenceError) return 0;
        throw error;
      }
    },

    async isAvailable(publicTrial?: boolean): Promise<boolean> {
      // Every unavailable reason collapses to a single boolean on purpose — see
      // the capabilities controller. A caller learns that LIVE cannot be started,
      // never which safeguard is engaged or how much headroom remains.
      //
      // NOT logged: this is the anonymous capabilities probe the browser makes on
      // every page load, not an admission decision, and one line per page view
      // would bury the decisions that matter.
      if (config.liveCapability.kind !== "present") return false;
      if (!config.liveAgentRunsEnabled) return false;
      // Available under EITHER access mode — the private token path or the
      // PUBLIC trial path (issue #39). Neither is a substitute for the other;
      // the kill switch above still gates both.
      if (config.liveRunAccess.kind !== "token-required" && !config.livePublicTrial.enabled) return false;

      try {
        const budget = reservationInput();
        // When called for the PUBLIC trial path, also verify the public
        // sub-ceilings (5/day, $0.50/day). The private path never passes this
        // flag, so its availability check is unaffected by public exhaustion.
        if (publicTrial && config.livePublicTrial.enabled) {
          return await isBudgetOpen({
            ...budget,
            publicDailyLimit: config.livePublicTrial.dailyLimit,
            publicCostCeilingNanoUsd: config.livePublicTrial.costCeilingNanoUsd,
          });
        }
        return await isBudgetOpen(budget);
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
