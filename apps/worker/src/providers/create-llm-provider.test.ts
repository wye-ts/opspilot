import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { FakeAgentScenario, LlmProviderSelection } from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";

import { ClaudeLlmProvider } from "./claude-llm-provider";
import { parseWorkerProviderConfig } from "./claude-config";
import { LiveProviderUnavailableError, createLlmProviderFactory } from "./create-llm-provider";

const { FakeLlmProvider } = opspilotAgentRuntime;

const SECRET = "sk-ant-test-do-not-use-0123456789";

const SCENARIO: FakeAgentScenario = {
  id: "factory-test",
  turns: [
    {
      kind: "report_submission",
      usage: { inputTokens: 1, outputTokens: 1 },
      rawInput: {},
    },
  ],
};

const LIVE_CONFIG = { apiKey: SECRET, timeoutMs: 45_000, maxRetries: 1 };

describe("createLlmProviderFactory", () => {
  it("builds the deterministic provider for a FAKE selection", () => {
    const factory = createLlmProviderFactory({ fakeScenario: SCENARIO });

    const provider = factory.createProvider({ providerMode: "FAKE" });

    expect(provider).toBeInstanceOf(FakeLlmProvider);
  });

  it("builds the Claude provider for a LIVE selection", () => {
    const factory = createLlmProviderFactory({
      fakeScenario: SCENARIO,
      anthropic: LIVE_CONFIG,
    });

    const provider = factory.createProvider({
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
    });

    expect(provider).toBeInstanceOf(ClaudeLlmProvider);
  });

  it("throws rather than falling back to FAKE when LIVE config is absent", () => {
    // A silent downgrade here would produce a run that looks successful while
    // proving nothing about the live path.
    const factory = createLlmProviderFactory({ fakeScenario: SCENARIO });

    expect(() =>
      factory.createProvider({ providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" }),
    ).toThrow(LiveProviderUnavailableError);
  });

  it("never leaks the API key through the thrown error", () => {
    const factory = createLlmProviderFactory({ fakeScenario: SCENARIO });

    try {
      factory.createProvider({ providerMode: "LIVE", modelIdentifier: "claude-sonnet-5" });
      throw new Error("expected the factory to reject the selection");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("takes the live model only from the selection", () => {
    // There is no second model input on the factory: the parsed selection is
    // the single source of truth after configuration.
    const options = { fakeScenario: SCENARIO, anthropic: LIVE_CONFIG };

    expect(Object.keys(options)).not.toContain("model");
    expect(Object.keys(options)).not.toContain("modelIdentifier");
  });

  it("accepts a selection produced by the config parser end to end", () => {
    const config = parseWorkerProviderConfig({
      AGENT_RUN_PROVIDER_MODE: "LIVE",
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_MODEL: "claude-sonnet-5",
    });
    if (config.anthropic === null) throw new Error("expected a LIVE config");

    const factory = createLlmProviderFactory({
      fakeScenario: SCENARIO,
      anthropic: config.anthropic,
    });

    expect(factory.createProvider(config.selection)).toBeInstanceOf(ClaudeLlmProvider);
  });

  it("requires no database record to select a provider", () => {
    // The selection type carries two fields and nothing from @opspilot/database;
    // this is what lets the adapter move to its own package in PR 6B.
    const live: LlmProviderSelection = {
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
    };
    const fake: LlmProviderSelection = { providerMode: "FAKE" };

    expect(Object.keys(live).sort()).toEqual(["modelIdentifier", "providerMode"]);
    expect(Object.keys(fake)).toEqual(["providerMode"]);
  });
});
