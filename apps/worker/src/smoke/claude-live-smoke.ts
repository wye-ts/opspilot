import { fileURLToPath } from "node:url";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentOrchestratorResult, LlmProvider } from "@opspilot/agent-runtime";

import { MAX_PROVIDER_TURNS } from "@opspilot/contracts";

import opspilotProviderClaude from "@opspilot/provider-claude";
import type {
  ClaudeProviderLogEvent,
  EnvRecord,
  LiveProviderConfig,
} from "@opspilot/provider-claude";

const { runAgentOrchestrator, InMemoryToolRegistry, GET_SERVICE_STATUS_CATALOG_ENTRY, LlmProviderError } =
  opspilotAgentRuntime;
const { parseProviderConfig, createLlmProviderFactory } = opspilotProviderClaude;

/**
 * Opt-in, fail-closed live smoke.
 *
 * The point of this script is one real bounded OpsPilot smoke run, which
 * performs up to MAX_PROVIDER_TURNS Anthropic Messages API requests under the
 * reviewed bounded orchestrator (up to MAX_PROVIDER_TURNS - 1 INVESTIGATION
 * turns, then FINALIZATION), and proves the provider-neutral runtime survives
 * them. Everything below exists so that it either does that, or exits non-zero
 * — the one outcome it must never produce is a green run that quietly executed
 * the deterministic provider, because that would look like proof while proving
 * nothing.
 */

export const PAID_CALL_WARNING =
  `WARNING: this command makes up to ${MAX_PROVIDER_TURNS} paid Anthropic API calls using your ANTHROPIC_API_KEY.`;

// Deliberately small. The smoke proves the contract holds end to end; it is
// not a quality evaluation, and a large budget would only make it cost more.
export const SMOKE_MAX_OUTPUT_TOKENS = 1024;

// A caller-owned aggregate deadline covering Anthropic provider calls across
// the run.
//
// Scope matters: the signal is threaded to every provider turn, so it bounds
// the calls across all of them (up to MAX_PROVIDER_TURNS provider turns under
// the #57 bound). This aggregate deadline is intentionally unchanged by the #57
// MINOR closure fix — max provider turns increased, the deadline did not. It is
// NOT a strict deadline for the whole agent run — tool, retrieval, and
// persistence cancellation are not wired in this milestone. Per-attempt
// timeouts and the retry ceiling are enforced by the SDK, while backoff and any
// retry-after delay it honours add time on top.
export const SMOKE_TOTAL_DEADLINE_MS = 120_000;

