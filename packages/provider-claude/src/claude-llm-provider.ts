import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { LlmProviderError } from "@opspilot/agent-runtime";
import type {
  AgentTurnInput,
  LlmProvider,
  LlmProviderErrorCategory,
  PricedTokenUsage,
  PricingStatus,
  RawProviderTurnContext,
} from "@opspilot/agent-runtime";
import type { AgentTurnResult } from "@opspilot/contracts";

import { buildClaudeMessages, buildSystemPrompt } from "./claude-message-mapping";
import type { SupportedClaudeModel } from "./claude-model";
import { estimateClaudeCostUsd } from "./claude-pricing";
import { normalizeClaudeMessage } from "./claude-response-normalization";
import {
  SUBMIT_RESOLUTION_REPORT_TOOL,
  SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  toClaudeDiagnosticTool,
  type DiagnosticToolWithDescription,
} from "./claude-tool-schemas";


// The seam ClaudeLlmProvider depends on instead of a concrete Anthropic
// client, so tests can inject a fake with zero live calls. A real
// `new Anthropic(...)` instance satisfies this structurally.
export interface AnthropicMessagesClient {
  readonly messages: {
    // The SDK's real return type is APIPromise<Message>, which resolves to
    // Message intersected with a non-enumerable `_request_id` (sourced from
    // the `request-id` response header) — not part of the public Message
    // interface itself, so it's declared explicitly here.
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Anthropic.Message & { readonly _request_id?: string | null }>;
  };
}

export type ClaudeProviderLogEvent =
  | {
      // "response_received" means the HTTP call succeeded, not that the
      // agent turn was semantically successful — normalizedResultType may
      // still be protocol_error. Never describe that case as "success".
      readonly outcome: "response_received";
      readonly provider: "anthropic";
      readonly model: string;
      readonly providerRequestId: string;
      readonly providerMessageId: string;
      readonly latencyMs: number;
      readonly stopReason: string | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadInputTokens: number;
      readonly cacheCreation5mInputTokens: number;
      readonly cacheCreation1hInputTokens: number;
      // The *configured* ceiling, not an observed attempt count. The Messages
      // response exposes no reliable standard field for how many attempts the
      // SDK actually made, so reporting an "attempts" number would be an
      // invention. This is a configuration fact, true by construction.
      readonly configuredMaxRetries: number;
      // Exact integer nanoUSD as a decimal string — the accounting value, not
      // a display value. A JSON number cannot carry money without rounding,
      // and a `bigint` cannot cross `JSON.stringify` at all, so the string is
      // the only representation that survives both this sanitized event and a
      // structured log line intact. Consumers that accumulate cost take
      // `BigInt(estimatedCostNanoUsd)`; consumers that render it format it
      // themselves. Deriving nanoUSD from a USD float would reintroduce the
      // precision loss packages/agent-runtime/src/providers/cost-estimation.ts
      // exists to prevent.
      readonly estimatedCostNanoUsd: string | null;
      readonly pricingStatus: PricingStatus;
      readonly pricingBasis: string | null;
      readonly pricingBasisDate: string | null;
      readonly effectiveFrom: string | null;
      readonly validThrough: string | null;
      readonly normalizedResultType: AgentTurnResult["type"];
    }
  | {
      readonly outcome: "error";
      readonly provider: "anthropic";
      readonly model: string;
      readonly terminalErrorCategory: LlmProviderErrorCategory;
      /**
       * Distinguishes the two paths that both currently terminate as
       * `terminalErrorCategory: "UNKNOWN"` and were, before this field
       * existed, indistinguishable in the log: an SDK exception that fell
       * through `classifyError()` unclassified, vs. an HTTP 200 response
       * that parsed successfully but omitted `_request_id`. Every other
       * category is always `sdk_exception` — `missing_request_id` is only
       * ever paired with `UNKNOWN`.
       */
      readonly errorSource: ClaudeProviderErrorSource;
      /**
       * The caught exception's constructor name (e.g. "AuthenticationError",
       * "TypeError") — a class name only, never `error.message` or any part
       * of the exception's own text, which for an Anthropic `APIError` can
       * embed the raw provider response body. `null` for
       * `missing_request_id`, where there is no caught exception.
       */
      readonly errorClass: string | null;
      /**
       * The HTTP status, when the caught exception is an Anthropic
       * `APIError` that carries one. `null` for `missing_request_id` and for
       * any non-`APIError`/statusless exception (e.g. `APIConnectionError`).
       */
      readonly errorStatus: number | null;
      readonly latencyMs: number;
      readonly configuredMaxRetries: number;
    };

