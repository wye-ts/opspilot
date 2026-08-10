import { ProviderConfigError, type EnvRecord } from "@opspilot/provider-claude";
import { describe, expect, it } from "vitest";

import {
  LIVE_RUN_DEFAULTS,
  REQUIRED_MAX_CONCURRENCY,
  parseRunExecutionConfig,
} from "./run-execution-config";

const SECRET = "sk-ant-test-do-not-use-0123456789";
const DEMO_TOKEN = "demo-token-do-not-use-8f14e45fceea";

function capableEnv(overrides: EnvRecord = {}): EnvRecord {
  return {
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    ...overrides,
  };
}

// Capability present AND the kill switch on — the only combination that
// requires a token (see parseLiveRunAccess).
//
// ANTHROPIC_MAX_RETRIES="0" is part of the servable posture, not an extra: the
// protected public path forbids opaque SDK retries, and the provider package's
// own default is 1. render.yaml ships the "0" explicitly for exactly this
// reason. See "protected LIVE forbids opaque SDK retries" below.
function servableEnv(overrides: EnvRecord = {}): EnvRecord {
  return capableEnv({
    LIVE_AGENT_RUNS_ENABLED: "true",
    LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
    ANTHROPIC_MAX_RETRIES: "0",
    ...overrides,
  });
}

describe("parseRunExecutionConfig — live capability is optional", () => {
  it("succeeds with no Anthropic variables at all", () => {
    // The configuration CI and ordinary local development run in. It has to be
    // a supported state, not a tolerated one.
    const config = parseRunExecutionConfig({});

    expect(config.defaultRequestMode).toBe("FAKE");
    expect(config.liveCapability.kind).toBe("absent");
  });

  it("constructs no network-capable object when capability is absent", () => {
    // Nothing to assert on the returned value directly; the guarantee is that
    // parsing performs no construction at all, which is why capability is a
    // plain discriminated union rather than a lazily-built client.
    const config = parseRunExecutionConfig({});

    expect(config.liveCapability).toEqual({ kind: "absent" });
  });

  it("resolves capability when both variables are present", () => {
    const config = parseRunExecutionConfig(capableEnv());

    expect(config.liveCapability.kind).toBe("present");
  });

  it.each([
    ["a key with no model", { ANTHROPIC_API_KEY: SECRET }, /ANTHROPIC_MODEL is required/],
    ["a model with no key", { ANTHROPIC_MODEL: "claude-sonnet-5" }, /ANTHROPIC_API_KEY is required/],
    ["an unsupported model", capableEnv({ ANTHROPIC_MODEL: "claude-opus-5" }), /must be 'claude-sonnet-5'/],
    ["an invalid timeout", capableEnv({ ANTHROPIC_TIMEOUT_MS: "45s" }), /ANTHROPIC_TIMEOUT_MS must be an integer/],
    ["an out-of-range retry count", capableEnv({ ANTHROPIC_MAX_RETRIES: "9" }), /ANTHROPIC_MAX_RETRIES must be an integer/],
  ])("fails startup on %s rather than degrading to absent", (_label, env, pattern) => {
    // A partial configuration is an operator mistake, not an intent to run
    // deterministically. Resolving it to "absent" would silently turn a
    // deployment meant to be live into one that never is.
    expect(() => parseRunExecutionConfig(env as EnvRecord)).toThrow(pattern);
  });

  it("fails startup when the default request mode is LIVE but capability is absent", () => {
    expect(() => parseRunExecutionConfig({ AGENT_RUN_PROVIDER_MODE: "LIVE" })).toThrow(
      /AGENT_RUN_PROVIDER_MODE=LIVE requires/,
    );
  });

  it("never puts a secret value in a validation error", () => {
    for (const env of [
      capableEnv({ ANTHROPIC_MODEL: "claude-opus-5" }),
      capableEnv({ ANTHROPIC_TIMEOUT_MS: "nope" }),
      capableEnv({ LIVE_AGENT_RUNS_ENABLED: "yes" }),
      { ANTHROPIC_API_KEY: SECRET },
    ]) {
      try {
        parseRunExecutionConfig(env);
        throw new Error("expected the configuration to be rejected");
      } catch (error) {
        expect((error as Error).message).not.toContain(SECRET);
      }
    }
  });
});

