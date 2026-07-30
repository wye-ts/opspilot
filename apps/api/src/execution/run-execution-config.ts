import {
  parseProviderConfig,
  ProviderConfigError,
  type EnvRecord,
  type LiveCapability,
  type AgentRunProviderMode,
} from "@opspilot/provider-claude";

import { DEFAULT_PROVIDER_DEADLINE_MS } from "./run-abort-context";

/**
 * Everything the run path needs to decide *how* a request executes, resolved
 * once at startup from the environment.
 *
 * The four concepts are kept separate deliberately, because they answer
 * different questions and a deployment can be in any combination of them:
 *
 *   defaultRequestMode  what a request that omits `providerMode` gets
 *   requested run mode  what THIS request asked for (per request; not here)
 *   liveCapability      whether this process CAN execute a live run at all
 *   liveAgentRunsEnabled whether it MAY start new live runs right now
 *
 * A server can be capable but switched off, or switched on but incapable, and
 * each produces a different, specific rejection. Collapsing any two of them
 * would make one of those rejections unrepresentable.
 */
export interface RunExecutionConfig {
  readonly defaultRequestMode: AgentRunProviderMode;
  readonly liveCapability: LiveCapability;
  /**
   * The live kill switch. Defaults to FALSE — a capable, correctly configured
   * deployment still refuses live runs until someone deliberately turns them
   * on. Adding a credential is therefore not sufficient to start spending
   * money; that takes a second, separate action.
   */
  readonly liveAgentRunsEnabled: boolean;
  readonly providerDeadlineMs: number;
}

const MIN_PROVIDER_DEADLINE_MS = 5_000;
const MAX_PROVIDER_DEADLINE_MS = 600_000;

/**
 * Only the exact lowercase strings are accepted. "True", "TRUE", "1", and
 * "yes" all fail startup rather than being guessed at, because guessing wrong
 * on this particular variable means either a dead feature or unintended spend
 * — and a typo that silently means `false` is indistinguishable from a
 * deliberate `false` until someone notices the demo does not work.
 *
 * Mirrors docker/entrypoint.sh's handling of RUN_MIGRATIONS_ON_START, which
 * takes the same position for the same reason.
 */
function parseStrictBoolean(raw: string | undefined, fallback: boolean, variableName: string): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;

  throw new ProviderConfigError(`${variableName} must be exactly 'true' or 'false'.`);
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  variableName: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  // Number(), not parseInt(): parseInt("120s") yields 120, quietly accepting a
  // typo as a valid configuration.
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProviderConfigError(`${variableName} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

/**
 * Parses a plain environment record — never `process.env` directly — so the
 * whole surface is unit-testable without mutating ambient state.
 *
 * Every failure throws. A throw here happens during Nest's dependency-injection
 * phase, which (because main.ts passes `abortOnError: false`) surfaces as a
 * rejected bootstrap promise: the process logs a fixed startup-failure message
 * and exits without ever binding a port. There is no configuration this
 * function accepts by degrading it to something weaker.
 */
export function parseRunExecutionConfig(env: EnvRecord): RunExecutionConfig {
  const providerConfig = parseProviderConfig(env);

  return {
    defaultRequestMode: providerConfig.defaultRequestMode,
    liveCapability: providerConfig.liveCapability,
    liveAgentRunsEnabled: parseStrictBoolean(
      env.LIVE_AGENT_RUNS_ENABLED,
      false,
      "LIVE_AGENT_RUNS_ENABLED",
    ),
    providerDeadlineMs: parseBoundedInteger(
      env.AGENT_RUN_PROVIDER_DEADLINE_MS,
      DEFAULT_PROVIDER_DEADLINE_MS,
      MIN_PROVIDER_DEADLINE_MS,
      MAX_PROVIDER_DEADLINE_MS,
      "AGENT_RUN_PROVIDER_DEADLINE_MS",
    ),
  };
}