/**
 * See `errorSource` above — internal-only, never surfaced on any public
 * failure code or AgentOrchestratorErrorCode.
 */
export type ClaudeProviderErrorSource = "sdk_exception" | "missing_request_id";

export interface ClaudeLlmProviderOptions {
  readonly client: AnthropicMessagesClient;
  // Narrowed to the one validated model rather than an open string. The
  // adapter's unconditional `thinking: { type: "disabled" }` is only correct
  // for this model, so accepting an arbitrary string here would let an
  // unvalidated model reach a real request and make the request policy wrong
  // by construction. Every construction site therefore has to go through
  // claude-model.ts's validator.
  readonly model: SupportedClaudeModel;
  readonly diagnosticTools: readonly DiagnosticToolWithDescription[];
  readonly configuredMaxRetries: number;
  readonly logger?: (event: ClaudeProviderLogEvent) => void;
  // Injected so cost estimation stays deterministic and testable; production
  // callers leave it unset and get the real clock.
  readonly now?: () => Date;
}

const SANITIZED_MESSAGE_BY_CATEGORY: Record<LlmProviderErrorCategory, string> = {
  AUTHENTICATION: "Anthropic API rejected the request as unauthorized.",
  BILLING:
    "The Anthropic account cannot process this request because of a billing or credit issue.",
  RATE_LIMIT: "Anthropic API rate limit was exceeded.",
  CONNECTION: "Failed to connect to the Anthropic API.",
  TIMEOUT: "The request to the Anthropic API timed out.",
  CANCELLED: "The request to the Anthropic API was cancelled.",
  SERVER_ERROR: "The Anthropic API returned a server error.",
  REQUEST_INVALID:
    "The Anthropic API rejected the request as malformed; this likely indicates an adapter bug.",
  UNKNOWN: "The Anthropic API request failed for an unknown reason.",
};

/**
 * Ordering is load-bearing, in four places:
 *
 *  1. APIUserAbortError extends APIError directly, so it must be matched
 *     before any generic APIError handling or a deliberate cancellation would
 *     be reported as a provider failure.
 *  2. APIConnectionTimeoutError extends APIConnectionError, so it must be
 *     checked first or every timeout would misclassify as CONNECTION.
 *  3. Numeric status is checked before the >=500 instanceof, because the SDK
 *     maps *every* 5xx to InternalServerError — a 504 gateway timeout would
 *     otherwise be reported as a generic server error rather than a timeout.
 *  4. The generic 5xx fallback at the end is checked only after every named
 *     class and numeric override above, so it can never override a more
 *     specific classification — it only catches an unmapped 5xx that nothing
 *     above matched. There is no equivalent generic 4xx fallback — see the
 *     comment on that fallback for why.
 */
