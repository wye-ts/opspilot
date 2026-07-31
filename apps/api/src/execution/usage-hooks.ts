import type { AgentRunUsageHooks } from "@opspilot/agent-runtime";
import {
  createRunProviderUsageCollector,
  type RunProviderUsageCollector,
} from "@opspilot/provider-claude";

/**
 * How AgentRunService obtains a per-run usage collector.
 *
 * This is the seam that keeps the layering honest: the runtime declares the
 * narrow snapshot-only view it needs (AgentRunUsageCollector) and knows nothing
 * about Anthropic, while apps/api — which already depends on both — supplies the
 * Claude-specific implementation. The concrete collector satisfies the neutral
 * interface structurally, so no cast is involved.
 *
 * The type parameter is what lets the controller's `createProvider` callback see
 * the concrete collector (with its `record`) rather than the narrow view.
 */
export type ApiUsageHooks = AgentRunUsageHooks<RunProviderUsageCollector>;

/**
 * A FACTORY per run, never a shared instance: each run needs its own
 * accumulator, and a shared collector would silently merge two runs' tokens and
 * costs into one figure — which would then be persisted against both.
 */
export function createApiUsageHooks(): ApiUsageHooks {
  return { createCollector: () => createRunProviderUsageCollector() };
}