describe("parseRunExecutionConfig — kill switch", () => {
  it("defaults to false", () => {
    // Fail closed. Adding a credential must not be sufficient to start
    // spending money; that takes a second, deliberate action.
    expect(parseRunExecutionConfig(capableEnv()).liveAgentRunsEnabled).toBe(false);
    expect(parseRunExecutionConfig({}).liveAgentRunsEnabled).toBe(false);
  });

  it("accepts exactly 'true' and exactly 'false'", () => {
    // The `true` case supplies a token: capability + switch on without one
    // fails startup rather than serving a tokenless public LIVE path (see the
    // access-gate suite below).
    expect(parseRunExecutionConfig(servableEnv()).liveAgentRunsEnabled).toBe(true);
    expect(
      parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "false" })).liveAgentRunsEnabled,
    ).toBe(false);
  });

  it("treats an empty value as unset rather than as false", () => {
    expect(
      parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "  " })).liveAgentRunsEnabled,
    ).toBe(false);
  });

  it.each(["True", "TRUE", "1", "yes", "on", "enabled", "ture"])(
    "fails startup on %o instead of guessing",
    (raw) => {
      // A typo that silently means `false` is indistinguishable from a
      // deliberate `false` until someone notices the feature does not work.
      expect(() => parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: raw }))).toThrow(
        ProviderConfigError,
      );
    },
  );
});

describe("parseRunExecutionConfig — provider deadline", () => {
  it("defaults to 120000ms", () => {
    expect(parseRunExecutionConfig({}).providerDeadlineMs).toBe(120_000);
  });

  it("accepts an explicit in-range value", () => {
    expect(
      parseRunExecutionConfig({ AGENT_RUN_PROVIDER_DEADLINE_MS: "45000" }).providerDeadlineMs,
    ).toBe(45_000);
  });

  it.each(["0", "-1", "4999", "600001", "120s", "abc", "1.5"])(
    "rejects the invalid deadline %o",
    (raw) => {
      expect(() =>
        parseRunExecutionConfig({ AGENT_RUN_PROVIDER_DEADLINE_MS: raw }),
      ).toThrow(/AGENT_RUN_PROVIDER_DEADLINE_MS must be an integer/);
    },
  );
});

describe("parseRunExecutionConfig — shared access token", () => {
  it("resolves to absent when no token is set and LIVE cannot be served", () => {
    // The shipped state, and the state CI runs in: no credential, switch off,
    // no token. Absent must be a supported configuration, not a tolerated one.
    expect(parseRunExecutionConfig({}).liveRunAccess.kind).toBe("absent");
    expect(parseRunExecutionConfig(capableEnv()).liveRunAccess.kind).toBe("absent");
    expect(
      parseRunExecutionConfig({ LIVE_AGENT_RUNS_ENABLED: "true" }).liveRunAccess.kind,
    ).toBe("absent");
  });

  it("requires a token once capability is present and the kill switch is on", () => {
    // This is the combination that would otherwise be a tokenless public LIVE
    // path. There is no such mode in this release, so startup fails.
    expect(() => parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "true" }))).toThrow(
      /LIVE_RUN_ACCESS_TOKEN is required/,
    );
  });

  it("names LIVE_PUBLIC_TRIAL_ENABLED as the escape hatch in the failure message", () => {
    // Issue #39: this exact combination is no longer forbidden outright — it's
    // forbidden unless the public-trial flag supplies a different admission
    // control. The message should say so.
    try {
      parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "true" }));
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      expect((error as Error).message).toMatch(/unless LIVE_PUBLIC_TRIAL_ENABLED=true/);
    }
  });

  it("treats an empty or whitespace token as unset", () => {
    expect(() =>
      parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "true", LIVE_RUN_ACCESS_TOKEN: "" })),
    ).toThrow(/LIVE_RUN_ACCESS_TOKEN is required/);
    expect(() =>
      parseRunExecutionConfig(
        capableEnv({ LIVE_AGENT_RUNS_ENABLED: "true", LIVE_RUN_ACCESS_TOKEN: "   " }),
      ),
    ).toThrow(/LIVE_RUN_ACCESS_TOKEN is required/);
  });

  it("builds a verifying policy when the token is present", () => {
    const { liveRunAccess } = parseRunExecutionConfig(servableEnv());

    expect(liveRunAccess.kind).toBe("token-required");
    if (liveRunAccess.kind !== "token-required") throw new Error("expected token-required");
    expect(liveRunAccess.verify(DEMO_TOKEN)).toBe(true);
    expect(liveRunAccess.verify("wrong")).toBe(false);
    expect(liveRunAccess.verify(undefined)).toBe(false);
  });

  it("accepts a token even when LIVE is switched off, so the switch can be flipped without a redeploy", () => {
    const { liveRunAccess } = parseRunExecutionConfig(capableEnv({ LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN }));

    expect(liveRunAccess.kind).toBe("token-required");
  });

  it("never puts the token value in a validation error or in the parsed config", () => {
    const config = parseRunExecutionConfig(servableEnv());

    // A bigint-aware replacer, because the ceiling is a bigint and plain
    // JSON.stringify throws on one. That throw is itself the guarantee that no
    // response path can accidentally serialize this config — see the DTO
    // mapper, which formats nanoUSD to a decimal string at the boundary.
    const serialized = JSON.stringify(config, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );

    expect(serialized).not.toContain(DEMO_TOKEN);
    expect(serialized).not.toContain(SECRET);

    try {
      parseRunExecutionConfig(servableEnv({ LIVE_RUN_DAILY_LIMIT: "0" }));
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      expect((error as Error).message).not.toContain(DEMO_TOKEN);
    }
  });
});

