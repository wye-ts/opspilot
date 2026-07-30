import type { ClaudeProviderLogEvent } from "@opspilot/provider-claude";

/**
 * The only place provider telemetry reaches the server log.
 *
 * `ClaudeProviderLogEvent` is already the adapter's sanitized surface — it
 * carries no prompt, no response text, no headers, and no credential — so this
 * forwards it as a fixed-shape JSON line and adds nothing. In particular it
 * never falls back to logging a raw error object, which is how a request body
 * or an SDK payload would end up in the log.
 *
 * `providerRequestId` is deliberately included. It is the identifier that lets
 * an operator correlate a run with Anthropic's own records, and it is safe
 * *here* precisely because this is server-side only — the same value must
 * never appear in an HTTP response body (see the API error catalog).
 *
 * Matches the one-line JSON convention LoggingInterceptor already uses, so the
 * two are greppable together.
 */
export function logProviderEvent(event: ClaudeProviderLogEvent): void {
  if (event.outcome === "error") {
    console.log(
      JSON.stringify({
        event: "provider_turn",
        outcome: event.outcome,
        provider: event.provider,
        model: event.model,
        terminalErrorCategory: event.terminalErrorCategory,
        latencyMs: Math.round(event.latencyMs),
        configuredMaxRetries: event.configuredMaxRetries,
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      event: "provider_turn",
      outcome: event.outcome,
      provider: event.provider,
      model: event.model,
      providerRequestId: event.providerRequestId,
      latencyMs: Math.round(event.latencyMs),
      stopReason: event.stopReason,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      cacheCreation5mInputTokens: event.cacheCreation5mInputTokens,
      cacheCreation1hInputTokens: event.cacheCreation1hInputTokens,
      configuredMaxRetries: event.configuredMaxRetries,
      // Exact integer nanoUSD as a decimal string. Never a float, and never a
      // bigint — JSON.stringify throws on the latter.
      estimatedCostNanoUsd: event.estimatedCostNanoUsd,
      pricingStatus: event.pricingStatus,
      normalizedResultType: event.normalizedResultType,
    }),
  );
}
