import { ProviderConfigError, type EnvRecord } from "@opspilot/provider-claude";
import { describe, expect, it } from "vitest";

import { parseRunExecutionConfig } from "./run-execution-config";

const SECRET = "sk-ant-test-do-not-use-0123456789";

function capableEnv(overrides: EnvRecord = {}): EnvRecord {
  return {
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    ...overrides,
  };
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
    expect(
      parseRunExecutionConfig(capableEnv({ LIVE_AGENT_RUNS_ENABLED: "true" })).liveAgentRunsEnabled,
    ).toBe(true);
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