describe("parseRunExecutionConfig — safeguard defaults", () => {
  it("uses the documented defaults when nothing is set", () => {
    const { liveRunSafeguards, trustProxyHops } = parseRunExecutionConfig({});

    expect(liveRunSafeguards).toEqual({
      maxOutputTokens: 1024,
      maxAttemptsPerJob: 2,
      maxConcurrency: 1,
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
      dailyLimit: 10,
      dailyCostCeilingNanoUsd: 1_000_000_000n,
    });
    expect(trustProxyHops).toBe(1);
  });

  it("keeps the exported defaults and the parsed defaults in agreement", () => {
    const { liveRunSafeguards, trustProxyHops } = parseRunExecutionConfig({});

    expect(liveRunSafeguards.maxOutputTokens).toBe(LIVE_RUN_DEFAULTS.maxOutputTokens);
    expect(liveRunSafeguards.maxAttemptsPerJob).toBe(LIVE_RUN_DEFAULTS.maxAttemptsPerJob);
    expect(liveRunSafeguards.maxConcurrency).toBe(LIVE_RUN_DEFAULTS.maxConcurrency);
    expect(liveRunSafeguards.rateLimitMax).toBe(LIVE_RUN_DEFAULTS.rateLimitMax);
    expect(liveRunSafeguards.rateLimitWindowMs).toBe(LIVE_RUN_DEFAULTS.rateLimitWindowMs);
    expect(liveRunSafeguards.dailyLimit).toBe(LIVE_RUN_DEFAULTS.dailyLimit);
    expect(trustProxyHops).toBe(LIVE_RUN_DEFAULTS.trustProxyHops);
  });

  it("accepts explicit in-range values", () => {
    const { liveRunSafeguards, trustProxyHops } = parseRunExecutionConfig({
      LIVE_RUN_MAX_OUTPUT_TOKENS: "2048",
      LIVE_RUN_MAX_ATTEMPTS_PER_JOB: "3",
      LIVE_RUN_MAX_CONCURRENCY: "1",
      LIVE_RUN_RATE_LIMIT_MAX: "5",
      LIVE_RUN_RATE_LIMIT_WINDOW_MS: "30000",
      LIVE_RUN_DAILY_LIMIT: "25",
      LIVE_RUN_DAILY_COST_CEILING_USD: "2.50",
      TRUST_PROXY_HOPS: "2",
    });

    expect(liveRunSafeguards).toEqual({
      maxOutputTokens: 2048,
      maxAttemptsPerJob: 3,
      maxConcurrency: 1,
      rateLimitMax: 5,
      rateLimitWindowMs: 30_000,
      dailyLimit: 25,
      dailyCostCeilingNanoUsd: 2_500_000_000n,
    });
    expect(trustProxyHops).toBe(2);
  });

  it("treats an empty value as unset rather than as zero", () => {
    const { liveRunSafeguards, trustProxyHops } = parseRunExecutionConfig({
      LIVE_RUN_MAX_CONCURRENCY: "  ",
      LIVE_RUN_DAILY_LIMIT: "",
      LIVE_RUN_DAILY_COST_CEILING_USD: "  ",
      TRUST_PROXY_HOPS: "",
    });

    expect(liveRunSafeguards.maxConcurrency).toBe(1);
    expect(liveRunSafeguards.dailyLimit).toBe(10);
    expect(liveRunSafeguards.dailyCostCeilingNanoUsd).toBe(1_000_000_000n);
    expect(trustProxyHops).toBe(1);
  });

  it("allows TRUST_PROXY_HOPS=0 for a directly exposed process", () => {
    // Zero is meaningful, not a typo: it means trust nothing and use the
    // socket's own address. It must not be swallowed by the empty-value rule.
    expect(parseRunExecutionConfig({ TRUST_PROXY_HOPS: "0" }).trustProxyHops).toBe(0);
  });
});

