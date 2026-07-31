import type { LlmProvider, LlmProviderSelection } from "@opspilot/agent-runtime";
import type { AgentJobRecord } from "@opspilot/database";
import {
  createAnthropicClient,
  createLlmProviderFactory,
  SUPPORTED_CLAUDE_MODEL,
  type AgentRunProviderMode,
  type AnthropicMessagesClient,
  type ClaudeProviderLogEvent,
  type LiveCapability,
  type RunProviderUsageCollector,
  type SupportedClaudeModel,
} from "@opspilot/provider-claude";

import { createDeterministicScenario } from "./deterministic-scenario";

/**
 * The one place a database row meets a provider selection.
 *
 * `LlmProviderSelection` is deliberately free of @opspilot/database types — it
 * only ever needs to know *which provider to build*, never which ticket is
 * being investigated — so the conversion has to happen at a boundary that
 * knows both. This is that boundary, and it is in apps/api rather than in the
 * provider package for the same reason.
 */
export interface AgentProviderFactory {
  /**
   * `collector` is supplied only for a LIVE run, by AgentRunService, which owns
   * its lifecycle. When present it is attached as a SECOND consumer of the
   * adapter's existing per-turn logger — the structured log line still goes out
   * exactly as before, and the collector simply also sees each event. That is why
   * usage accounting needed no new instrumentation in the adapter.
   */
  createProvider(
    job: AgentJobRecord,
    requestedMode: AgentRunProviderMode,
    collector?: RunProviderUsageCollector,
  ): LlmProvider;
}

export interface AgentProviderFactoryOptions {
  readonly liveCapability: LiveCapability;
  /**
   * Injectable purely for tests, which pass a fake with zero live calls. When
   * omitted, a real client is constructed from the live capability — once, at
   * startup, not per run.
   */
  readonly client?: AnthropicMessagesClient;
  readonly logger?: (event: ClaudeProviderLogEvent) => void;
}

/**
 * Builds the single Anthropic client this process uses, or nothing at all.
 *
 * Constructed here rather than inside the per-run factory so that a live
 * deployment creates one client and reuses its connection pool across runs,
 * instead of paying for a new one on every request. Constructed lazily with
 * respect to *capability*, though: when no capability is configured, no
 * network-capable object is ever created, and importing this module never
 * creates one either.
 *
 * The SDK itself is never imported here. `createAnthropicClient` lives in
 * @opspilot/provider-claude, which keeps "@anthropic-ai/sdk appears only in the
 * server-side provider path" a structural property of the dependency graph
 * rather than a convention this file could quietly break.
 */
export function createAnthropicClientFor(
  capability: LiveCapability,
): AnthropicMessagesClient | undefined {
  if (capability.kind !== "present") {
    return undefined;
  }

  return createAnthropicClient(capability.anthropic);
}

export function createAgentProviderFactory(
  options: AgentProviderFactoryOptions,
): AgentProviderFactory {
  const { liveCapability } = options;
  const client = options.client ?? createAnthropicClientFor(liveCapability);

  return {
    createProvider(
      job: AgentJobRecord,
      requestedMode: AgentRunProviderMode,
      collector?: RunProviderUsageCollector,
    ): LlmProvider {
      const selection: LlmProviderSelection<SupportedClaudeModel> =
        requestedMode === "LIVE"
          ? { providerMode: "LIVE", modelIdentifier: SUPPORTED_CLAUDE_MODEL }
          : { providerMode: "FAKE" };

      // Fan out to both consumers when a collector is present. The collector runs
      // FIRST so a throw from the log sink — which writes to stdout and can fail
      // on a closed pipe — cannot cost the run its usage accounting.
      const logger =
        collector === undefined
          ? options.logger
          : (event: ClaudeProviderLogEvent) => {
              collector.record(event);
              options.logger?.(event);
            };

      // The factory's LIVE branch throws when no Anthropic configuration was
      // supplied, rather than quietly returning the deterministic provider.
      // Reaching that throw would be a defect — the controller refuses a LIVE
      // request long before here when capability is absent — but the
      // fail-closed behaviour is what makes it a defect rather than a silent
      // downgrade that produces a plausible-looking run proving nothing.
      return createLlmProviderFactory({
        fakeScenario: createDeterministicScenario(job),
        ...(liveCapability.kind === "present" ? { anthropic: liveCapability.anthropic } : {}),
        ...(client !== undefined ? { client } : {}),
        ...(logger !== undefined ? { logger } : {}),
      }).createProvider(selection);
    },
  };
}
