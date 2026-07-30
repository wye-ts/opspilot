import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ProviderConfigError,
  parseProviderConfig,
  type EnvRecord,
  type LiveProviderConfig,
  type ProviderConfig,
} from "./claude-config";

const SECRET = "sk-ant-test-do-not-use-0123456789";

function liveEnv(overrides: EnvRecord = {}): EnvRecord {
  return {
    AGENT_RUN_PROVIDER_MODE: "LIVE",
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_MODEL: "claude-sonnet-5",
    ...overrides,
  };
}

/** Narrows to the present arm, failing the test rather than the type system. */
function capabilityOf(config: ProviderConfig): LiveProviderConfig {
  if (config.liveCapability.kind !== "present") {
    throw new Error("expected live capability to be present");
  }
  return config.liveCapability;
}

describe("parseProviderConfig — default request mode", () => {
  it("defaults to FAKE when the mode is unset", () => {
    const config = parseProviderConfig({});

    expect(config.defaultRequestMode).toBe("FAKE");
    expect(config.liveCapability.kind).toBe("absent");
  });

  it("defaults to FAKE when the mode is an empty string", () => {
    expect(parseProviderConfig({ AGENT_RUN_PROVIDER_MODE: "  " }).defaultRequestMode).toBe("FAKE");
  });

  it("resolves capability independently of the default request mode", () => {
    // The central property of the PR 6B1 restructure. A FAKE default with a
    // valid Anthropic configuration is a normal, useful deployment: requests
    // that omit `providerMode` run deterministically, and a request that asks
    // for LIVE can still be served. The previous shape could not express this
    // — it read the Anthropic settings only when the mode was LIVE.
    const config = parseProviderConfig({
      AGENT_RUN_PROVIDER_MODE: "FAKE",
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: "claude-sonnet-5",
    });

    expect(config.defaultRequestMode).toBe("FAKE");
    expect(capabilityOf(config).selection.modelIdentifier).toBe("claude-sonnet-5");
  });

  it("accepts a valid LIVE default with capability present", () => {
    const config = parseProviderConfig(liveEnv());

    expect(config.defaultRequestMode).toBe("LIVE");
    expect(capabilityOf(config).selection).toEqual({
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
    });
    expect(capabilityOf(config).anthropic.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(capabilityOf(config).anthropic.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it("rejects a LIVE default the process could not actually serve", () => {
    // Every request omitting `providerMode` would fail at runtime. Refusing to
    // start beats serving a guaranteed error.
    expect(() => parseProviderConfig({ AGENT_RUN_PROVIDER_MODE: "LIVE" })).toThrow(
      /AGENT_RUN_PROVIDER_MODE=LIVE requires/,
    );
  });

  it.each(["LIVE ", " live", "Live", "CLAUDE", "ANTHROPIC", "true"])(
    "rejects the unsupported mode %o instead of guessing",
    (mode) => {
      expect(() => parseProviderConfig({ AGENT_RUN_PROVIDER_MODE: mode })).toThrow(
        ProviderConfigError,
      );
    },
  );

  it("does not accept CLAUDE as an execution mode", () => {
    // The execution mode stays provider-neutral; the vendor is expressed
    // through model metadata, not through this enum.
    expect(() => parseProviderConfig({ AGENT_RUN_PROVIDER_MODE: "CLAUDE" })).toThrow(
      /must be exactly 'FAKE' or 'LIVE'/,
    );
  });
});

describe("parseProviderConfig — live capability requirements", () => {
  it("rejects a model without an API key", () => {
    const env = { ANTHROPIC_MODEL: "claude-sonnet-5" };

    expect(() => parseProviderConfig(env)).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("rejects a blank API key", () => {
    expect(() => parseProviderConfig(liveEnv({ ANTHROPIC_API_KEY: "   " }))).toThrow(
      /ANTHROPIC_API_KEY is required/,
    );
  });

  it("rejects an API key without a model", () => {
    const env = { ANTHROPIC_API_KEY: SECRET };

    expect(() => parseProviderConfig(env)).toThrow(/ANTHROPIC_MODEL is required/);
  });

  it.each([
    "claude-opus-5",
    "claude-haiku-4-5",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5-20260101",
    "sonnet-5",
  ])("rejects the unsupported model %o at configuration time", (model) => {
    expect(() => parseProviderConfig(liveEnv({ ANTHROPIC_MODEL: model }))).toThrow(
      /must be 'claude-sonnet-5'/,
    );
  });

  it("fails closed rather than degrading an invalid LIVE config to FAKE", () => {
    // A silent downgrade would be the worst outcome: the run would look
    // successful while proving nothing about the live path.
    for (const env of [
      { AGENT_RUN_PROVIDER_MODE: "LIVE" },
      { AGENT_RUN_PROVIDER_MODE: "LIVE", ANTHROPIC_API_KEY: SECRET },
      liveEnv({ ANTHROPIC_MODEL: "claude-opus-5" }),
      liveEnv({ ANTHROPIC_TIMEOUT_MS: "0" }),
    ]) {
      expect(() => parseProviderConfig(env)).toThrow(ProviderConfigError);
    }
  });
});

describe("parseProviderConfig — bounded numeric settings", () => {
  it("uses explicit valid values", () => {
    const config = parseProviderConfig(
      liveEnv({ ANTHROPIC_TIMEOUT_MS: "30000", ANTHROPIC_MAX_RETRIES: "0" }),
    );

    expect(capabilityOf(config).anthropic.timeoutMs).toBe(30_000);
    expect(capabilityOf(config).anthropic.maxRetries).toBe(0);
  });

  it.each(["0", "-1", "1.5", "45s", "abc", "999999999"])(
    "rejects the invalid timeout %o",
    (raw) => {
      expect(() => parseProviderConfig(liveEnv({ ANTHROPIC_TIMEOUT_MS: raw }))).toThrow(
        /ANTHROPIC_TIMEOUT_MS must be an integer/,
      );
    },
  );

  it.each(["-1", "6", "2.5", "two"])("rejects the invalid retry count %o", (raw) => {
    expect(() => parseProviderConfig(liveEnv({ ANTHROPIC_MAX_RETRIES: raw }))).toThrow(
      /ANTHROPIC_MAX_RETRIES must be an integer/,
    );
  });

  it("does not silently truncate a trailing-unit typo", () => {
    // parseInt("45s") would yield 45; Number("45s") is NaN, which is rejected.
    expect(() => parseProviderConfig(liveEnv({ ANTHROPIC_TIMEOUT_MS: "45s" }))).toThrow(
      ProviderConfigError,
    );
  });
});

describe("parseProviderConfig — secret hygiene", () => {
  it("keeps the key readable by the adapter that needs it", () => {
    const config = parseProviderConfig(liveEnv());

    expect(capabilityOf(config).anthropic.apiKey).toBe(SECRET);
  });

  it("omits the key from JSON serialization", () => {
    const config = parseProviderConfig(liveEnv());

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted]");
  });

  it("omits the key from inspection output", () => {
    const config = parseProviderConfig(liveEnv());

    expect(inspect(config, { depth: null })).not.toContain(SECRET);
    expect(inspect(capabilityOf(config).anthropic)).not.toContain(SECRET);
  });

  it("omits the key from enumeration and spreads", () => {
    const config = parseProviderConfig(liveEnv());
    const anthropic = capabilityOf(config).anthropic;

    expect(Object.keys(anthropic)).not.toContain("apiKey");
    expect(JSON.stringify({ ...anthropic })).not.toContain(SECRET);
  });

  it("never puts a secret value in a validation error", () => {
    const cases: readonly EnvRecord[] = [
      liveEnv({ ANTHROPIC_MODEL: "claude-opus-5" }),
      liveEnv({ ANTHROPIC_TIMEOUT_MS: "nope" }),
      liveEnv({ ANTHROPIC_MAX_RETRIES: "99" }),
      { AGENT_RUN_PROVIDER_MODE: "NONSENSE", ANTHROPIC_API_KEY: SECRET },
    ];

    for (const env of cases) {
      try {
        parseProviderConfig(env);
        throw new Error("expected the configuration to be rejected");
      } catch (error) {
        const thrown = error as Error;
        expect(thrown).toBeInstanceOf(ProviderConfigError);
        expect(thrown.message).not.toContain(SECRET);
        expect(thrown.stack ?? "").not.toContain(SECRET);
      }
    }
  });
});
