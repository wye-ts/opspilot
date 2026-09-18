import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { VoyageAIClient } from "voyageai";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import opspilotProviderClaude from "@opspilot/provider-claude";
import type { ClaudeProviderLogEvent } from "@opspilot/provider-claude";

import { loadDefaultRunbookCorpus, type VoyageEmbeddingClient } from "../rag";

import {
  buildScenarioCallbacks,
  hasFailingScenario,
  resolveScenarioSelection,
  runBaselineRagScenario,
  runExfiltrationScenario,
  runInjectionProbeScenario,
  runRoleConfusionScenario,
  runSelectedScenarios,
  runTwoToolUsageScenario,
  runToolOutputOverrideScenario,
  selectionNeedsVoyage,
  type SpikeScenarioResult,
} from "./run-rag-live-spike-scenarios";

const { GET_SERVICE_STATUS_CATALOG_ENTRY, GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY } =
  opspilotAgentRuntime;
const { ClaudeLlmProvider, requireSupportedClaudeModel } = opspilotProviderClaude;

// This script predates the validated worker configuration and builds its own
// Anthropic client without passing timeout/maxRetries, so it inherits the
// SDK's own defaults. Recorded explicitly rather than implied.
const SDK_DEFAULT_MAX_RETRIES = 2;

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
      `[claude] model=${event.model} providerRequestId=${event.providerRequestId} providerMessageId=${event.providerMessageId} usage={"inputTokens":${event.inputTokens},"outputTokens":${event.outputTokens}} estimatedCostNanoUsd=${event.estimatedCostNanoUsd ?? "null"} pricingStatus=${event.pricingStatus} latencyMs=${event.latencyMs.toFixed(0)} normalizedResultType=${event.normalizedResultType}`,
    );
  } else {
    console.log(
      `[claude] model=${event.model} error category=${event.terminalErrorCategory} latencyMs=${event.latencyMs.toFixed(0)}`,
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
  // — is validated before any client is constructed. Scenario selection is
  // resolved FIRST, before requiring VOYAGE_API_KEY: tool-output-override
  // is purely tool-driven (see runToolOutputOverrideScenario) and performs
  // no RAG retrieval, so a standalone tool-output-override-only run must
  // not be forced to configure an unrelated Voyage credential (Codex-review
  // MINOR fix — an earlier version required it unconditionally, breaking
  // scenario isolation for a realistic manual invocation).
  const scenarioSelection = resolveScenarioSelection(process.env.RAG_SPIKE_SCENARIO);
  const needsVoyage = selectionNeedsVoyage(scenarioSelection);

  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  // Validated through the same supported-model policy the configuration-
  // selected path uses, BEFORE any client or provider is constructed — there
  // is no unchecked `model: process.env.ANTHROPIC_MODEL` route into the adapter.
  const anthropicModel = requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL);
  const voyageApiKey = needsVoyage ? requireEnv("VOYAGE_API_KEY") : undefined;
  // Codex-review round-2 MINOR fix: an earlier version validated these
  // unconditionally, so a stale/invalid EMBEDDING_DIMENSIONS value could
  // block a standalone tool-output-override-only run that never touches
  // Voyage at all. Only resolved (and only capable of throwing) when a
  // selected scenario actually needs Voyage.
  const embeddingModel = needsVoyage ? resolveEmbeddingModel() : undefined;
  const embeddingDimensions = needsVoyage ? resolveEmbeddingDimensions() : undefined;

  // logLevel "off" / logging.silent:true so all output comes from this
  // script's own sanitized telemetry, never the SDKs' own debug/warn logging
  // (which could print raw request/response payloads).
  const anthropicClient = new Anthropic({ apiKey: anthropicApiKey, logLevel: "off" });
  // SCENARIO-SPECIFIC TOOL WIRING (issue #95).
  //
  // The historical adversarial scenarios (B/C/D/E) deliberately pin a
  // single-entry list: their acceptance logic reasons about one tool's
  // output, and silently widening what they offer would change what those
  // recorded observations mean. They keep the narrow provider below.
  //
  // two-tool-usage needs the opposite. Its whole question is which tools the
  // model spends budget on a SECOND tool it was genuinely offered, so a
  // provider pinned to one entry would make a "no deployments call" result
  // an artifact of the wiring rather than an observation about the model.
  // It therefore gets its own provider built from the real catalog, and
  // evaluateTwoToolUsageScenario fails closed if either tool is missing
  // from the offered list it is handed.
  const narrowDiagnosticTools = [GET_SERVICE_STATUS_CATALOG_ENTRY];
  const bothCatalogTools = [GET_SERVICE_STATUS_CATALOG_ENTRY, GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY];

  const claudeProvider = new ClaudeLlmProvider({
    client: anthropicClient,
    model: anthropicModel,
    // The tool description now comes from the shared catalog rather than a
    // literal duplicated with run-claude-agent-spike.ts.
    diagnosticTools: narrowDiagnosticTools,
    // This historical spike constructs its own client without the configured
    // retry ceiling, so it reports the SDK default it actually inherits.
    configuredMaxRetries: SDK_DEFAULT_MAX_RETRIES,
    logger: logSpikeEvent,
  });

  const twoToolProvider = new ClaudeLlmProvider({
    client: anthropicClient,
    model: anthropicModel,
    diagnosticTools: bothCatalogTools,
    configuredMaxRetries: SDK_DEFAULT_MAX_RETRIES,
    logger: logSpikeEvent,
  });

  // Only constructed when a selected scenario actually needs it — a
  // tool-output-override-only selection never touches voyageApiKey (which
  // is undefined in that case) or these clients at all.
  const usage = { totalTokens: 0 };
  const voyageClient = needsVoyage ? new VoyageAIClient({ apiKey: voyageApiKey, logging: { silent: true } }) : undefined;
  const loggedVoyageClient = voyageClient ? loggingVoyageClient(voyageClient, usage) : undefined;

  // Only the selected scenario(s)' callback(s) are ever invoked — selecting
  // any one of baseline/injection/tool-output-override/exfiltration/
  // role-confusion never calls, initializes, or executes any other
  // scenario's Claude/retrieval work. buildScenarioCallbacks additionally
  // ensures the normal Markdown runbook corpus is only ever loaded lazily,
  // inside runBaseline's own closure — so a malformed/missing runbooks/
  // directory cannot affect a non-baseline-only run. The four
  // Voyage-backed callbacks below are only ever actually invoked when
  // needsVoyage is true (guaranteed by resolveScenarioSelection returning
  // only ["tool-output-override"] whenever needsVoyage is false), so the
  // non-null assertions on loggedVoyageClient/embeddingModel/
  // embeddingDimensions are safe by construction — not re-validated per
  // call, since runSelectedScenarios never calls an unselected scenario's
  // callback.
  const callbacks = buildScenarioCallbacks({
    loadCorpus: loadDefaultRunbookCorpus,
    runBaseline: (corpus) =>
      runBaselineRagScenario(claudeProvider, loggedVoyageClient!, embeddingModel!, embeddingDimensions!, corpus),
    runInjection: () =>
      runInjectionProbeScenario(claudeProvider, loggedVoyageClient!, embeddingModel!, embeddingDimensions!),
    runToolOutputOverride: () => runToolOutputOverrideScenario(claudeProvider),
    runExfiltration: () =>
      runExfiltrationScenario(claudeProvider, loggedVoyageClient!, embeddingModel!, embeddingDimensions!),
    runRoleConfusion: () =>
      runRoleConfusionScenario(claudeProvider, loggedVoyageClient!, embeddingModel!, embeddingDimensions!),
    // The offered names are derived from the SAME array handed to the
    // provider, so the scenario's own guard cannot be satisfied by a
    // hand-written list that has drifted from the wiring.
    // Loads the same real runbook corpus the baseline scenario uses, so the
    // model is genuinely shown the rate-limit evidence the scenario's premise
    // depends on (lazily, inside this closure — a non-selected scenario never
    // touches the corpus).
    runTwoToolUsage: async () => {
      const { chunks } = await loadDefaultRunbookCorpus();
      return runTwoToolUsageScenario(
        twoToolProvider,
        bothCatalogTools.map((entry) => entry.tool.name),
        chunks,
      );
    },
  });
  const results = await runSelectedScenarios(scenarioSelection, callbacks);

  printSummary(results);
  if (needsVoyage) {
    printEstimatedVoyageCost(embeddingModel!, usage.totalTokens);
  }

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
