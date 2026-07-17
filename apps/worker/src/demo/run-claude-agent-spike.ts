import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { ClaudeLlmProvider, type ClaudeProviderLogEvent } from "../providers/claude-llm-provider";
import { getServiceStatusTool } from "../tools";
import {
  hasFailingScenario,
  runForcedFinalizationProbe,
  runToolThenReportScenario,
  type SpikeScenarioResult,
} from "./claude-agent-spike-scenarios";

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
      `[claude] model=${event.model} providerRequestId=${event.providerRequestId} providerMessageId=${event.providerMessageId} usage=${JSON.stringify(event.usage)} latencyMs=${event.latencyMs.toFixed(0)} normalizedResultType=${event.normalizedResultType}`,
    );
  } else {
    console.log(
      `[claude] model=${event.model} error category=${event.category} latencyMs=${event.latencyMs.toFixed(0)}`,
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
  const model = requireEnv("ANTHROPIC_MODEL");

  // logLevel "off" so all output comes from the adapter's own sanitized
  // telemetry callback below, never the SDK's own debug/warn logging.
  const client = new Anthropic({ apiKey, logLevel: "off" });

  const provider = new ClaudeLlmProvider({
    client,
    model,
    diagnosticTools: [
      {
        tool: getServiceStatusTool,
        description:
          "Look up the current operational status (OPERATIONAL, DEGRADED, OUTAGE, or UNKNOWN) of a named internal service.",
      },
    ],
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
