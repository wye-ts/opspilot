// Named re-export syntax (`export { X } from "./y"`) compiles, under
// CommonJS, to a live-binding getter (`Object.defineProperty(exports, "X",
// { get() { return y.X; } })`). Vite-node's CJS interop (used by Vitest) does
// not reliably forward these getters when this module is consumed via a
// default import (`import pkg from "@opspilot/agent-runtime"` — required for
// worker's ESM<->CommonJS interop, see docs/11-agent-run-persistence.md):
// every getter-backed property reads back as `undefined`, even though
// `Object.keys()` lists it. Plain Node (`require`) and `tsx` are unaffected —
// only Vitest's SSR module handling exhibits this. Every VALUE export below
// is therefore imported first, then re-exported as a plain `const` — which
// compiles to a direct property assignment (`exports.X = y.X`), not a
// getter — verified to resolve correctly under Vitest. Type-only exports are
// unaffected (fully erased at compile time, no runtime representation) and
// keep the ordinary `export type {...} from "./y"` form.

import {
  createAgentRunService as _createAgentRunService,
  createPrismaAgentRunRepository as _createPrismaAgentRunRepository,
} from "./persistence/agent-run-service";
import {
  AgentRunConfigurationError as _AgentRunConfigurationError,
  AgentRunServiceError as _AgentRunServiceError,
} from "./persistence/agent-run-service-error";
import {
  runAgentOrchestrator as _runAgentOrchestrator,
  findInvalidEvidence as _findInvalidEvidence,
} from "./agent/agent-orchestrator";
import {
  LlmProviderError as _LlmProviderError,
  normalizeDiagnosticToolRequests as _normalizeDiagnosticToolRequests,
} from "./providers/llm-provider";
import { FakeLlmProvider as _FakeLlmProvider, FakeScenarioTurnNotFoundError as _FakeScenarioTurnNotFoundError } from "./providers/fake-llm-provider";
import { InMemoryToolRegistry as _InMemoryToolRegistry, getServiceStatusTool as _getServiceStatusTool } from "./tools";
import {
  DIAGNOSTIC_TOOL_CATALOG as _DIAGNOSTIC_TOOL_CATALOG,
  GET_SERVICE_STATUS_CATALOG_ENTRY as _GET_SERVICE_STATUS_CATALOG_ENTRY,
} from "./tools/diagnostic-tool-catalog";
import { estimateCostUsd as _estimateCostUsd } from "./providers/cost-estimation";
import { resolveAbortProvenance as _resolveAbortProvenance } from "./providers/run-abort-context";
import { RetrieverError as _RetrieverError } from "./rag/runbook-retriever";
import { validateRetrievalInput as _validateRetrievalInput, validateRetrievedChunks as _validateRetrievedChunks } from "./rag/retrieval-validation";
import { formatRagContext as _formatRagContext } from "./rag/rag-context-formatting";
import { INJECTION_PROBE_CHUNK as _INJECTION_PROBE_CHUNK } from "./rag/injection-probe-fixture";

export const createAgentRunService = _createAgentRunService;
export const createPrismaAgentRunRepository = _createPrismaAgentRunRepository;
export const AgentRunServiceError = _AgentRunServiceError;
export const AgentRunConfigurationError = _AgentRunConfigurationError;
export const runAgentOrchestrator = _runAgentOrchestrator;
export const findInvalidEvidence = _findInvalidEvidence;
export const LlmProviderError = _LlmProviderError;
export const normalizeDiagnosticToolRequests = _normalizeDiagnosticToolRequests;
export const FakeLlmProvider = _FakeLlmProvider;
export const FakeScenarioTurnNotFoundError = _FakeScenarioTurnNotFoundError;
export const InMemoryToolRegistry = _InMemoryToolRegistry;
export const getServiceStatusTool = _getServiceStatusTool;
export const DIAGNOSTIC_TOOL_CATALOG = _DIAGNOSTIC_TOOL_CATALOG;
export const GET_SERVICE_STATUS_CATALOG_ENTRY = _GET_SERVICE_STATUS_CATALOG_ENTRY;
export const estimateCostUsd = _estimateCostUsd;
export const resolveAbortProvenance = _resolveAbortProvenance;
export const RetrieverError = _RetrieverError;
export const validateRetrievalInput = _validateRetrievalInput;
export const validateRetrievedChunks = _validateRetrievedChunks;
export const formatRagContext = _formatRagContext;
export const INJECTION_PROBE_CHUNK = _INJECTION_PROBE_CHUNK;

export type { AgentRunRepositoryInterface } from "./persistence/agent-run-repository-interface";
export type {
  AgentRunService,
  ExecuteAndPersistParams,
  ExecuteAndPersistResult,
  ReplayLiveRunResult,
  RetryFinalizationParams,
} from "./persistence/agent-run-service";
// A re-exported `export type { X } from "./y"` would redeclare each
// plain-const value export above (TS2323). A local type-alias declaration
// does not conflict, because it lives in the type namespace while the const
// lives in the value namespace — exactly like `class X` merges both
// namespaces under one name. This restores every class below as an
// ordinary type usable at consumer call sites without `InstanceType<typeof X>`.
export type AgentRunServiceError = InstanceType<typeof AgentRunServiceError>;
export type AgentRunConfigurationError = InstanceType<typeof AgentRunConfigurationError>;
export type {
  AgentRunExecutionContext,
  AgentRunServiceErrorCode,
} from "./persistence/agent-run-service-error";
export type {
  AgentRunUsageCollector,
  AgentRunUsageHooks,
  RunProviderUsageSummary,
} from "./persistence/run-provider-usage";

export type {
  AgentOrchestratorParams,
  AgentOrchestratorResult,
  AgentTraceEvent,
  RetrievalSummaryEntry,
} from "./agent/agent-orchestrator";

export type {
  AgentConversationMessage,
  AgentTurnInput,
  AgentTurnPhase,
  DiagnosticToolRequestEntry,
  DiagnosticToolResultEntry,
  TicketContextEntry,
  RagContextEntry,
  RagContextMessage,
  LlmProvider,
  LlmProviderErrorCategory,
  RawProviderTurnContext,
} from "./providers/llm-provider";
export type LlmProviderError = InstanceType<typeof LlmProviderError>;
export type { FakeAgentScenario, FakeProviderTurn } from "./providers/fake-llm-provider";
export type FakeLlmProvider = InstanceType<typeof FakeLlmProvider>;
export type FakeScenarioTurnNotFoundError = InstanceType<typeof FakeScenarioTurnNotFoundError>;

export type { DiagnosticToolDefinition, ToolRegistry } from "./tools";
export type InMemoryToolRegistry = InstanceType<typeof InMemoryToolRegistry>;
export type { DiagnosticToolCatalogEntry } from "./tools/diagnostic-tool-catalog";

export type {
  LlmProviderFactory,
  LlmProviderSelection,
} from "./providers/llm-provider-factory";

export type { RunAbortContext } from "./providers/run-abort-context";

export type {
  CostEstimate,
  ModelPricing,
  ModelPricingTable,
  PricedTokenUsage,
  PricingStatus,
} from "./providers/cost-estimation";

export type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RetrieverErrorCategory,
  RunbookRetriever,
  StoredRunbookChunk,
} from "./rag/runbook-retriever";
export type RetrieverError = InstanceType<typeof RetrieverError>;
