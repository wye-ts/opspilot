import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import opspilotAgentRuntime from "@opspilot/agent-runtime";

import { ClaudeLlmProvider, type ClaudeProviderLogEvent } from "../providers/claude-llm-provider";
import { requireSupportedClaudeModel } from "../providers/claude-model";
import {
  hasFailingScenario,
  runForcedFinalizationProbe,
  runToolThenReportScenario,
  type SpikeScenarioResult,
} from "./claude-agent-spike-scenarios";

const { GET_SERVICE_STATUS_CATALOG_ENTRY } = opspilotAgentRuntime;

// This script predates the validated worker configuration and builds its own
// Anthropic client without passing timeout/maxRetries, so it inherits the
// SDK's own defaults. Recorded explicitly rather than implied.
const SDK_DEFAULT_MAX_RETRIES = 2;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

// Never prints keys, headers, or raw SDK payloads — only the metadata the
// adapter itself decided was safe to surface. "response_received" never
// implies the agent turn succeeded — see normalizedResultType.
function logSpikeEvent(event: ClaudeProviderLogEvent): void {
  if (event.outcome === "response_received") {
    console.log(
      `[claude] model=${event.model} providerRequestId=${event.providerRequestId} providerMessageId=${event.providerMessageId} usage={"inputTokens":${event.inputTokens},"outputTokens":${event.outputTokens}} estimatedCostUsd=${event.estimatedCostUsd ?? "null"} pricingStatus=${event.pricingStatus} latencyMs=${event.latencyMs.toFixed(0)} normalizedResultType=${event.normalizedResultType}`,
    );
  } else {
    console.log(
      `[claude] model=${event.model} error category=${event.terminalErrorCategory} latencyMs=${event.latencyMs.toFixed(0)}`,
    );
  }
}

function printSummary(results: readonly SpikeScenarioResult[]): void {
  console.log("\n=== Summary ===");
  for (const result of results) {
    console.log(
      result.passed ? `${result.name}: PASSED` : `${result.name}: FAILED (${result.failureCode})`,
    );
  }
}

async function main(): Promise<void> {
  // Fail closed: both must be present before the client is ever constructed.
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  // Validated through the same supported-model policy the configuration-
  // selected path uses, BEFORE any client or provider is constructed — there
  // is no unchecked `model: process.env.ANTHROPIC_MODEL` route into the adapter.
  const model = requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL);

  // logLevel "off" so all output comes from the adapter's own sanitized
  // telemetry callback below, never the SDK's own debug/warn logging.
  const client = new Anthropic({ apiKey, logLevel: "off" });

  const provider = new ClaudeLlmProvider({
    client,
    model,
    // The tool description now comes from the shared catalog rather than a
    // literal duplicated with run-rag-live-spike.ts.
    diagnosticTools: [GET_SERVICE_STATUS_CATALOG_ENTRY],
    // This historical spike constructs its own client without the configured
    // retry ceiling, so it reports the SDK default it actually inherits.
    configuredMaxRetries: SDK_DEFAULT_MAX_RETRIES,
    logger: logSpikeEvent,
  });

  const results: SpikeScenarioResult[] = [
    await runToolThenReportScenario(provider),
    await runForcedFinalizationProbe(provider),
  ];

  printSummary(results);

  if (hasFailingScenario(results)) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch(() => {
    // Deliberately generic and fixed: the caught value could be anything
    // (an unwrapped SDK error, a bug, a rejected promise from deep in the
    // call stack) and must never be printed directly here, since that could
    // leak request bodies, headers, API keys, or stack traces.
    console.error(
      "[claude-spike] The spike failed to run. No further error details are printed to avoid leaking sensitive information.",
    );
    process.exitCode = 1;
  });
}