function classifyError(error: unknown): LlmProviderErrorCategory {
  if (error instanceof APIUserAbortError) return "CANCELLED";
  if (error instanceof APIConnectionTimeoutError) return "TIMEOUT";
  if (error instanceof APIConnectionError) return "CONNECTION";

  if (error instanceof APIError) {
    // Numeric-status overrides, applied before the typed-class checks below.
    //
    // These four statuses cannot be classified correctly from the SDK's
    // exception classes alone: 402 and 413 have no dedicated class at all, and
    // 504 shares InternalServerError with 500/529. 408 does have retry
    // behaviour in the SDK, but once retries are exhausted it can surface as a
    // generic APIError, and a request timeout is a timeout — not an unknown.
    if (error.status === 402) return "BILLING";
    if (error.status === 408) return "TIMEOUT";
    if (error.status === 413) return "REQUEST_INVALID";
    if (error.status === 504) return "TIMEOUT";
  }

  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return "AUTHENTICATION";
  }
  if (error instanceof RateLimitError) return "RATE_LIMIT";
  if (error instanceof InternalServerError) return "SERVER_ERROR";
  if (
    error instanceof BadRequestError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof UnprocessableEntityError
  ) {
    return "REQUEST_INVALID";
  }

  // Generic-status fallback — 5xx only. A 5xx status the SDK does not map to
  // InternalServerError or the 504 override above is still a real server-side
  // failure (possibly after partial generation), so it is classified
  // SERVER_ERROR rather than collapsed to UNKNOWN.
  //
  // A generic/unmapped 4xx (e.g. 405, 406, 451 — or any future status
  // Anthropic's edge starts returning before this adapter is updated for it)
  // is deliberately left to fall through to UNKNOWN below, not classified as
  // REQUEST_INVALID: REQUEST_INVALID is one of
  // run-provider-usage-collector.ts's PROVABLY_UNBILLED_CATEGORIES, and an
  // unrecognized 4xx has not been confirmed to mean "rejected before
  // dispatch" the way the named 400/404/409/413/422 classes above have.
  // Guessing REQUEST_INVALID here would silently relax the possible-
  // unobserved-cost accounting's fail-closed guarantee for a status this
  // adapter has never actually validated. UNKNOWN keeps that guarantee
  // intact; errorSource/errorClass/errorStatus on the logged event (see
  // describeSdkException below) still make the failure fully diagnosable
  // without weakening the accounting policy.
  if (error instanceof APIError && typeof error.status === "number" && error.status >= 500) {
    return "SERVER_ERROR";
  }

  return "UNKNOWN";
}

/**
 * Safe-to-log diagnostic metadata for a caught SDK exception: a class name
 * and, when available, an HTTP status — never `error.message` (an Anthropic
 * `APIError`'s message can embed the raw provider response body) and never
 * headers, payloads, or the error's own `error`/`cause` fields.
 */
function describeSdkException(error: unknown): {
  readonly errorClass: string | null;
  readonly errorStatus: number | null;
} {
  return {
    errorClass: error instanceof Error ? error.constructor.name : null,
    errorStatus: error instanceof APIError && typeof error.status === "number" ? error.status : null,
  };
}

/**
 * Splits the response's usage into the five separately-priced token
 * categories.
 *
 * The 5-minute and 1-hour cache-write TTLs carry different rates, so they are
 * never summed. When the API reports a non-zero aggregate
 * `cache_creation_input_tokens` but omits the per-TTL `cache_creation`
 * breakdown, the TTL is not guessed: the flag below turns the estimate into
 * INSUFFICIENT_USAGE_DETAIL rather than pricing at whichever rate happened to
 * be convenient.
 */
function toPricedUsage(usage: Anthropic.Usage): PricedTokenUsage {
  const cacheCreation = usage.cache_creation;
  const aggregateCacheCreation = usage.cache_creation_input_tokens ?? 0;

  if (cacheCreation) {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreation5mInputTokens: cacheCreation.ephemeral_5m_input_tokens,
      cacheCreation1hInputTokens: cacheCreation.ephemeral_1h_input_tokens,
    };
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    ...(aggregateCacheCreation > 0 ? { cacheCreationBreakdownMissing: true } : {}),
  };
}

export class ClaudeLlmProvider implements LlmProvider {
  constructor(private readonly options: ClaudeLlmProviderOptions) {}

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const params = this.buildRequestParams(input);
    const startedAt = performance.now();

    let message: Anthropic.Message & { readonly _request_id?: string | null };
    try {
      message = await this.options.client.messages.create(
        params,
        // Conditional spread keeps the options object absent entirely when no
        // signal was supplied, rather than passing `{ signal: undefined }`.
        input.signal !== undefined ? { signal: input.signal } : {},
      );
    } catch (error) {
      const category = classifyError(error);
      this.logError(category, performance.now() - startedAt, "sdk_exception", describeSdkException(error));
      // Transport/auth/rate-limit/server failures never produced a
      // parseable model response, so they must never be laundered into a
      // protocol_error AgentTurnResult — they throw instead.
      throw new LlmProviderError(category, SANITIZED_MESSAGE_BY_CATEGORY[category]);
    }

    const latencyMs = performance.now() - startedAt;
    const providerRequestId = message._request_id;
    if (!providerRequestId) {
      this.logError("UNKNOWN", latencyMs, "missing_request_id", { errorClass: null, errorStatus: null });
      throw new LlmProviderError("UNKNOWN", "Anthropic response was missing a request id.");
    }

