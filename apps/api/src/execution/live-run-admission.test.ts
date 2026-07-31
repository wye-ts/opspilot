import { PersistenceError, type LiveRunBudgetReservationInput } from "@opspilot/database";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import { createLiveRunAdmissionController } from "./live-run-admission";
import type { LiveRunAdmissionDecisionLogger } from "./live-run-budget-log";
import { parseRunExecutionConfig, type RunExecutionConfig } from "./run-execution-config";

const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";

function servableConfig(overrides: Record<string, string> = {}): RunExecutionConfig {
  return parseRunExecutionConfig({
    ANTHROPIC_API_KEY: "sk-ant-test-do-not-use-0123456789",
    ANTHROPIC_MODEL: "claude-sonnet-5",
    LIVE_AGENT_RUNS_ENABLED: "true",
    LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
    // Required once LIVE is servable — see run-execution-config.ts.
    ANTHROPIC_MAX_RETRIES: "0",
    ...overrides,
  });
}

function request(options: { readonly token?: string; readonly ip?: string } = {}): Request {
  return {
    ip: options.ip ?? "203.0.113.7",
    header: (name: string) =>
      name.toLowerCase() === "x-opspilot-demo-token" ? (options.token ?? DEMO_TOKEN) : undefined,
  } as unknown as Request;
}

function build(overrides: {
  readonly config?: RunExecutionConfig;
  readonly isBudgetOpen?: (budget: LiveRunBudgetReservationInput) => Promise<boolean>;
  readonly now?: () => Date;
  readonly logDecision?: LiveRunAdmissionDecisionLogger;
} = {}) {
  const controller = createLiveRunAdmissionController({
    config: overrides.config ?? servableConfig(),
    isBudgetOpen: overrides.isBudgetOpen ?? (async () => true),
    ...(overrides.now ? { now: overrides.now } : {}),
    // Silent unless a test opts in, so the suite's output stays readable.
    logDecision: overrides.logDecision ?? (() => undefined),
  });

  return {
    ...controller,
    /**
     * The two stages run back to back, as the controller runs them for a request
     * whose key names no existing run.
     *
     * Most tests below are about the SEQUENCE of gates, which the split did not
     * change — so they say "admit this request" once rather than restating the
     * two-call shape thirty times. The tests that are specifically about the
     * split call `authorize` and `admitNewRun` themselves.
     */
    // `async` on purpose: Stage A throws SYNCHRONOUSLY, and every caller below
    // asserts with `.rejects`.
    //
    // Settles `recordAdmitted()` on success, modelling the ordinary case this
    // admission-only suite doesn't itself exercise: the authoritative
    // transaction (step 8, owned by the controller, not this module) went on to
    // create a genuinely new run. The tests specifically about the race — where
    // that transaction instead resolves as a replay — settle the recorder
    // themselves; see "the decision log across the split" below.
    admit: async (request: Request) => {
      const authorized = controller.authorize(request);
      const lease = await controller.admitNewRun(request, authorized);
      authorized.recordAdmitted();
      return lease;
    },
  };
}

/**
 * A clock that advances one millisecond per read, starting from `startIso`.
 *
 * One millisecond is the smallest possible gap between two consecutive reads —
 * so a test built on it demonstrates that the bug is a matter of WHICH reads
 * happen, not of how slow the code is. No sleep, no fake timers, no flake.
 */
function tickingClock(startIso: string): { now: () => Date; reads: () => number } {
  const startMs = new Date(startIso).getTime();
  let reads = 0;
  return {
    now: () => new Date(startMs + reads++),
    reads: () => reads,
  };
}