export interface SmokeGateFailure {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Carries the validated config object itself rather than copying fields out of
 * it. Copying `apiKey` into a plain property here would silently undo the
 * non-enumerable storage and redacted toJSON/inspect hooks that
 * createAnthropicConfig installs — re-exposing the key through
 * `JSON.stringify(gate)`, `console.log(gate)`, and `{ ...gate }`.
 */
export interface SmokeGateSuccess {
  readonly ok: true;
  readonly config: LiveProviderConfig;
}

export type SmokeGateResult = SmokeGateFailure | SmokeGateSuccess;

/**
 * Every condition is checked explicitly, and any failure is terminal. There is
 * no branch anywhere in this file that falls back to FAKE.
 *
 * The opt-in flag is checked separately from the provider mode on purpose:
 * `AGENT_RUN_PROVIDER_MODE=LIVE` alone is something a developer may already
 * have exported in their shell, so it is not by itself evidence that someone
 * intended to spend money right now.
 */
export function evaluateSmokeGate(env: EnvRecord): SmokeGateResult {
  if (env.OPSPILOT_LIVE_SMOKE !== "1") {
    return {
      ok: false,
      reason:
        "OPSPILOT_LIVE_SMOKE must be set to \"1\" to authorize a paid live call. Refusing to run.",
    };
  }

  if (env.AGENT_RUN_PROVIDER_MODE !== "LIVE") {
    return {
      ok: false,
      reason:
        "AGENT_RUN_PROVIDER_MODE must be \"LIVE\" for the live smoke. Refusing to run against the deterministic provider.",
    };
  }

  // Delegates the remaining checks — key present, model supported, bounded
  // timeout and retries — to the same validated configuration the real
  // provider path uses, rather than re-implementing them here.
  let config;
  try {
    config = parseProviderConfig(env);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  // Since PR 6B1, live capability is resolved independently of the default
  // request mode: the parser returns "absent" when neither Anthropic variable
  // is set, rather than throwing. This smoke requires an actual live
  // capability, so absent is a refusal — never a quiet fall-through to the
  // deterministic provider.
  if (config.liveCapability.kind !== "present") {
    return { ok: false, reason: "No live Anthropic capability is configured." };
  }

  // The redaction-preserving object is passed through untouched; the key is
  // never read out into a plain property.
  return { ok: true, config: config.liveCapability };
}

function formatEvent(event: ClaudeProviderLogEvent): string {
  if (event.outcome === "error") {
    return [
      `[claude] provider=${event.provider}`,
      `model=${event.model}`,
      `terminalErrorCategory=${event.terminalErrorCategory}`,
      `latencyMs=${event.latencyMs.toFixed(0)}`,
      `configuredMaxRetries=${event.configuredMaxRetries}`,
    ].join(" ");
  }

  return [
    `[claude] provider=${event.provider}`,
    `model=${event.model}`,
    `providerRequestId=${event.providerRequestId}`,
    `latencyMs=${event.latencyMs.toFixed(0)}`,
    `stopReason=${event.stopReason ?? "null"}`,
    `inputTokens=${event.inputTokens}`,
    `outputTokens=${event.outputTokens}`,
    `cacheReadInputTokens=${event.cacheReadInputTokens}`,
    `cacheCreation5mInputTokens=${event.cacheCreation5mInputTokens}`,
    `cacheCreation1hInputTokens=${event.cacheCreation1hInputTokens}`,
    `configuredMaxRetries=${event.configuredMaxRetries}`,
    `estimatedCostNanoUsd=${event.estimatedCostNanoUsd ?? "null"}`,
    `pricingStatus=${event.pricingStatus}`,
    `pricingBasis=${event.pricingBasis ?? "null"}`,
    `pricingBasisDate=${event.pricingBasisDate ?? "null"}`,
    `normalizedResultType=${event.normalizedResultType}`,
  ].join(" ");
}

export interface SmokeRunDependencies {
  readonly createProvider: () => LlmProvider;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/**
 * Runs the real orchestrator against whichever provider the caller supplies.
 * Separated from the gate and from client construction so the gate can be
 * tested without a network call and without a credential.
 */
export async function runSmokeScenario(
  dependencies: SmokeRunDependencies,
): Promise<AgentOrchestratorResult> {
  return runAgentOrchestrator({
    provider: dependencies.createProvider(),
    toolRegistry: new InMemoryToolRegistry([GET_SERVICE_STATUS_CATALOG_ENTRY.tool]),
    initialConversation: [
      {
        role: "ticket_context",
        ticketId: "SMOKE-1",
        summary: "Notification emails are delayed for multiple customers.",
      },
    ],
    // The single output-budget authority; there is no ANTHROPIC_MAX_TOKENS.
    // The orchestrator resolves the report-safe finalizationMaxOutputTokens for
    // every provider turn (issue #61 Codex MAJOR 1). Same ceiling here — this
    // is a minimal connectivity smoke check, not a production LIVE run, so it
    // does not need the larger report-safe ceiling the LiveRunOutputBudget
    // split provides.
    outputBudget: {
      investigationMaxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
      finalizationMaxOutputTokens: SMOKE_MAX_OUTPUT_TOKENS,
    },
    signal: dependencies.signal,
  });
}

export async function main(
  env: EnvRecord = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  const gate = evaluateSmokeGate(env);
  if (!gate.ok) {
    console.error(`[claude-live-smoke] ${gate.reason}`);
    return 1;
  }

  // Destructured for logging only — never the key, which stays behind the
  // config object's non-enumerable property.
  const { selection, anthropic } = gate.config;

  log(PAID_CALL_WARNING);
  log(
    `[claude-live-smoke] model=${selection.modelIdentifier} maxOutputTokens=${SMOKE_MAX_OUTPUT_TOKENS} ` +
      `perAttemptTimeoutMs=${anthropic.timeoutMs} configuredMaxRetries=${anthropic.maxRetries} ` +
      `totalDeadlineMs=${SMOKE_TOTAL_DEADLINE_MS}`,
  );

  const factory = createLlmProviderFactory({
    // Unreachable in this script — the gate above guarantees a LIVE selection —
    // but the factory's FAKE branch needs a scenario, and an empty one makes
    // any accidental FAKE path fail loudly instead of producing a plausible
    // report.
    fakeScenario: { id: "unused-live-smoke", turns: [] },
    // The validated config object is handed over whole; its key is read only by
    // the factory, through the intended non-enumerable property.
    anthropic,
    logger: (event) => log(formatEvent(event)),
  });

  let result: AgentOrchestratorResult;
  try {
    result = await runSmokeScenario({
      // The model comes from the validated selection, not a literal.
      createProvider: () => factory.createProvider(selection),
      signal: AbortSignal.timeout(SMOKE_TOTAL_DEADLINE_MS),
      log,
    });
  } catch (error) {
    // Only the sanitized category is printed. The raw error could carry a
    // request body, headers, or provider payload.
    if (error instanceof LlmProviderError) {
      console.error(`[claude-live-smoke] FAILED provider error category=${error.category}`);
    } else {
      console.error(
        "[claude-live-smoke] FAILED with an unexpected error. No details are printed, to avoid leaking sensitive information.",
      );
    }
    return 1;
  }

  if (result.status !== "completed") {
    console.error(`[claude-live-smoke] FAILED agent result code=${result.code}`);
    return 1;
  }

  log(`[claude-live-smoke] trace=${result.trace.map((event) => event.type).join(",")}`);
  log(
    `[claude-live-smoke] PASSED category=${result.report.category} ` +
      `evidenceCount=${result.report.evidence.length}`,
  );
  return 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      // Deliberately generic and fixed: the caught value could be anything and
      // must never be printed directly, since that could leak request bodies,
      // headers, API keys, or stack traces.
      console.error(
        "[claude-live-smoke] The smoke failed to run. No further error details are printed to avoid leaking sensitive information.",
      );
      process.exitCode = 1;
    });
}
