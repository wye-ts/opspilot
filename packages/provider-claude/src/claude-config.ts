import { inspect } from "node:util";

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
 * Which provider a run executes against. Structurally identical to
 * @opspilot/database's ProviderMode and to the persisted `provider_mode`
 * column, but declared locally: this package must not depend on the database
 * package (module-boundary.test.ts enforces that), and a two-member string
 * union is not worth a dependency.
 */
export type AgentRunProviderMode = "FAKE" | "LIVE";

/**
 * Whether this process *can* execute a live run at all.
 *
 * Deliberately independent of which mode any given request asks for. Those are
 * four different questions, and collapsing them is what made the previous
 * shape unable to express the API's actual requirements:
 *
 *   default request mode  — AGENT_RUN_PROVIDER_MODE, what an absent
 *                           `providerMode` in the request body means
 *   requested run mode    — what THIS run asked for (per request, not here)
 *   live capability       — this type: is a usable Anthropic config present
 *   live kill switch      — whether new live runs are permitted right now
 *                           (owned by the API, not by this package)
 *
 * A server can be capable but switched off, or switched on but incapable.
 * Still a discriminated union, so an invalid pairing remains unrepresentable:
 * a present capability always carries Anthropic settings, an absent one never
 * does, and there is no optional `anthropic?` a caller could dereference
 * optimistically.
 */
export type LiveCapability =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly selection: {
        readonly providerMode: "LIVE";
        readonly modelIdentifier: SupportedClaudeModel;
      };
      readonly anthropic: AnthropicRuntimeConfig;
    };

/**
 * The present arm, narrowed. Callers that have already established a live
 * capability pass this around **instead of copying fields out of it** — in
 * particular instead of copying `apiKey` into a plain property, which would
 * undo the non-enumerable/redacted protections built in createAnthropicConfig
 * below and re-expose the key through `JSON.stringify`, `util.inspect`, and
 * object spread.
 */
export type LiveProviderConfig = Extract<LiveCapability, { kind: "present" }>;

export interface ProviderConfig {
  /** What a request that omits `providerMode` gets. Defaults to FAKE. */
  readonly defaultRequestMode: AgentRunProviderMode;
  readonly liveCapability: LiveCapability;
}

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
 * Resolves live capability from the two variables that define it.
 *
 * Capability is OPTIONAL — a process with neither variable set is a valid,
 * supported configuration, and it is the one CI and ordinary local development
 * run in. That is why this cannot simply throw when the key is missing.
 *
 * What it must never do is degrade quietly. A *partial* configuration is an
 * operator mistake, not an intent to run deterministically, so every partial
 * or invalid combination throws rather than resolving to "absent":
 *
 *   neither set          → absent          (supported: CI, default local)
 *   both set and valid   → present
 *   exactly one set      → throws          (a typo, or a half-finished deploy)
 *   unsupported model    → throws
 *   out-of-range numeric → throws
 *
 * Treating "key set, model missing" as absent would silently turn a deployment
 * that was meant to be live into a deterministic one — the same class of
 * failure as falling back from LIVE to FAKE, and just as misleading.
 */
function parseLiveCapability(env: EnvRecord): LiveCapability {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const model = env.ANTHROPIC_MODEL?.trim();
  const hasApiKey = apiKey !== undefined && apiKey !== "";
  const hasModel = model !== undefined && model !== "";

  if (!hasApiKey && !hasModel) {
    return { kind: "absent" };
  }

  if (!hasApiKey) {
    throw new ProviderConfigError(
      "ANTHROPIC_API_KEY is required when ANTHROPIC_MODEL is set.",
    );
  }

  if (!hasModel) {
    throw new ProviderConfigError(
      "ANTHROPIC_MODEL is required when ANTHROPIC_API_KEY is set.",
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
    kind: "present",
    selection: { providerMode: "LIVE", modelIdentifier: SUPPORTED_CLAUDE_MODEL },
    anthropic: createAnthropicConfig(apiKey, timeoutMs, maxRetries),
  };
}

/**
 * Parses a plain environment record — never `process.env` directly — so the
 * whole surface is unit-testable without mutating ambient state.
 *
 * There is no fallback path anywhere below. Every invalid combination throws,
 * and a throw here fails startup before the server binds. Degrading to a
 * working-but-deterministic configuration would be the worst available failure
 * mode: the deployment would look healthy while silently proving nothing.
 */
export function parseProviderConfig(env: EnvRecord): ProviderConfig {
  const rawMode = env.AGENT_RUN_PROVIDER_MODE?.trim();
  const defaultRequestMode = rawMode === undefined || rawMode === "" ? "FAKE" : rawMode;

  if (defaultRequestMode !== "FAKE" && defaultRequestMode !== "LIVE") {
    throw new ProviderConfigError(
      "AGENT_RUN_PROVIDER_MODE must be exactly 'FAKE' or 'LIVE'.",
    );
  }

  const liveCapability = parseLiveCapability(env);

  // A process whose default request mode it cannot actually serve is
  // misconfigured: every request that omits `providerMode` would fail at
  // runtime. Better to refuse to start than to serve a guaranteed error.
  if (defaultRequestMode === "LIVE" && liveCapability.kind === "absent") {
    throw new ProviderConfigError(
      "AGENT_RUN_PROVIDER_MODE=LIVE requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL to be set.",
    );
  }

  return { defaultRequestMode, liveCapability };
}