describe("parseRunExecutionConfig — safeguard range enforcement", () => {
  it.each([
    ["LIVE_RUN_MAX_OUTPUT_TOKENS", "255", /LIVE_RUN_MAX_OUTPUT_TOKENS must be an integer between 256 and 4096/],
    ["LIVE_RUN_MAX_OUTPUT_TOKENS", "4097", /LIVE_RUN_MAX_OUTPUT_TOKENS must be an integer/],
    ["LIVE_RUN_MAX_ATTEMPTS_PER_JOB", "0", /LIVE_RUN_MAX_ATTEMPTS_PER_JOB must be an integer between 1 and 10/],
    ["LIVE_RUN_MAX_ATTEMPTS_PER_JOB", "11", /LIVE_RUN_MAX_ATTEMPTS_PER_JOB must be an integer/],
    ["LIVE_RUN_RATE_LIMIT_MAX", "0", /LIVE_RUN_RATE_LIMIT_MAX must be an integer between 1 and 60/],
    ["LIVE_RUN_RATE_LIMIT_MAX", "61", /LIVE_RUN_RATE_LIMIT_MAX must be an integer/],
    ["LIVE_RUN_RATE_LIMIT_WINDOW_MS", "999", /LIVE_RUN_RATE_LIMIT_WINDOW_MS must be an integer/],
    ["LIVE_RUN_RATE_LIMIT_WINDOW_MS", "3600001", /LIVE_RUN_RATE_LIMIT_WINDOW_MS must be an integer/],
    ["LIVE_RUN_DAILY_LIMIT", "0", /LIVE_RUN_DAILY_LIMIT must be an integer between 1 and 1000/],
    ["LIVE_RUN_DAILY_LIMIT", "1001", /LIVE_RUN_DAILY_LIMIT must be an integer/],
    ["TRUST_PROXY_HOPS", "-1", /TRUST_PROXY_HOPS must be an integer between 0 and 5/],
    ["TRUST_PROXY_HOPS", "6", /TRUST_PROXY_HOPS must be an integer/],
  ])("rejects %s=%o", (variable, raw, pattern) => {
    expect(() => parseRunExecutionConfig({ [variable]: raw })).toThrow(pattern);
  });

  it.each([
    ["LIVE_RUN_DAILY_LIMIT", "10 runs"],
    ["LIVE_RUN_RATE_LIMIT_WINDOW_MS", "60s"],
    ["LIVE_RUN_MAX_OUTPUT_TOKENS", "1024tokens"],
    ["TRUST_PROXY_HOPS", "one"],
  ])("rejects the non-integer %s=%o rather than coercing it like parseInt", (variable, raw) => {
    // parseInt("60s") is 60 and parseInt("1024tokens") is 1024 — a typo would
    // become a valid configuration. Number() yields NaN and fails.
    expect(() => parseRunExecutionConfig({ [variable]: raw })).toThrow(ProviderConfigError);
  });

  it("names the variable and never its value in a range failure", () => {
    try {
      parseRunExecutionConfig({ LIVE_RUN_DAILY_LIMIT: "99999" });
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      expect((error as Error).message).toContain("LIVE_RUN_DAILY_LIMIT");
      expect((error as Error).message).not.toContain("99999");
    }
  });
});

