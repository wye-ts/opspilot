import Anthropic from "@anthropic-ai/sdk";
import { FakeLlmProvider, DIAGNOSTIC_TOOL_CATALOG } from "@opspilot/agent-runtime";
import type {
  DiagnosticToolCatalogEntry,
  FakeAgentScenario,
  LlmProvider,
  LlmProviderFactory,
  LlmProviderSelection,
} from "@opspilot/agent-runtime";

import type { AnthropicRuntimeConfig } from "./claude-config";
import {
  ClaudeLlmProvider,
  type AnthropicMessagesClient,
  type ClaudeProviderLogEvent,
} from "./claude-llm-provider";
import type { SupportedClaudeModel } from "./claude-model";


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
  /**
   * An already-constructed transport, used instead of building one from
   * `anthropic`.
   *
   * Added in PR 6B1 for the API, where a factory is built per run (the
   * deterministic scenario depends on the job, which is only known after the
   * run row is locked) but the client should not be. Without this, every live
   * run would construct a fresh `Anthropic` and throw away its connection
   * pool. The worker's single-run scripts pass `anthropic` alone and are
   * unaffected.
   *
   * `anthropic` is still required alongside it for a LIVE selection: the
   * config carries the retry ceiling the adapter reports, and accepting a
   * client without it would let an unconfigured factory serve LIVE.
   */
  readonly client?: AnthropicMessagesClient;
  readonly diagnosticTools?: readonly DiagnosticToolCatalogEntry[];
  readonly logger?: (event: ClaudeProviderLogEvent) => void;
  readonly now?: () => Date;
}

/**
 * Builds the Anthropic transport from validated configuration.
 *
 * Exported so a caller that constructs one factory per run — the API, whose
 * deterministic scenario depends on the job — can still build the client once,
 * at startup, and pass it back in through `LlmProviderFactoryOptions.client`.
 *
 * It lives here rather than in the caller so that `@anthropic-ai/sdk` stays an
 * implementation detail of this package: apps/api imports no vendor SDK, which
 * is what makes "the SDK is present only in the server-side provider path" a
 * structural fact rather than a convention.
 *
 * `logLevel: "off"` is not optional. The SDK's own debug logging prints
 * headers and request bodies; every log line must come from the adapter's
 * sanitized callback instead.
 */
export function createAnthropicClient(config: AnthropicRuntimeConfig): AnthropicMessagesClient {
  return new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    logLevel: "off",
  });
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

      // A caller-supplied transport wins, so a process that builds one factory
      // per run (the API — see apps/api/src/execution/api-provider-factory.ts)
      // can still share a single client and its connection pool.
      //
      // Otherwise constructed here, not at module load, so importing this
      // module never creates a network-capable object. logLevel "off" keeps
      // the SDK's own debug logging — which would print headers and bodies —
      // permanently silent; every log line comes from the adapter's sanitized
      // callback.
      const client = options.client ?? createAnthropicClient(anthropic);

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