describe("createLiveRunAdmissionController — one reservation date per attempt", () => {
  /**
   * The whole point of capturing the reservation input once.
   *
   * Admission previously called reservationInput() twice: once to ask "is this
   * day's budget open?" and again to build the value the transaction reserves
   * against. Each call reads the clock independently, so a request arriving in
   * the last milliseconds of a UTC day could check the 29th's headroom and then
   * reserve against the 30th — authorizing spend on a day whose budget nobody
   * looked at, and leaving the 29th's advisory answer meaningless.
   *
   * The clock here is arranged so the two reads straddle midnight EXACTLY: read
   * #1 goes to the rate limiter, #2 would be the advisory input, #3 would be the
   * re-derived one. With a single capture there is no read #3 for the day change
   * to land on.
   */
  it("uses one date for the advisory check and the returned reservation across UTC midnight", async () => {
    const clock = tickingClock("2026-07-29T23:59:59.998Z");
    const observed: string[] = [];
    const controller = build({
      now: clock.now,
      isBudgetOpen: async (budget) => {
        observed.push(budget.budgetDate);
        return true;
      },
    });

    const admission = await controller.admit(request());

    expect(observed).toEqual(["2026-07-29"]);
    expect(admission.reservationInput.budgetDate).toBe("2026-07-29");
  });

  it("reads the clock once for the reservation, so no second read can disagree", async () => {
    const clock = tickingClock("2026-07-29T23:59:59.998Z");
    const controller = build({ now: clock.now });

    await controller.admit(request());

    // One read for the rate limiter, one for the reservation. A third would be
    // the recomputation this test exists to forbid.
    expect(clock.reads()).toBe(2);
  });

  it("carries the whole reservation input, not just its date, unchanged", async () => {
    let seen: LiveRunBudgetReservationInput | null = null;
    const controller = build({
      isBudgetOpen: async (budget) => {
        seen = budget;
        return true;
      },
    });

    const admission = await controller.admit(request());

    expect(admission.reservationInput).toEqual(seen);
  });
});

describe("createLiveRunAdmissionController — advisory read failures", () => {
  const OUTAGE = () =>
    Promise.reject(new PersistenceError("PERSISTENCE_UNAVAILABLE", "connection refused"));

  it("maps a PersistenceError to a 503 PERSISTENCE_UNAVAILABLE ApiError", async () => {
    const controller = build({ isBudgetOpen: OUTAGE });

    await expect(controller.admit(request())).rejects.toMatchObject({
      code: "PERSISTENCE_UNAVAILABLE",
      status: 503,
    });
  });

  it("takes no concurrency lease, so a repeated outage never wedges the slot", async () => {
    const controller = build({ isBudgetOpen: OUTAGE });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // maxConcurrency is 1: a leaked lease would turn attempt #2 into
      // LIVE_RUN_CONCURRENCY_LIMIT.
      await expect(controller.admit(request({ ip: `198.51.100.${attempt}` }))).rejects.toMatchObject({
        code: "PERSISTENCE_UNAVAILABLE",
      });
    }
  });

  it("re-throws an unknown failure untouched", async () => {
    const controller = build({
      isBudgetOpen: () => Promise.reject(new TypeError("not a function")),
    });

    await expect(controller.admit(request())).rejects.toBeInstanceOf(TypeError);
  });

  it("reports UNAVAILABLE rather than propagating an outage out of isAvailable", async () => {
    // The capabilities endpoint is public and unauthenticated. Failing closed
    // keeps it from becoming a database-health oracle, and matches every other
    // unavailable reason byte for byte.
    const controller = build({ isBudgetOpen: OUTAGE });

    await expect(controller.isAvailable()).resolves.toBe(false);
  });
});