describe("parseRunExecutionConfig — daily cost ceiling", () => {
  it("parses the decimal string into exact integer nanoUSD", () => {
    expect(
      parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: "1.00" }).liveRunSafeguards
        .dailyCostCeilingNanoUsd,
    ).toBe(1_000_000_000n);
    expect(
      parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: "0.25" }).liveRunSafeguards
        .dailyCostCeilingNanoUsd,
    ).toBe(250_000_000n);
  });

  it("yields a bigint, never a number, so the ceiling never participates in float arithmetic", () => {
    const { dailyCostCeilingNanoUsd } = parseRunExecutionConfig({}).liveRunSafeguards;

    expect(typeof dailyCostCeilingNanoUsd).toBe("bigint");
  });

  it.each(["0", "0.00", "0.000000000"])("rejects the zero ceiling %o", (raw) => {
    // A zero ceiling closes the cost gate permanently, which is
    // indistinguishable from a typo. The kill switch already says "no live
    // runs" unambiguously.
    expect(() => parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: raw })).toThrow(
      /must be greater than 0/,
    );
  });

  it.each(["-1.00", "1e3", "$1.00", "1,00", "abc", "1.0000000001", ".5", "1."])(
    "rejects the malformed ceiling %o",
    (raw) => {
      expect(() => parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: raw })).toThrow(
        ProviderConfigError,
      );
    },
  );

  it("rejects a ceiling above the configurable maximum", () => {
    expect(() => parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: "1000.01" })).toThrow(
      /at most 1000 USD/,
    );
    expect(
      parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: "1000" }).liveRunSafeguards
        .dailyCostCeilingNanoUsd,
    ).toBe(1_000_000_000_000n);
  });

  it("names the variable and never its value in a ceiling failure", () => {
    try {
      parseRunExecutionConfig({ LIVE_RUN_DAILY_COST_CEILING_USD: "not-a-price" });
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      expect((error as Error).message).toContain("LIVE_RUN_DAILY_COST_CEILING_USD");
      expect((error as Error).message).not.toContain("not-a-price");
    }
  });
});

/**
 * The concurrency invariant, and the safety claim that rests on it.
 *
 * The documented bound is that the daily cost ceiling — which is post-run
 * accounting on an ESTIMATE, not a hard cap on money — can be crossed by the
 * OBSERVED RECONCILED ESTIMATE by at most one IN-FLIGHT LOGICAL RUN. That is
 * only true at a concurrency of exactly 1. With N concurrent runs, all N can
 * observe an accumulated cost below the ceiling, all N reserve, and all N spend
 * before any of them reconciles, making the overrun bound N runs rather than one.
 * Actual provider billing is not bounded by that statement at all.
 *
 * So the parser refuses 2..4 outright rather than accepting them alongside a
 * claim that would then be false for three of the four values.
 */
describe("parseRunExecutionConfig — LIVE_RUN_MAX_CONCURRENCY is pinned to 1", () => {
  it("defaults to 1 when unset", () => {
    expect(parseRunExecutionConfig({}).liveRunSafeguards.maxConcurrency).toBe(1);
  });

  it("treats an empty or whitespace value as unset", () => {
    expect(
      parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: "" }).liveRunSafeguards.maxConcurrency,
    ).toBe(1);
    expect(
      parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: "   " }).liveRunSafeguards.maxConcurrency,
    ).toBe(1);
  });

  it("accepts the exact string '1'", () => {
    expect(
      parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: "1" }).liveRunSafeguards.maxConcurrency,
    ).toBe(1);
  });

  it.each(["2", "4"])("rejects %o, which would break the one-in-flight-run bound", (raw) => {
    // Previously accepted (the range was 1..4). Rejected now: the value is
    // plausible, which is exactly why silently allowing it was the hazard.
    expect(() => parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: raw })).toThrow(
      /LIVE_RUN_MAX_CONCURRENCY must be exactly '1'/,
    );
  });

  it.each(["3", "5", "10", "100"])("rejects the out-of-release value %o", (raw) => {
    expect(() => parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: raw })).toThrow(
      ProviderConfigError,
    );
  });

  it.each(["0", "-1", "1.0", "1.5", "1x", "one", " ".concat("1", "2"), "01", "+1", "true"])(
    "rejects the malformed value %o",
    (raw) => {
      expect(() => parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: raw })).toThrow(
        ProviderConfigError,
      );
    },
  );

  it("names only the variable in the failure, never the supplied value", () => {
    try {
      parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: "7" });
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain("LIVE_RUN_MAX_CONCURRENCY");
      expect(message).not.toContain("7");
    }
  });

  it("explains why the value is pinned, so the failure is actionable", () => {
    try {
      parseRunExecutionConfig({ LIVE_RUN_MAX_CONCURRENCY: "2" });
      throw new Error("expected the configuration to be rejected");
    } catch (error) {
      expect((error as Error).message).toMatch(/at most one in-flight logical run/);
    }
  });

  it("exposes the invariant as a named constant that agrees with the parsed value", () => {
    expect(REQUIRED_MAX_CONCURRENCY).toBe(1);
    expect(parseRunExecutionConfig({}).liveRunSafeguards.maxConcurrency).toBe(
      REQUIRED_MAX_CONCURRENCY,
    );
    expect(LIVE_RUN_DEFAULTS.maxConcurrency).toBe(REQUIRED_MAX_CONCURRENCY);
  });

  /**
   * The safeguard test the overrun bound actually depends on: whatever
   * configuration is ACCEPTED, concurrency is 1. This is what makes the
   * documented bound — the observed reconciled estimate crossing the ceiling by
   * at most one in-flight logical run — true for every accepted configuration
   * rather than for the default one only.
   */
  it("yields concurrency 1 for every configuration the parser accepts", () => {
    const accepted: EnvRecord[] = [
      {},
      { LIVE_RUN_MAX_CONCURRENCY: "1" },
      { LIVE_RUN_MAX_CONCURRENCY: "  " },
      capableEnv(),
      servableEnv(),
      servableEnv({ LIVE_RUN_MAX_CONCURRENCY: "1" }),
      servableEnv({ LIVE_RUN_DAILY_LIMIT: "1000", LIVE_RUN_DAILY_COST_CEILING_USD: "1000" }),
      servableEnv({ LIVE_RUN_RATE_LIMIT_MAX: "60", LIVE_RUN_MAX_OUTPUT_TOKENS: "4096" }),
    ];

    for (const env of accepted) {
      expect(parseRunExecutionConfig(env).liveRunSafeguards.maxConcurrency).toBe(1);
    }
  });
});

