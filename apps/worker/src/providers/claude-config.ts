import { inspect } from "node:util";

import type { LlmProviderSelection } from "@opspilot/agent-runtime";

import {
  SUPPORTED_CLAUDE_MODEL,
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE,
  isSupportedClaudeModel,
  type SupportedClaudeModel,
} from "./claude-model";

// Defaults chosen for an interactive demo, not for a batch job. The SDK's own
// timeout default is 10 minutes, which would leave a wedged run hanging long
// past the point a human would have given up; and its retry default of 2 is
// more attempts than a two-turn demo loop needs. Both are therefore set
// explicitly on every client rather than inherited (see claude-llm-provider.ts).
export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_RETRIES = 1;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES_CEILING = 5;

export interface AnthropicRuntimeConfig {
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * A discriminated union, so an invalid pairing cannot be represented: a LIVE
 * config always carries Anthropic settings, and a FAKE config never does.
 * There is deliberately no `anthropic?: ... | undefined` shape that a caller
 * could dereference optimistically.
 */
export type WorkerProviderConfig =
  | {
      readonly selection: { readonly providerMode: "FAKE"; readonly modelIdentifier?: null };
      readonly anthropic: null;
    }
  | {
      readonly selection: {
        readonly providerMode: "LIVE";
        readonly modelIdentifier: SupportedClaudeModel;
      };
      readonly anthropic: AnthropicRuntimeConfig;
    };

/**
 * The LIVE arm, narrowed. Callers that have already established a live
 * configuration pass this around **instead of copying fields out of it** — in
 * particular instead of copying `apiKey` into a plain property, which would
 * undo the non-enumerable/redacted protections built in createAnthropicConfig
 * below and re-expose the key through `JSON.stringify`, `util.inspect`, and
 * object spread.
 */
export type LiveWorkerProviderConfig = Extract<
  WorkerProviderConfig,
  { selection: { providerMode: "LIVE" } }
>;

/**
 * Every message is a fixed string that names the offending *variable* and
 * never interpolates its *value*. That rule is what keeps an API key out of
 * a stack trace, a CI log, or a bug report — validation failures are the most
 * likely place a secret would otherwise leak.
 */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export type EnvRecord = Readonly<Record<string, string | undefined>>;

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

  // Number() rather than parseInt(): parseInt("45s") silently yields 45,
  // which would accept a typo as a valid configuration.
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProviderConfigError(
      `${variableName} must be an integer between ${min} and ${max}.`,
    );
  }

  return value;
}

/**
 * Builds the Anthropic settings with the API key held in a non-enumerable
 * property and both serialization hooks overridden.
 *
 * The key is still readable as `config.apiKey` by the adapter that needs it,
 * but it cannot escape by accident: it is absent from `Object.keys`, from
 * spreads, from `JSON.stringify`, and from `console.log`/`util.inspect`. Those
 * are the four ways a credential realistically ends up in a log line.
 */
function createAnthropicConfig(
  apiKey: string,
  timeoutMs: number,
  maxRetries: number,
): AnthropicRuntimeConfig {
  const redacted = { apiKey: "[redacted]", timeoutMs, maxRetries };
  const config = { timeoutMs, maxRetries };

  Object.defineProperties(config, {
    apiKey: { value: apiKey, enumerable: false, writable: false },
    toJSON: { value: () => redacted, enumerable: false, writable: false },
    [inspect.custom]: { value: () => redacted, enumerable: false, writable: false },
  });

  return Object.freeze(config) as AnthropicRuntimeConfig;
}

/**
 * Parses a plain environment record — never `process.env` directly — so the
 * whole surface is unit-testable without mutating ambient state.
 *
 * There is no fallback path: a LIVE mode with missing or invalid Anthropic
 * settings throws. Degrading to FAKE would be the worst possible failure mode,
 * because the run would appear to succeed while silently proving nothing.
 */
export function parseWorkerProviderConfig(env: EnvRecord): WorkerProviderConfig {
  const rawMode = env.AGENT_RUN_PROVIDER_MODE?.trim();
  const mode = rawMode === undefined || rawMode === "" ? "FAKE" : rawMode;

  if (mode !== "FAKE" && mode !== "LIVE") {
    throw new ProviderConfigError(
      "AGENT_RUN_PROVIDER_MODE must be exactly 'FAKE' or 'LIVE'.",
    );
  }

  if (mode === "FAKE") {
    return { selection: { providerMode: "FAKE" }, anthropic: null };
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ProviderConfigError(
      "ANTHROPIC_API_KEY is required when AGENT_RUN_PROVIDER_MODE=LIVE.",
    );
  }

  const model = env.ANTHROPIC_MODEL?.trim();
  if (model === undefined || model === "") {
    throw new ProviderConfigError(
      "ANTHROPIC_MODEL is required when AGENT_RUN_PROVIDER_MODE=LIVE.",
    );
  }

  // A one-member allowlist, checked here rather than at request time. The
  // current request policy (thinking disabled alongside a forced tool_choice,
  // and a conversation shape that carries no thinking blocks) is validated for
  // this model only; other Claude models need a capability-aware request policy
  // and their own tests before they can be claimed as supported.
  if (!isSupportedClaudeModel(model)) {
    throw new ProviderConfigError(UNSUPPORTED_CLAUDE_MODEL_MESSAGE);
  }

  const timeoutMs = parseBoundedInteger(
    env.ANTHROPIC_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "ANTHROPIC_TIMEOUT_MS",
  );

  const maxRetries = parseBoundedInteger(
    env.ANTHROPIC_MAX_RETRIES,
    DEFAULT_MAX_RETRIES,
    0,
    MAX_RETRIES_CEILING,
    "ANTHROPIC_MAX_RETRIES",
  );

  return {
    selection: { providerMode: "LIVE", modelIdentifier: SUPPORTED_CLAUDE_MODEL },
    anthropic: createAnthropicConfig(apiKey, timeoutMs, maxRetries),
  };
}

/**
 * The selection is the single source of truth for the live model after
 * parsing. Nothing downstream re-reads ANTHROPIC_MODEL.
 */
export function selectionOf(
  config: WorkerProviderConfig,
): LlmProviderSelection<SupportedClaudeModel> {
  return config.selection;
}
