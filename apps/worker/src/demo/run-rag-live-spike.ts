import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { VoyageAIClient } from "voyageai";

import { ClaudeLlmProvider, type ClaudeProviderLogEvent } from "../providers/claude-llm-provider";
import type { VoyageEmbeddingClient } from "../rag";
import { getServiceStatusTool } from "../tools";
import {
  hasFailingScenario,
  resolveScenarioSelection,
  runBaselineRagScenario,
  runInjectionProbeScenario,
  runSelectedScenarios,
  type SpikeScenarioResult,
} from "./run-rag-live-spike-scenarios";

// NOTE: this composition root is never executed by automated tests or CI —
// it requires ANTHROPIC_API_KEY, ANTHROPIC_MODEL, and VOYAGE_API_KEY, and
// makes real, billed API calls. Run manually via `pnpm run spike:rag`.
// Scenario pass/fail logic lives in run-rag-live-spike-scenarios.ts, which
// is unit-tested directly (run-rag-live-spike-scenarios.test.ts) without
// ever importing or executing this file.

const ALLOWED_EMBEDDING_DIMENSIONS = [256, 512, 1024, 2048] as const;
const VOYAGE_PRICE_PER_MILLION_TOKENS: Readonly<Record<string, number>> = {
  "voyage-4-lite": 0.02,
  "voyage-4": 0.06,
  "voyage-4-large": 0.12,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function resolveEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "voyage-4-lite";
}

// Fail closed: an explicitly-set-but-invalid value is rejected before any
// client is constructed, never silently passed through to the SDK.
function resolveEmbeddingDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  if (raw === undefined || raw.trim() === "") {
    return 1024;
  }
  const parsed = Number(raw);
  if (!ALLOWED_EMBEDDING_DIMENSIONS.includes(parsed as (typeof ALLOWED_EMBEDDING_DIMENSIONS)[number])) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be one of ${ALLOWED_EMBEDDING_DIMENSIONS.join(", ")}, got "${raw}".`,
    );
  }
  return parsed;
}

// Never prints keys, headers, or raw SDK payloads — only the metadata the
// adapter itself decided was safe to surface.
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

// Wraps the real Voyage client to log sanitized per-call telemetry
// (model/inputType/latency/totalTokens only — never raw request/response
// bodies or embedding vectors) and to accumulate total token usage for the
// estimated-cost summary printed at the end of the run.
function loggingVoyageClient(
  client: VoyageEmbeddingClient,
  usageAccumulator: { totalTokens: number },
): VoyageEmbeddingClient {
  return {
    async embed(request) {
      const startedAt = Date.now();
      const response = await client.embed(request);
      const latencyMs = Date.now() - startedAt;
      const totalTokens = response.usage?.totalTokens;
      if (typeof totalTokens === "number") {
        usageAccumulator.totalTokens += totalTokens;
      }
      console.log(
        `[voyage] model=${request.model} inputType=${request.inputType ?? "null"} latencyMs=${latencyMs} totalTokens=${totalTokens ?? "unknown"}`,
      );
      return response;
    },
  };
}

function printEstimatedVoyageCost(model: string, totalTokens: number): void {
  const pricePerMillion = VOYAGE_PRICE_PER_MILLION_TOKENS[model];
  if (pricePerMillion === undefined) {
    console.log(
      `\n[voyage] estimated cost: unknown (no verified pricing on file for model "${model}"; ` +
        `re-verify current pricing before trusting a number) — totalTokens=${totalTokens}`,
    );
    return;
  }
  const estimatedCostUsd = (totalTokens / 1_000_000) * pricePerMillion;
  console.log(
    `\n[voyage] estimated cost: $${estimatedCostUsd.toFixed(6)} (totalTokens=${totalTokens}, ` +
      `$${pricePerMillion}/M tokens for ${model} — verify this price is still current before trusting it)`,
  );
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
  // Fail closed: every required value — including which scenario(s) to run
  // — is validated before any client is constructed.
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const anthropicModel = requireEnv("ANTHROPIC_MODEL");
  const voyageApiKey = requireEnv("VOYAGE_API_KEY");
  const embeddingModel = resolveEmbeddingModel();
  const embeddingDimensions = resolveEmbeddingDimensions();
  const scenarioSelection = resolveScenarioSelection(process.env.RAG_SPIKE_SCENARIO);

  // logLevel "off" / logging.silent:true so all output comes from this
  // script's own sanitized telemetry, never the SDKs' own debug/warn logging
  // (which could print raw request/response payloads).
  const anthropicClient = new Anthropic({ apiKey: anthropicApiKey, logLevel: "off" });
  const claudeProvider = new ClaudeLlmProvider({
    client: anthropicClient,
    model: anthropicModel,
    diagnosticTools: [
      {
        tool: getServiceStatusTool,
        description:
          "Look up the current operational status (OPERATIONAL, DEGRADED, OUTAGE, or UNKNOWN) of a named internal service.",
      },
    ],
    logger: logSpikeEvent,
  });

  const voyageClient = new VoyageAIClient({ apiKey: voyageApiKey, logging: { silent: true } });
  const usage = { totalTokens: 0 };
  const loggedVoyageClient = loggingVoyageClient(voyageClient, usage);

  // Only the selected scenario(s)' callback(s) are ever invoked — selecting
  // "injection" never calls, initializes, or executes Scenario A retrieval
  // or Claude work, and vice versa.
  const results = await runSelectedScenarios(scenarioSelection, {
    runBaseline: () =>
      runBaselineRagScenario(claudeProvider, loggedVoyageClient, embeddingModel, embeddingDimensions),
    runInjection: () =>
      runInjectionProbeScenario(claudeProvider, loggedVoyageClient, embeddingModel, embeddingDimensions),
  });

  printSummary(results);
  printEstimatedVoyageCost(embeddingModel, usage.totalTokens);

  if (hasFailingScenario(results)) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch(() => {
    // Deliberately generic and fixed — never print the caught value, since
    // it could leak request bodies, headers, API keys, or stack traces.
    console.error(
      "[rag-spike] The spike failed to run. No further error details are printed to avoid leaking sensitive information.",
    );
    process.exitCode = 1;
  });
}