    const context: RawProviderTurnContext = {
      providerRequestId,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };

    // Normalize before logging so the logged event reflects what the turn
    // actually resolved to — a protocol_error must never be reported as if
    // the turn had succeeded.
    const normalizedResult = normalizeClaudeMessage(message, context);

    const pricedUsage = toPricedUsage(message.usage);
    // Priced against the model the API actually returned, not the one that was
    // requested, so a server-side resolution difference cannot be mis-priced.
    const cost = estimateClaudeCostUsd(
      pricedUsage,
      message.model,
      (this.options.now ?? (() => new Date()))(),
    );

    this.options.logger?.({
      outcome: "response_received",
      provider: "anthropic",
      model: message.model,
      providerRequestId,
      providerMessageId: message.id,
      latencyMs,
      stopReason: message.stop_reason,
      inputTokens: pricedUsage.inputTokens,
      outputTokens: pricedUsage.outputTokens,
      cacheReadInputTokens: pricedUsage.cacheReadInputTokens,
      cacheCreation5mInputTokens: pricedUsage.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: pricedUsage.cacheCreation1hInputTokens,
      configuredMaxRetries: this.options.configuredMaxRetries,
      estimatedCostNanoUsd: cost.estimatedCostNanoUsd,
      pricingStatus: cost.pricingStatus,
      pricingBasis: cost.pricingBasis,
      pricingBasisDate: cost.pricingBasisDate,
      effectiveFrom: cost.effectiveFrom,
      validThrough: cost.validThrough,
      normalizedResultType: normalizedResult.type,
    });

    return normalizedResult;
  }

  private logError(
    category: LlmProviderErrorCategory,
    latencyMs: number,
    errorSource: ClaudeProviderErrorSource,
    diagnostics: { readonly errorClass: string | null; readonly errorStatus: number | null },
  ): void {
    this.options.logger?.({
      outcome: "error",
      provider: "anthropic",
      model: this.options.model,
      terminalErrorCategory: category,
      errorSource,
      errorClass: diagnostics.errorClass,
      errorStatus: diagnostics.errorStatus,
      latencyMs,
      configuredMaxRetries: this.options.configuredMaxRetries,
    });
  }

  private buildRequestParams(input: AgentTurnInput): Anthropic.MessageCreateParamsNonStreaming {
    const isInvestigation = input.phase === "INVESTIGATION";

    const tools: Anthropic.Tool[] = isInvestigation
      ? [...this.options.diagnosticTools.map(toClaudeDiagnosticTool), SUBMIT_RESOLUTION_REPORT_TOOL]
      : [SUBMIT_RESOLUTION_REPORT_TOOL];

    const toolChoice: Anthropic.ToolChoice = isInvestigation
      ? { type: "auto", disable_parallel_tool_use: true }
      : { type: "tool", name: SUBMIT_RESOLUTION_REPORT_TOOL_NAME, disable_parallel_tool_use: true };

    return {
      model: this.options.model,
      // Never inferred or hardcoded here — the caller (orchestrator or smoke
      // runner) owns this value, and it is the single output-budget authority.
      max_tokens: input.maxOutputTokens,
      // Issue #58 Checkpoint B (§8/§10): the investigation-only guidance block
      // interpolates the turn's remaining diagnostic capacity (constraint
      // visibility, not a quota — the #57 harness remains authoritative for the
      // bound). buildSystemPrompt takes it on every turn, INVESTIGATION and
      // FINALIZATION alike, so the call shape stays uniform.
      system: buildSystemPrompt(input.phase, input.diagnosticCallsRemaining),
      messages: buildClaudeMessages(input.conversation),
      tools,
      tool_choice: toolChoice,
      // Claude Sonnet 5 defaults to adaptive thinking, which is incompatible
      // with forced tool_choice ({type:"tool",...}) and would 400 error.
      // Disabled uniformly on every call. This request policy is validated for
      // claude-sonnet-5 only, which is why claude-config.ts refuses every other
      // model rather than letting an unvalidated one through.
      thinking: { type: "disabled" },
    };
  }
}
