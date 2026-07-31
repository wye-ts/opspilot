// Public surface of @opspilot/provider-claude.
//
// Every VALUE export below is imported first, then re-exported as a plain
// `const` — never `export { X } from "./y"`. The reason is the one documented
// at length in packages/agent-runtime/src/index.ts: under CommonJS, named
// re-export syntax compiles to a live-binding getter
// (`Object.defineProperty(exports, "X", { get() { ... } })`), and Vite-node's
// CJS interop (used by Vitest) does not reliably forward those getters when
// the module is consumed via a default import — which is exactly how the ESM
// apps/worker consumes workspace packages. Every getter-backed property then
// reads back as `undefined` even though `Object.keys()` lists it. A plain
// `const` compiles to a direct property assignment (`exports.X = y.X`) and
// survives both interop paths. Type-only exports are unaffected (fully erased
// at compile time) and keep the ordinary `export type {...} from "./y"` form.
//
// export-surface.test.ts guards this property from both directions.

import { ClaudeLlmProvider as _ClaudeLlmProvider } from "./claude-llm-provider";
import {
  SUPPORTED_CLAUDE_MODEL as _SUPPORTED_CLAUDE_MODEL,
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE as _UNSUPPORTED_CLAUDE_MODEL_MESSAGE,
  UnsupportedClaudeModelError as _UnsupportedClaudeModelError,
  isSupportedClaudeModel as _isSupportedClaudeModel,
  requireSupportedClaudeModel as _requireSupportedClaudeModel,
} from "./claude-model";
import {
  DEFAULT_MAX_RETRIES as _DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS as _DEFAULT_TIMEOUT_MS,
  ProviderConfigError as _ProviderConfigError,
  parseProviderConfig as _parseProviderConfig,
} from "./claude-config";
import {
  CLAUDE_PRICING_TABLE as _CLAUDE_PRICING_TABLE,
  estimateClaudeCostUsd as _estimateClaudeCostUsd,
} from "./claude-pricing";
import {
  LiveProviderUnavailableError as _LiveProviderUnavailableError,
  createAnthropicClient as _createAnthropicClient,
  createLlmProviderFactory as _createLlmProviderFactory,
} from "./create-llm-provider";
import { createRunProviderUsageCollector as _createRunProviderUsageCollector } from "./run-provider-usage-collector";

// Provider-neutral TYPES are re-exported so a consumer needs one import for
// the provider path. Provider-neutral *values* (LlmProviderError,
// FakeLlmProvider, normalizeDiagnosticToolRequests, …) deliberately are NOT:
// they belong to @opspilot/agent-runtime, and re-exporting them from the
// vendor package would imply they are Claude-specific. Every consumer already
// imports them from the runtime directly.
//
// There is also a hard compiler reason. This package emits declarations
// (`declaration: true`), and a value re-exported by destructuring a default
// import — `export const { X } = opspilotAgentRuntime` — infers a type that
// TypeScript cannot name portably in the .d.ts, which is TS2883. The worker
// never hit this because it type-checks with `noEmit`.
export type {
  AgentConversationMessage,
  AgentTurnInput,
  AgentTurnPhase,
  DiagnosticToolRequestEntry,
  DiagnosticToolResultEntry,
  DiagnosticToolCatalogEntry,
  LlmProvider,
  LlmProviderErrorCategory,
  LlmProviderFactory,
  LlmProviderSelection,
  PricedTokenUsage,
  PricingStatus,
  RawProviderTurnContext,
  TicketContextEntry,
  FakeAgentScenario,
  FakeProviderTurn,
} from "@opspilot/agent-runtime";

export const ClaudeLlmProvider = _ClaudeLlmProvider;
// A local type alias, not a re-export: `export type { X } from "./y"` would
// redeclare the plain-const value export above (TS2323). A local alias lives
// in the type namespace while the const lives in the value namespace —
// exactly how `class X` merges both under one name — which restores X as an
// ordinary type at consumer call sites without `InstanceType<typeof X>`.
export type ClaudeLlmProvider = InstanceType<typeof ClaudeLlmProvider>;
export type {
  AnthropicMessagesClient,
  ClaudeLlmProviderOptions,
  ClaudeProviderLogEvent,
} from "./claude-llm-provider";

export const SUPPORTED_CLAUDE_MODEL = _SUPPORTED_CLAUDE_MODEL;
export const UNSUPPORTED_CLAUDE_MODEL_MESSAGE = _UNSUPPORTED_CLAUDE_MODEL_MESSAGE;
export const UnsupportedClaudeModelError = _UnsupportedClaudeModelError;
export type UnsupportedClaudeModelError = InstanceType<typeof UnsupportedClaudeModelError>;
export const isSupportedClaudeModel = _isSupportedClaudeModel;
export const requireSupportedClaudeModel = _requireSupportedClaudeModel;
export type { SupportedClaudeModel } from "./claude-model";

export const DEFAULT_MAX_RETRIES = _DEFAULT_MAX_RETRIES;
export const DEFAULT_TIMEOUT_MS = _DEFAULT_TIMEOUT_MS;
export const ProviderConfigError = _ProviderConfigError;
export type ProviderConfigError = InstanceType<typeof ProviderConfigError>;
export const parseProviderConfig = _parseProviderConfig;
export type {
  AgentRunProviderMode,
  AnthropicRuntimeConfig,
  EnvRecord,
  LiveCapability,
  LiveProviderConfig,
  ProviderConfig,
} from "./claude-config";

export const CLAUDE_PRICING_TABLE = _CLAUDE_PRICING_TABLE;
export const estimateClaudeCostUsd = _estimateClaudeCostUsd;

export const LiveProviderUnavailableError = _LiveProviderUnavailableError;
export type LiveProviderUnavailableError = InstanceType<typeof LiveProviderUnavailableError>;
export const createAnthropicClient = _createAnthropicClient;
export const createLlmProviderFactory = _createLlmProviderFactory;
export type { LlmProviderFactoryOptions } from "./create-llm-provider";

export const createRunProviderUsageCollector = _createRunProviderUsageCollector;
export type {
  RunProviderUsageCollector,
  RunProviderUsageSummary,
} from "./run-provider-usage-collector";
