import Anthropic from "@anthropic-ai/sdk";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type {
  DiagnosticToolCatalogEntry,
  FakeAgentScenario,
  LlmProvider,
  LlmProviderFactory,
  LlmProviderSelection,
} from "@opspilot/agent-runtime";

import type { AnthropicRuntimeConfig } from "./claude-config";
import { ClaudeLlmProvider, type ClaudeProviderLogEvent } from "./claude-llm-provider";
import type { SupportedClaudeModel } from "./claude-model";

const { FakeLlmProvider, DIAGNOSTIC_TOOL_CATALOG } = opspilotAgentRuntime;

export interface LlmProviderFactoryOptions {
  /**
   * Supplied at factory-construction time rather than through the selection,
   * so LlmProviderSelection stays free of scenario and database types and the
   * factory interface remains reusable across the worker and (in PR 6B) the API.
   */
  readonly fakeScenario: FakeAgentScenario;
  /**
   * Required whenever a LIVE selection may be passed. Absent for a FAKE-only
   * factory — which is why LIVE without it throws rather than silently
   * degrading to the deterministic provider.
   */
  readonly anthropic?: AnthropicRuntimeConfig;
  readonly diagnosticTools?: readonly DiagnosticToolCatalogEntry[];
  readonly logger?: (event: ClaudeProviderLogEvent) => void;
  readonly now?: () => Date;
}

export class LiveProviderUnavailableError extends Error {
  constructor() {
    // Names the missing configuration, never any value from it.
    super(
      "A LIVE provider selection requires validated Anthropic configuration; none was supplied to the factory.",
    );
    this.name = "LiveProviderUnavailableError";
  }
}

/**
 * Builds the provider for a given selection.
 *
 * There is deliberately no fallback: a LIVE selection that cannot be satisfied
 * throws. Quietly returning the deterministic provider instead would produce a
 * run that looks successful while proving nothing about the live path — the
 * single most misleading failure mode this milestone could ship.
 */
export function createLlmProviderFactory(
  options: LlmProviderFactoryOptions,
): LlmProviderFactory<SupportedClaudeModel> {
  const diagnosticTools = options.diagnosticTools ?? DIAGNOSTIC_TOOL_CATALOG;

  return {
    createProvider(selection: LlmProviderSelection<SupportedClaudeModel>): LlmProvider {
      if (selection.providerMode === "FAKE") {
        return new FakeLlmProvider(options.fakeScenario);
      }

      const anthropic = options.anthropic;
      if (!anthropic) {
        throw new LiveProviderUnavailableError();
      }

      // Constructed here, not at module load, so importing this module never
      // creates a network-capable object. logLevel "off" keeps the SDK's own
      // debug logging — which would print headers and bodies — permanently
      // silent; every log line comes from the adapter's sanitized callback.
      const client = new Anthropic({
        apiKey: anthropic.apiKey,
        timeout: anthropic.timeoutMs,
        maxRetries: anthropic.maxRetries,
        logLevel: "off",
      });

      return new ClaudeLlmProvider({
        client,
        // The selection is the only source of truth for the live model after
        // configuration parsing; nothing here re-reads ANTHROPIC_MODEL.
        model: selection.modelIdentifier,
        diagnosticTools: diagnosticTools.map((entry) => ({
          tool: entry.tool,
          description: entry.description,
        })),
        configuredMaxRetries: anthropic.maxRetries,
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
    },
  };
}