/**
 * The protected public LIVE path forbids opaque SDK retries.
 *
 * A retried Anthropic request reports only the last attempt: an earlier attempt
 * may have reached the provider and may have been billed, and nothing in the
 * response says whether it did. So with retries enabled no live run's cost figure
 * can be claimed as complete — the collector marks every such success
 * possibleUnobservedCost, and
 * the API then publishes no cost at all and closes the day's gate. Rather than
 * ship a path where that is normal, the configuration refuses it.
 *
 * The explicit per-job live attempt limit is the retry mechanism instead: it
 * allocates a real AgentRun row, counts against the job's cap, and reserves its
 * own budget slot — all the properties an in-SDK retry lacks.
 */
describe("parseRunExecutionConfig — protected LIVE forbids opaque SDK retries", () => {
  it("accepts retries 0 when LIVE is servable", () => {
    const config = parseRunExecutionConfig(servableEnv({ ANTHROPIC_MAX_RETRIES: "0" }));

    expect(config.liveAgentRunsEnabled).toBe(true);
    if (config.liveCapability.kind !== "present") throw new Error("expected capability");
    expect(config.liveCapability.anthropic.maxRetries).toBe(0);
  });

  it.each(["1", "2", "5"])("fails startup when LIVE is servable and retries is %s", (retries) => {
    expect(() => parseRunExecutionConfig(servableEnv({ ANTHROPIC_MAX_RETRIES: retries }))).toThrow(
      ProviderConfigError,
    );
    expect(() => parseRunExecutionConfig(servableEnv({ ANTHROPIC_MAX_RETRIES: retries }))).toThrow(
      /ANTHROPIC_MAX_RETRIES/,
    );
  });

  it("fails startup when the variable is unset, because the provider default is not 0", () => {
    // The important case, and the reason render.yaml ships an explicit "0": a
    // servable deployment that simply never mentions the variable would
    // otherwise inherit DEFAULT_MAX_RETRIES and silently produce unmeasurable
    // costs on every run.
    const env = { ...servableEnv() };
    delete (env as Record<string, string | undefined>).ANTHROPIC_MAX_RETRIES;

    expect(() => parseRunExecutionConfig(env)).toThrow(/ANTHROPIC_MAX_RETRIES/);
  });

  it("never echoes the supplied value in the error", () => {
    const sentinel = "3";
    try {
      parseRunExecutionConfig(servableEnv({ ANTHROPIC_MAX_RETRIES: sentinel }));
      throw new Error("expected a rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("ANTHROPIC_MAX_RETRIES");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(DEMO_TOKEN);
      // No digit other than the required 0 appears, so the offending value
      // cannot be read back out of the message.
      expect(message.replace(/exactly 0/, "")).not.toMatch(/\d/);
    }
  });

  describe("non-public flows keep their configurable retries", () => {
    it.each(["1", "5"])("accepts retries %s while the kill switch is off", (retries) => {
      // A worker or manually operated run: the operator is present, the spend is
      // theirs, and no public caller is exposed to the ambiguity.
      const config = parseRunExecutionConfig(capableEnv({ ANTHROPIC_MAX_RETRIES: retries }));

      expect(config.liveAgentRunsEnabled).toBe(false);
      if (config.liveCapability.kind !== "present") throw new Error("expected capability");
      expect(config.liveCapability.anthropic.maxRetries).toBe(Number(retries));
    });

    it("accepts retries 1 when there is no capability at all", () => {
      const config = parseRunExecutionConfig({
        LIVE_AGENT_RUNS_ENABLED: "true",
        ANTHROPIC_MAX_RETRIES: "1",
      });

      expect(config.liveCapability.kind).toBe("absent");
    });
  });
});

/**
 * The key and the model are ONE rollout step, not two.
 *
 * parseProviderConfig rejects a partial Anthropic configuration in both
 * directions. render.yaml previously declared only ANTHROPIC_API_KEY, so an
 * operator following "set the key" would have taken the service down on the next
 * restart — with the kill switch still off and no live capability gained. Both
 * are now declared as unset dashboard inputs (asserted in
 * render-blueprint.test.ts) and these tests pin the parser behaviour they have
 * to match.
 */
describe("parseRunExecutionConfig — Anthropic rollout inputs are a pair", () => {
  it("stays startable and FAKE-only with neither set — the shipped deployment", () => {
    const config = parseRunExecutionConfig({});

    expect(config.liveCapability.kind).toBe("absent");
    expect(config.defaultRequestMode).toBe("FAKE");
    expect(config.liveAgentRunsEnabled).toBe(false);
  });

  it("fails closed on a key with no model", () => {
    expect(() => parseRunExecutionConfig({ ANTHROPIC_API_KEY: SECRET })).toThrow(
      /ANTHROPIC_MODEL is required/,
    );
  });

  it("fails closed on a model with no key", () => {
    expect(() => parseRunExecutionConfig({ ANTHROPIC_MODEL: "claude-sonnet-5" })).toThrow(
      /ANTHROPIC_API_KEY is required/,
    );
  });

  it("starts successfully with the complete rollout environment and the switch still false", () => {
    // The intended intermediate state: key, model, token and retries all set,
    // kill switch not yet flipped. Nothing is servable, and nothing is broken.
    const config = parseRunExecutionConfig({
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: "claude-sonnet-5",
      ANTHROPIC_MAX_RETRIES: "0",
      LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
      LIVE_AGENT_RUNS_ENABLED: "false",
    });

    expect(config.liveCapability.kind).toBe("present");
    expect(config.liveAgentRunsEnabled).toBe(false);
  });

  it("requires the token AND retries 0 before the switch may be enabled", () => {
    const complete = {
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: "claude-sonnet-5",
      ANTHROPIC_MAX_RETRIES: "0",
      LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN,
      LIVE_AGENT_RUNS_ENABLED: "true",
    };

    expect(parseRunExecutionConfig(complete).liveAgentRunsEnabled).toBe(true);

    const withoutToken = { ...complete, LIVE_RUN_ACCESS_TOKEN: undefined };
    expect(() => parseRunExecutionConfig(withoutToken)).toThrow(/LIVE_RUN_ACCESS_TOKEN is required/);

    const withRetries = { ...complete, ANTHROPIC_MAX_RETRIES: "1" };
    expect(() => parseRunExecutionConfig(withRetries)).toThrow(/ANTHROPIC_MAX_RETRIES/);
  });
});

const TURNSTILE_SECRET = "turnstile-secret-do-not-use-1f14e45fceea";
const TURNSTILE_SITE_KEY = "turnstile-site-key-do-not-use";
const VISITOR_SECRET = "visitor-secret-do-not-use-9f14e45fceea";

function publicTrialEnv(overrides: EnvRecord = {}): EnvRecord {
  return capableEnv({
    LIVE_AGENT_RUNS_ENABLED: "true",
    ANTHROPIC_MAX_RETRIES: "0",
    LIVE_PUBLIC_TRIAL_ENABLED: "true",
    TURNSTILE_SECRET_KEY: TURNSTILE_SECRET,
    TURNSTILE_SITE_KEY,
    LIVE_PUBLIC_TRIAL_VISITOR_SECRET: VISITOR_SECRET,
    ...overrides,
  });
}

describe("parseRunExecutionConfig — PUBLIC LIVE trial (issue #39)", () => {
  it("defaults to disabled", () => {
    const config = parseRunExecutionConfig({});
    expect(config.livePublicTrial).toEqual({ enabled: false });
  });

  it("is the escape hatch for a tokenless, capable, enabled deployment", () => {
    // This exact combination — capable, switch on, no token — fails startup
    // WITHOUT the flag (see the "shared access token" suite above) and
    // succeeds WITH it.
    const config = parseRunExecutionConfig(publicTrialEnv());

    expect(config.liveRunAccess.kind).toBe("absent");
    expect(config.livePublicTrial.enabled).toBe(true);
  });

  it("fails closed when enabled with any of the three secrets missing", () => {
    expect(() =>
      parseRunExecutionConfig(publicTrialEnv({ TURNSTILE_SECRET_KEY: undefined })),
    ).toThrow(/TURNSTILE_SECRET_KEY is required/);
    expect(() =>
      parseRunExecutionConfig(publicTrialEnv({ TURNSTILE_SITE_KEY: undefined })),
    ).toThrow(/TURNSTILE_SITE_KEY is required/);
    expect(() =>
      parseRunExecutionConfig(publicTrialEnv({ LIVE_PUBLIC_TRIAL_VISITOR_SECRET: undefined })),
    ).toThrow(/LIVE_PUBLIC_TRIAL_VISITOR_SECRET is required/);
  });

  it("fails closed on a whitespace-only secret, same as an absent one", () => {
    expect(() =>
      parseRunExecutionConfig(publicTrialEnv({ TURNSTILE_SECRET_KEY: "   " })),
    ).toThrow(/TURNSTILE_SECRET_KEY is required/);
  });

  it("parses the fixed, non-configurable policy numbers — 5/day, $0.50 ceiling", () => {
    const config = parseRunExecutionConfig(publicTrialEnv());
    if (!config.livePublicTrial.enabled) throw new Error("expected the public trial to be enabled");

    expect(config.livePublicTrial.dailyLimit).toBe(5);
    expect(config.livePublicTrial.costCeilingNanoUsd).toBe(500_000_000n);
  });

  it("ignores an env var attempting to override the fixed policy numbers — there is none to set", () => {
    // There is deliberately no LIVE_PUBLIC_TRIAL_DAILY_LIMIT or cost-ceiling
    // env var at all; an operator cannot tune these even if they try.
    const config = parseRunExecutionConfig(
      publicTrialEnv({
        LIVE_PUBLIC_TRIAL_DAILY_LIMIT: "999",
        LIVE_PUBLIC_TRIAL_COST_CEILING_USD: "999.00",
      }),
    );
    if (!config.livePublicTrial.enabled) throw new Error("expected the public trial to be enabled");

    expect(config.livePublicTrial.dailyLimit).toBe(5);
    expect(config.livePublicTrial.costCeilingNanoUsd).toBe(500_000_000n);
  });

  it("rejects an anything-but-'true'/'false' value, matching every other strict boolean", () => {
    expect(() =>
      parseRunExecutionConfig(capableEnv({ LIVE_PUBLIC_TRIAL_ENABLED: "1" })),
    ).toThrow(/LIVE_PUBLIC_TRIAL_ENABLED must be exactly 'true' or 'false'/);
  });

  it("permits a token AND the public flag together — inert, not forbidden", () => {
    // Not a supported dual-routing mode: liveRunAccess.kind === "token-required"
    // always wins in live-run-admission.ts, so the flag has no anonymous path
    // to reach. Not unsafe, merely unused — so it is not rejected at startup.
    const config = parseRunExecutionConfig(
      publicTrialEnv({ LIVE_RUN_ACCESS_TOKEN: DEMO_TOKEN }),
    );

    expect(config.liveRunAccess.kind).toBe("token-required");
    expect(config.livePublicTrial.enabled).toBe(true);
  });

  it("never requires the three secrets when the flag is off, even with everything else present", () => {
    expect(() => parseRunExecutionConfig(servableEnv())).not.toThrow();
  });
});