describe("createLiveRunAdmissionController — admission decision log", () => {
  function recording() {
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
    return { logDecision, controller: build({ logDecision }) };
  }

  it("emits exactly one admitted line for an admitted request", async () => {
    const { controller, logDecision } = recording();

    await controller.admit(request());

    expect(logDecision).toHaveBeenCalledTimes(1);
    expect(logDecision).toHaveBeenCalledWith({ decision: "admitted", code: null });
  });

  it.each([
    ["no token", { config: servableConfig() }, request({ token: "wrong" }), "LIVE_RUN_ACCESS_DENIED"],
    [
      "capability absent",
      { config: parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" }) },
      request(),
      "LIVE_NOT_CONFIGURED",
    ],
    [
      "kill switch off",
      {
        config: parseRunExecutionConfig({
          ANTHROPIC_API_KEY: "sk-ant-test-do-not-use-0123456789",
          ANTHROPIC_MODEL: "claude-sonnet-5",
        }),
      },
      request(),
      "LIVE_RUNS_DISABLED",
    ],
    ["budget closed", { isBudgetOpen: async () => false }, request(), "LIVE_RUN_BUDGET_EXHAUSTED"],
  ])("emits exactly one rejected line with the catalog code when %s", async (_label, options, req, code) => {
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
    const controller = build({ ...options, logDecision });

    await expect(controller.admit(req)).rejects.toBeInstanceOf(ApiError);

    expect(logDecision).toHaveBeenCalledTimes(1);
    expect(logDecision).toHaveBeenCalledWith({ decision: "rejected", code });
  });

  it("logs the concurrency rejection once, and the admitted run that caused it once", async () => {
    const { controller, logDecision } = recording();

    await controller.admit(request());
    await expect(controller.admit(request({ ip: "198.51.100.9" }))).rejects.toMatchObject({
      code: "LIVE_RUN_CONCURRENCY_LIMIT",
    });

    expect(logDecision.mock.calls.map(([params]) => params)).toEqual([
      { decision: "admitted", code: null },
      { decision: "rejected", code: "LIVE_RUN_CONCURRENCY_LIMIT" },
    ]);
  });

  it("logs a persistence failure under its public code, not an internal message", async () => {
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
    const controller = build({
      logDecision,
      isBudgetOpen: () =>
        Promise.reject(
          new PersistenceError("PERSISTENCE_UNAVAILABLE", "postgres://user:hunter2@db.internal"),
        ),
    });

    await expect(controller.admit(request())).rejects.toBeInstanceOf(ApiError);

    expect(logDecision).toHaveBeenCalledWith({
      decision: "rejected",
      code: "PERSISTENCE_UNAVAILABLE",
    });
    expect(JSON.stringify(logDecision.mock.calls)).not.toContain("hunter2");
  });

  it("logs no code for a non-ApiError failure rather than pressing its message into service", async () => {
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
    const controller = build({
      logDecision,
      isBudgetOpen: () => Promise.reject(new TypeError("internal detail")),
    });

    await expect(controller.admit(request())).rejects.toBeInstanceOf(TypeError);

    expect(logDecision).toHaveBeenCalledWith({ decision: "rejected", code: null });
    expect(JSON.stringify(logDecision.mock.calls)).not.toContain("internal detail");
  });

  it("never logs the presented token, the client address, or any budget figure", async () => {
    const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
    const controller = build({ logDecision });

    await controller.admit(request({ token: DEMO_TOKEN, ip: "198.51.100.42" }));

    const serialized = JSON.stringify(logDecision.mock.calls);
    expect(serialized).not.toContain(DEMO_TOKEN);
    expect(serialized).not.toContain("198.51.100.42");
    expect(serialized).not.toMatch(/dailyLimit|costCeiling|nanoUsd|runsReserved/i);
  });

  /**
   * Logging is an observer. A sink that throws — a broken transport, a
   * serializer that chokes, a test double someone wired wrong — must not be able
   * to change what admission decided or what it holds.
   *
   * The admitted case is the dangerous one: by the time the line is emitted the
   * concurrency lease is already acquired, so an escaping throw would skip the
   * `return` that hands it to the caller. Nothing would ever release it, and the
   * single LIVE slot would stay wedged until the process restarted.
   */
  describe("a throwing sink cannot affect the decision", () => {
    const exploding = () => {
      throw new Error("log transport unavailable");
    };

    it("still returns the admission, with its lease, when the admitted line throws", async () => {
      const controller = build({ logDecision: exploding });

      const admission = await controller.admit(request());

      expect(admission.concurrencyLease).toBeDefined();
      expect(admission.reservationInput.budgetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("releases that lease, so the next request is admitted rather than wedged", async () => {
      const controller = build({ logDecision: exploding });

      const first = await controller.admit(request());
      first.concurrencyLease.release();

      // Would be LIVE_RUN_CONCURRENCY_LIMIT if the throw had lost the lease.
      await expect(controller.admit(request())).resolves.toBeDefined();
    });

    it("preserves the original ApiError code and status when the rejection line throws", async () => {
      const controller = build({ logDecision: exploding });

      // The caller must still learn it presented a bad token — not "log
      // transport unavailable".
      await expect(controller.admit(request({ token: "wrong" }))).rejects.toMatchObject({
        code: "LIVE_RUN_ACCESS_DENIED",
        status: 401,
      });
    });

    it("preserves a non-ApiError failure unchanged too", async () => {
      const controller = build({
        logDecision: exploding,
        isBudgetOpen: () => Promise.reject(new TypeError("not a function")),
      });

      await expect(controller.admit(request())).rejects.toBeInstanceOf(TypeError);
    });

    it("does not recursively re-log a logging failure", async () => {
      // The sink is called once per decision and its throw is swallowed. A
      // "log the logging failure" fallback would either throw again or recurse.
      let calls = 0;
      const controller = build({
        logDecision: () => {
          calls += 1;
          throw new Error("log transport unavailable");
        },
      });

      await controller.admit(request());

      expect(calls).toBe(1);
    });
  });

  it("does not log the anonymous capabilities probe", async () => {
    // isAvailable answers a public page-load probe, not an admission decision.
    // One line per page view would bury the decisions that matter.
    const { controller, logDecision } = recording();

    await controller.isAvailable();

    expect(logDecision).not.toHaveBeenCalled();
  });
});

/**
 * THE TWO STAGES, and what each one is allowed to touch.
 *
 * The defect this split closes: a request could not be recognized as a repeat of
 * an existing one until after every gate that governs NEW spending had let it
 * through. So the run created by an original request that consumed the day's last
 * reservation could never be handed back — the gate that request itself closed
 * answered first, and the lookup that would have found the run was never reached.
 *
 * Authorization must therefore hold nothing and consume nothing: it has to be
 * safe to run for a request that turns out to need no spend admission at all.
 */
describe("createLiveRunAdmissionController — authorize versus admitNewRun", () => {
  it("authorizes a valid request without consuming the rate-limit allowance", async () => {
    // The window allows 2. Ten authorizations later, both are still there —
    // which is what makes a replay free.
    const controller = build();

    for (let attempt = 0; attempt < 10; attempt += 1) controller.authorize(request());

    // The lease is released between the two, since maxConcurrency is 1 and this
    // test is about the rate window, not the slot.
    const first = await controller.admitNewRun(request(), controller.authorize(request()));
    first.concurrencyLease.release();
    const second = await controller.admitNewRun(request(), controller.authorize(request()));
    second.concurrencyLease.release();
  });

  it("authorizes without reading the budget at all", () => {
    let reads = 0;
    const controller = build({
      isBudgetOpen: async () => {
        reads += 1;
        return true;
      },
    });

    controller.authorize(request());

    // A closed or unreadable day must not be able to refuse a recovery, and the
    // only way to guarantee that is not to ask.
    expect(reads).toBe(0);
  });

  it("authorizes without taking the concurrency lease", async () => {
    // maxConcurrency is 1. If authorize took the slot, this admission would come
    // back LIVE_RUN_CONCURRENCY_LIMIT rather than succeeding.
    const controller = build();

    controller.authorize(request());
    controller.authorize(request());

    const authorized = controller.authorize(request());
    await expect(controller.admitNewRun(request(), authorized)).resolves.toBeDefined();
  });

  it.each([
    ["capability absent", { config: parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" }) }, request(), "LIVE_NOT_CONFIGURED"],
    [
      "kill switch off",
      {
        config: parseRunExecutionConfig({
          ANTHROPIC_API_KEY: "sk-ant-test-do-not-use-0123456789",
          ANTHROPIC_MODEL: "claude-sonnet-5",
        }),
      },
      request(),
      "LIVE_RUNS_DISABLED",
    ],
    ["wrong token", {}, request({ token: "wrong" }), "LIVE_RUN_ACCESS_DENIED"],
  ])("rejects %s at Stage A, before any new-run gate", (_label, options, req, code) => {
    const controller = build(options);

    // Every one of these applies to a REPLAY too: idempotency is not an
    // authentication bypass, and it is not a way around the kill switch.
    expect(() => controller.authorize(req)).toThrow(expect.objectContaining({ code }));
  });

  it("keeps the new-run gates in their canonical order behind Stage A", async () => {
    // Budget closed AND the rate window about to run out. The rate limiter is
    // step 5 and the budget is step 6, so the third request must report the rate
    // limit — proving admitNewRun did not reorder them on its way out of admit().
    const controller = build({ isBudgetOpen: async () => false });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authorized = controller.authorize(request());
      await expect(controller.admitNewRun(request(), authorized)).rejects.toMatchObject({
        code: "LIVE_RUN_BUDGET_EXHAUSTED",
      });
    }

    const authorized = controller.authorize(request());
    await expect(controller.admitNewRun(request(), authorized)).rejects.toMatchObject({
      code: "LIVE_RUN_RATE_LIMITED",
    });
  });

  describe("the decision log across the split", () => {
    /**
     * THE RACE THIS SUITE EXISTS TO CLOSE.
     *
     * `admitNewRun` resolving is not proof that a new run was created — only
     * that the request may go on to the authoritative transaction. A concurrent
     * same-key request can still commit first, in which case THIS request's own
     * transaction discovers the row and resolves as a replay. Logging `admitted`
     * as soon as the lease was acquired would misreport that outcome.
     */
    it("does not log anything merely because admitNewRun succeeded", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      await controller.admitNewRun(request(), authorized);

      // The authoritative transaction has not run yet, from this module's point
      // of view — it could still resolve either way, so nothing is settled.
      expect(logDecision).not.toHaveBeenCalled();
    });

    it("emits exactly one admitted line once the caller confirms a genuinely started run", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      await controller.admitNewRun(request(), authorized);
      // Stands in for the controller's `recordExecutionDecision`, called once
      // `executeAndPersist` returns `execution: "started"`.
      authorized.recordAdmitted();

      // Two calls to this module, ONE line. Splitting the stages must not
      // double the log.
      expect(logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "admitted", code: null },
      ]);
    });

    it("emits exactly one replayed line when the authoritative transaction loses the race", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      await controller.admitNewRun(request(), authorized);
      // A concurrent same-key request committed first, so THIS request's
      // authoritative transaction returned `execution: "replayed"` instead of
      // creating anything — even though every spend gate had already passed.
      authorized.recordReplayed();

      expect(logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "replayed", code: null },
      ]);
    });

    it("emits exactly one replayed line when the caller reports a replay", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      authorized.recordReplayed();

      // `replayed`, not `admitted`: no allowance was consumed, no lease taken,
      // no run created. Counting it as an admission would make a free recovery
      // indistinguishable from a paid execution in the operator's log.
      expect(logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "replayed", code: null },
      ]);
    });

    it("records a rejection raised between the stages, under its catalog code", () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      authorized.recordRejected(new ApiError("PERSISTENCE_UNAVAILABLE"));

      expect(logDecision).toHaveBeenCalledWith({
        decision: "rejected",
        code: "PERSISTENCE_UNAVAILABLE",
      });
    });

    it("logs no code for a non-ApiError raised between the stages", () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      controller.authorize(request()).recordRejected(new TypeError("internal detail"));

      expect(logDecision).toHaveBeenCalledWith({ decision: "rejected", code: null });
      expect(JSON.stringify(logDecision.mock.calls)).not.toContain("internal detail");
    });

    it("keeps the FIRST decision when a caller records twice", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request());
      authorized.recordReplayed();
      // A replay never reaches admitNewRun; doing it anyway proves the recorder
      // is one-shot rather than relying on the call sites to be disciplined.
      await controller.admitNewRun(request(), authorized);
      authorized.recordRejected(new ApiError("LIVE_RUN_ACCESS_DENIED"));

      expect(logDecision.mock.calls.map(([params]) => params)).toEqual([
        { decision: "replayed", code: null },
      ]);
    });

    it("emits one line, not two, when Stage A rejects", () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      expect(() => controller.authorize(request({ token: "wrong" }))).toThrow(ApiError);

      expect(logDecision).toHaveBeenCalledTimes(1);
      expect(logDecision).toHaveBeenCalledWith({
        decision: "rejected",
        code: "LIVE_RUN_ACCESS_DENIED",
      });
    });

    it("never logs the token or the client address across either stage", async () => {
      const logDecision = vi.fn<LiveRunAdmissionDecisionLogger>();
      const controller = build({ logDecision });

      const authorized = controller.authorize(request({ token: DEMO_TOKEN, ip: "198.51.100.42" }));
      authorized.recordReplayed();

      const serialized = JSON.stringify(logDecision.mock.calls);
      expect(serialized).not.toContain(DEMO_TOKEN);
      expect(serialized).not.toContain("198.51.100.42");
    });

    it("admitNewRun hands over the lease untouched by the sink — it never logs on success", async () => {
      const controller = build({
        logDecision: () => {
          throw new Error("log transport unavailable");
        },
      });

      const authorized = controller.authorize(request());
      const lease = await controller.admitNewRun(request(), authorized);

      expect(lease.concurrencyLease).toBeDefined();
      lease.concurrencyLease.release();
    });

    it("recordAdmitted with an exploding sink still leaves the lease usable", async () => {
      // The scenario that used to be dangerous, now one step later: by the time
      // the CALLER settles `admitted`, the lease is already held. An escaping
      // throw here must not prevent the caller from releasing it.
      const controller = build({
        logDecision: () => {
          throw new Error("log transport unavailable");
        },
      });

      const authorized = controller.authorize(request());
      const lease = await controller.admitNewRun(request(), authorized);

      expect(() => authorized.recordAdmitted()).not.toThrow();
      lease.concurrencyLease.release();
    });
  });
});
