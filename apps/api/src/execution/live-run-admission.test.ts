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
  return createLiveRunAdmissionController({
    config: overrides.config ?? servableConfig(),
    isBudgetOpen: overrides.isBudgetOpen ?? (async () => true),
    ...(overrides.now ? { now: overrides.now } : {}),
    // Silent unless a test opts in, so the suite's output stays readable.
    logDecision: overrides.logDecision ?? (() => undefined),
  });
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
