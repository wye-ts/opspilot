import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ProviderConfigError,
  parseWorkerProviderConfig,
  type EnvRecord,
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

describe("parseWorkerProviderConfig — mode selection", () => {
  it("defaults to FAKE when the mode is unset", () => {
    const config = parseWorkerProviderConfig({});

    expect(config.selection.providerMode).toBe("FAKE");
    expect(config.anthropic).toBeNull();
  });

  it("defaults to FAKE when the mode is an empty string", () => {
    expect(parseWorkerProviderConfig({ AGENT_RUN_PROVIDER_MODE: "  " }).selection.providerMode).toBe(
      "FAKE",
    );
  });

  it("ignores Anthropic settings entirely in FAKE mode", () => {
    const config = parseWorkerProviderConfig({
      AGENT_RUN_PROVIDER_MODE: "FAKE",
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: "claude-sonnet-5",
    });

    expect(config.anthropic).toBeNull();
    expect(config.selection.modelIdentifier ?? null).toBeNull();
  });

  it("accepts a valid LIVE configuration", () => {
    const config = parseWorkerProviderConfig(liveEnv());

    expect(config.selection).toEqual({
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
    });
    expect(config.anthropic?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.anthropic?.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it.each(["LIVE ", " live", "Live", "CLAUDE", "ANTHROPIC", "true"])(
    "rejects the unsupported mode %o instead of guessing",
    (mode) => {
      expect(() => parseWorkerProviderConfig({ AGENT_RUN_PROVIDER_MODE: mode })).toThrow(
        ProviderConfigError,
      );
    },
  );

  it("does not accept CLAUDE as an execution mode", () => {
    // The execution mode stays provider-neutral; the vendor is expressed
    // through model metadata, not through this enum.
    expect(() => parseWorkerProviderConfig({ AGENT_RUN_PROVIDER_MODE: "CLAUDE" })).toThrow(
      /must be exactly 'FAKE' or 'LIVE'/,
    );
  });
});

describe("parseWorkerProviderConfig — LIVE requirements", () => {
  it("rejects LIVE without an API key", () => {
    const env = { AGENT_RUN_PROVIDER_MODE: "LIVE", ANTHROPIC_MODEL: "claude-sonnet-5" };

    expect(() => parseWorkerProviderConfig(env)).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("rejects LIVE with a blank API key", () => {
    expect(() => parseWorkerProviderConfig(liveEnv({ ANTHROPIC_API_KEY: "   " }))).toThrow(
      /ANTHROPIC_API_KEY is required/,
    );
  });

  it("rejects LIVE without a model", () => {
    const env = { AGENT_RUN_PROVIDER_MODE: "LIVE", ANTHROPIC_API_KEY: SECRET };

    expect(() => parseWorkerProviderConfig(env)).toThrow(/ANTHROPIC_MODEL is required/);
  });

  it.each([
    "claude-opus-5",
    "claude-haiku-4-5",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5-20260101",
    "sonnet-5",
  ])("rejects the unsupported model %o at configuration time", (model) => {
    expect(() => parseWorkerProviderConfig(liveEnv({ ANTHROPIC_MODEL: model }))).toThrow(
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
      expect(() => parseWorkerProviderConfig(env)).toThrow(ProviderConfigError);
    }
  });
});

describe("parseWorkerProviderConfig — bounded numeric settings", () => {
  it("uses explicit valid values", () => {
    const config = parseWorkerProviderConfig(
      liveEnv({ ANTHROPIC_TIMEOUT_MS: "30000", ANTHROPIC_MAX_RETRIES: "0" }),
    );

    expect(config.anthropic?.timeoutMs).toBe(30_000);
    expect(config.anthropic?.maxRetries).toBe(0);
  });

  it.each(["0", "-1", "1.5", "45s", "abc", "999999999"])(
    "rejects the invalid timeout %o",
    (raw) => {
      expect(() => parseWorkerProviderConfig(liveEnv({ ANTHROPIC_TIMEOUT_MS: raw }))).toThrow(
        /ANTHROPIC_TIMEOUT_MS must be an integer/,
      );
    },
  );

  it.each(["-1", "6", "2.5", "two"])("rejects the invalid retry count %o", (raw) => {
    expect(() => parseWorkerProviderConfig(liveEnv({ ANTHROPIC_MAX_RETRIES: raw }))).toThrow(
      /ANTHROPIC_MAX_RETRIES must be an integer/,
    );
  });

  it("does not silently truncate a trailing-unit typo", () => {
    // parseInt("45s") would yield 45; Number("45s") is NaN, which is rejected.
    expect(() => parseWorkerProviderConfig(liveEnv({ ANTHROPIC_TIMEOUT_MS: "45s" }))).toThrow(
      ProviderConfigError,
    );
  });
});

describe("parseWorkerProviderConfig — secret hygiene", () => {
  it("keeps the key readable by the adapter that needs it", () => {
    const config = parseWorkerProviderConfig(liveEnv());

    expect(config.anthropic?.apiKey).toBe(SECRET);
  });

  it("omits the key from JSON serialization", () => {
    const config = parseWorkerProviderConfig(liveEnv());

    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted]");
  });

  it("omits the key from inspection output", () => {
    const config = parseWorkerProviderConfig(liveEnv());

    expect(inspect(config, { depth: null })).not.toContain(SECRET);
    expect(inspect(config.anthropic)).not.toContain(SECRET);
  });

  it("omits the key from enumeration and spreads", () => {
    const config = parseWorkerProviderConfig(liveEnv());
    const anthropic = config.anthropic;
    if (anthropic === null) throw new Error("expected a LIVE config");

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
        parseWorkerProviderConfig(env);
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
