/**
 * Completion-rate measurement (local, ANTHROPIC_API_KEY only).
 *
 * WHAT THIS ANSWERS
 *
 * `docs/reviews/40-issue-105-report-failure-attribution-plan.md` recorded 8
 * deployed LIVE runs on 2026-09-14/15, after #101 merged:
 *
 *     2 COMPLETED, 5 REPORT_SCHEMA_INVALID, 1 PROVIDER_UNAVAILABLE
 *
 * i.e. a 25% completion rate, with only 1 of the 5 schema failures
 * attributable (via a temporary debug print). Three fixes landed afterwards
 * and NONE has been measured against a real model:
 *
 *   - #106 attributes REPORT_SCHEMA_INVALID to the invariant that caused it
 *   - #107 widened the turn budget from 4/3 to 5/3
 *   - #115 auto-completes evidence for real groundedBy omissions (F5), the
 *     shape #105 identified as dominant
 *
 * This script re-measures that rate.
 *
 * WHAT IT DOES *NOT* ANSWER
 *
 * It runs the orchestrator in-process, exactly as `spike:rag` does — NOT
 * through the deployed API. That is deliberate: the deployed path consumes
 * the public-trial visitor quota, and report validation plus the F5
 * auto-completion both live in `runAgentOrchestrator`, which both paths share
 * (`agent-run-service.ts` calls the same function and only reads the failure
 * code afterwards for attribution). So this measures the same validation
 * logic without spending a visitor slot.
 *
 * It therefore measures the completion rate of THESE tickets, not of real
 * visitor traffic. The tickets below are ordinary operational reports written
 * to match the deployed composer's shape, not adversarial probes — but they
 * are generated from a fixed template space rather than sampled from real
 * traffic, and a rate measured on them is evidence about the
 * validation path, not a forecast of visitor behavior.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... pnpm --filter @opspilot/worker run measure:completion-rate
 *   RUN_COUNT=5 ... (default 5)
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentConversationMessage, RunAbortContext } from "@opspilot/agent-runtime";
import opspilotProviderClaude, { DEFAULT_TIMEOUT_MS } from "@opspilot/provider-claude";
import { generateTickets, TICKET_COMBINATION_COUNT } from "./completion-rate-tickets";
import {
  InMemoryKeywordRunbookRetriever,
  DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE,
  loadDefaultRunbookCorpus,
} from "../rag";
import {
  InMemoryToolRegistry,
  getServiceStatusTool,
  getRecentDeploymentsTool,
  DIAGNOSTIC_TOOL_CATALOG,
} from "../tools";

const { runAgentOrchestrator, LlmProviderError, resolveAbortProvenance } =
  opspilotAgentRuntime;
const { ClaudeLlmProvider, requireSupportedClaudeModel } = opspilotProviderClaude;

/** Hard ceiling on billed runs per invocation. */
export const MAX_RUN_COUNT = 25;

/**
 * The output ceilings a deployed LIVE run uses (LIVE_RUN_DEFAULTS in
 * apps/api/src/execution/run-execution-config.ts). agent-runtime's default is
 * 4096/4096 — MORE generous on both turns — so omitting this lets the model
 * produce a report the deployed path would have truncated. Same failure
 * direction as every other apparatus defect found here: silently favourable.
 */
export const LIVE_RUN_OUTPUT_BUDGET_DEFAULTS = {
  investigationMaxOutputTokens: 1024,
  finalizationMaxOutputTokens: 3072,
} as const;

/**
 * Resolves the budget the way apps/api does.
 *
 * Hardcoding the defaults made the measurement ignore the same overrides
 * deployment honours: with LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS=2048 set,
 * a report needing 2500 tokens completes here and truncates in production.
 * Same failure direction as every other apparatus defect in this file —
 * quietly more generous than the thing being measured.
 */
export function resolveOutputBudget(env: NodeJS.ProcessEnv = process.env): {
  investigationMaxOutputTokens: number;
  finalizationMaxOutputTokens: number;
} {
  const investigationMaxOutputTokens = parseBoundedEnvInteger(
    env.LIVE_RUN_MAX_OUTPUT_TOKENS,
    LIVE_RUN_OUTPUT_BUDGET_DEFAULTS.investigationMaxOutputTokens,
    256,
    4096,
    "LIVE_RUN_MAX_OUTPUT_TOKENS",
  );

  const raw = env.LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS?.trim();
  if (raw === undefined || raw === "") {
    // Production's default is max(3072, investigation), NOT a flat 3072: the
    // forced finalization turn must never get a smaller ceiling than an
    // investigation turn. Resolving it as a constant made the measurement
    // stricter than deployment when investigation was raised.
    return {
      investigationMaxOutputTokens,
      finalizationMaxOutputTokens: Math.max(
        LIVE_RUN_OUTPUT_BUDGET_DEFAULTS.finalizationMaxOutputTokens,
        investigationMaxOutputTokens,
      ),
    };
  }

  const finalizationMaxOutputTokens = parseBoundedEnvInteger(
    raw,
    LIVE_RUN_OUTPUT_BUDGET_DEFAULTS.finalizationMaxOutputTokens,
    1024,
    8192,
    "LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS",
  );
  if (finalizationMaxOutputTokens < investigationMaxOutputTokens) {
    // Production refuses this combination at boot; accepting it would measure
    // a configuration that cannot be deployed.
    throw new MeasurementConfigurationError(
      "LIVE_RUN_FINALIZATION_MAX_OUTPUT_TOKENS must be greater than or equal to " +
        "LIVE_RUN_MAX_OUTPUT_TOKENS",
    );
  }
  return { investigationMaxOutputTokens, finalizationMaxOutputTokens };
}

/**
 * The deployed per-run provider deadline (DEFAULT_PROVIDER_DEADLINE_MS in
 * apps/api/src/execution/run-abort-context.ts). It spans the WHOLE run, not one
 * call: three 41-second turns each clear a 45s per-call timeout while busting a
 * shared 120s budget, so a per-call timeout alone does not reproduce it.
 */
export const LIVE_RUN_PROVIDER_DEADLINE_DEFAULT_MS = 120_000;

/** Resolves the per-run deadline from the same variable apps/api reads. */
export function resolveProviderDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedEnvInteger(
    env.AGENT_RUN_PROVIDER_DEADLINE_MS,
    LIVE_RUN_PROVIDER_DEADLINE_DEFAULT_MS,
    // MIN_PROVIDER_DEADLINE_MS in apps/api — a 1000ms floor would accept
    // deadlines production rejects at boot.
    5_000,
    600_000,
    "AGENT_RUN_PROVIDER_DEADLINE_MS",
  );
}

/**
 * A configuration error whose message this file authors in full.
 *
 * The top-level handler refuses to print caught error VALUES because a
 * provider error can carry request bodies, headers or an API key. That rule is
 * right, but it was also swallowing the validators' own messages, so
 * `TICKET_SEED=abc` reported only "an Error occurred" while the actionable
 * text — which variable, which bounds — was discarded. Messages of this class
 * are string literals built from the variable NAME and its numeric bounds:
 * never from the environment value, the provider, or the network.
 */
export class MeasurementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementConfigurationError";
  }
}

/**
 * Codes meaning the run did not produce a report for reasons OUTSIDE report
 * quality.
 *
 * Deliberately NOT called "provider-side": PROVIDER_UNAVAILABLE collapses
 * AUTHENTICATION, BILLING and REQUEST_INVALID together with genuine outages
 * (see issue #123), and PROVIDER_TIMEOUT/PROVIDER_CANCELLED can be a local
 * deadline rather than an upstream fault. This investigation already made that
 * mistake once, reporting a spend-limit rejection as an upstream outage. The
 * set is sound for its ACTUAL purpose — these runs cannot speak to report
 * quality — and unsound as a claim about whose fault it was.
 *
 * Module scope because the exclusion branch and the tally MUST use one
 * predicate: when they diverged, a PROVIDER_TIMEOUT was excluded from the
 * sample while the tally still read 0 provider issues — a billed run visible
 * nowhere.
 */
export /**
 * Categories meaning the fault is OURS, not the provider's.
 *
 * A run failing for these reasons says nothing about report quality AND
 * invalidates the round: continuing would produce a rate computed over
 * whichever runs happened to precede a billing or auth failure. They are
 * indistinguishable from a real outage at the orchestrator's error code and
 * distinguishable only in the adapter's log event.
 */
const OUR_FAULT_CATEGORIES = new Set(["BILLING", "AUTHENTICATION", "REQUEST_INVALID"]);

export const NON_REPORT_BEARING_CODES = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_CANCELLED",
]);

/**
 * The deployed request rate (LIVE_RUN_DEFAULTS in apps/api): rateLimitMax 2
 * per rateLimitWindowMs 60_000, with maxConcurrency 1.
 *
 * Omitting this let a 15-run round fire in 85 seconds — roughly ten times the
 * deployed rate. A visitor cannot produce that burst, so the round measured a
 * request pattern deployment does not allow.
 */
export const LIVE_RUN_RATE_LIMIT_DEFAULTS = { max: 2, windowMs: 60_000 } as const;

/**
 * Resolves the rate the way apps/api does.
 *
 * Hardcoding 2/60s made the measurement ignore the overrides deployment
 * honours: with LIVE_RUN_RATE_LIMIT_MAX=1 configured, production allows one
 * request a minute while the measurement kept firing every 30 seconds. Same
 * shape as the budget and deadline defects before it — parity with a DEFAULT
 * is not parity with a CONFIGURATION.
 */
export function resolveRateLimit(env: NodeJS.ProcessEnv = process.env): {
  max: number;
  windowMs: number;
} {
  return {
    max: parseBoundedEnvInteger(
      env.LIVE_RUN_RATE_LIMIT_MAX,
      LIVE_RUN_RATE_LIMIT_DEFAULTS.max,
      1,
      60,
      "LIVE_RUN_RATE_LIMIT_MAX",
    ),
    windowMs: parseBoundedEnvInteger(
      env.LIVE_RUN_RATE_LIMIT_WINDOW_MS,
      LIVE_RUN_RATE_LIMIT_DEFAULTS.windowMs,
      1_000,
      3_600_000,
      "LIVE_RUN_RATE_LIMIT_WINDOW_MS",
    ),
  };
}

/** Minimum spacing between runs implied by a resolved rate. */
export function minRunIntervalMs(rate: { max: number; windowMs: number }): number {
  return Math.ceil(rate.windowMs / rate.max);
}

/** Production bounds for ANTHROPIC_TIMEOUT_MS (claude-config.ts). */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/**
 * Validates a numeric environment override against production bounds. An
 * unvalidated ANTHROPIC_TIMEOUT_MS=0 disables the SDK timeout entirely and a
 * non-numeric TICKET_SEED becomes NaN, which the PRNG coerces to seed 0 and the
 * artefact serialises as null — a non-reproducible round that still prints a
 * plausible result.
 */
export function parseBoundedEnvInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MeasurementConfigurationError(
      `${name} must be an integer in ${min}..${max}`,
    );
  }
  return value;
}

/**
 * The retry count a deployed LIVE run always has. Enforced at boot by
 * assertNoOpaqueRetriesOnProtectedLivePath() in
 * apps/api/src/execution/run-execution-config.ts,
 * which throws unless ANTHROPIC_MAX_RETRIES === 0 while LIVE runs are enabled.
 * Pinned here rather than read from the environment so this measurement cannot
 * silently become more permissive than the path it claims to measure.
 */
export const LIVE_RUN_MAX_RETRIES = 0;

/**
 * A NaN, zero, negative or fractional RUN_COUNT would skip the loop and print
 * "0/0 COMPLETED" as a clean success — a measurement that silently measured
 * nothing. An unbounded one would bill without a ceiling. Both are rejected.
 */
export function parseRunCount(raw: string | undefined): number {
  const trimmed = raw?.trim();
  const value = trimmed === undefined || trimmed === "" ? 5 : Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUN_COUNT) {
    throw new MeasurementConfigurationError(
      `RUN_COUNT must be an integer in 1..${MAX_RUN_COUNT}`,
    );
  }
  return value;
}

/**
 * Categories that represent a genuine, transient upstream problem — the only
 * ones a completion-rate sample may legitimately contain, since a deployed run
 * could hit them too.
 *
 * Everything else in LlmProviderErrorCategory is a CONFIGURATION or CODE
 * problem on our side: AUTHENTICATION (bad key), BILLING (no credit),
 * REQUEST_INVALID (a malformed request we built), CANCELLED (we aborted),
 * UNKNOWN (unclassified — by definition not a confirmed outage). Recording
 * those as ordinary failures would let a broken setup masquerade as a measured
 * result, which is the same fail-quietly defect the rethrow above exists to
 * prevent.
 */
const TRANSIENT_OUTAGE_CATEGORIES = new Set(["RATE_LIMIT", "CONNECTION", "TIMEOUT", "SERVER_ERROR"]);

/**
 * Whether a thrown value is a real, transient provider outage (a legitimate
 * ledger row). Anything else — including a non-transient LlmProviderError —
 * must void the measurement rather than be counted as an ordinary failure.
 */
export function isProviderOutage(error: unknown): error is InstanceType<typeof LlmProviderError> {
  return error instanceof LlmProviderError && TRANSIENT_OUTAGE_CATEGORIES.has(error.category);
}

/** Mirrors RETRIEVAL_TOP_K in apps/api/src/execution/retrieval-input.ts. */
const DEPLOYED_RETRIEVAL_TOP_K = 3;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  // The NAME of a missing variable, never its value.
  if (!value) throw new MeasurementConfigurationError(`${name} must be set`);
  return value;
}

/**
 * Tickets are GENERATED, not hand-written. The previous version cycled five
 * fixed tickets with `TICKETS[i % 5]`, so a 15-run round was five tickets three
 * times over rather than fifteen samples. See completion-rate-tickets.ts.
 */
const TICKET_SEED = parseBoundedEnvInteger(
  process.env.TICKET_SEED,
  20260919,
  0,
  2_147_483_647,
  "TICKET_SEED",
);

/**
 * One provider-level error, captured from the adapter's log channel.
 *
 * PROVIDER_UNAVAILABLE collapses six categories (issue #123), so the
 * orchestrator code alone cannot explain an excluded run. These fields can:
 * errorSource separates an unclassified SDK exception from a 200 response
 * missing _request_id, and errorClass/errorStatus name the exception without
 * including any message text.
 */
interface ProviderErrorRecord {
  readonly at: string;
  readonly errorSource: string;
  readonly terminalErrorCategory: string;
  readonly errorClass: string | null;
  readonly errorStatus: number | null;
  readonly latencyMs: number;
}

interface RunOutcome {
  readonly ticketId: string;
  readonly ticketSummary: string;
  readonly ticketParameters: Record<string, unknown>;
  readonly status: string;
  readonly failureCode?: string;
  /**
   * The provider's own message.
   *
   * PROVIDER_UNAVAILABLE collapses RATE_LIMIT, BILLING, AUTHENTICATION,
   * CONNECTION, SERVER_ERROR and REQUEST_INVALID (issue #123), so the code
   * alone cannot say why a run was excluded. A round where 11 of 15 runs were
   * excluded could not be diagnosed from the artefact at all — the cause had
   * to be guessed. The orchestrator already returns this message; the
   * measurement simply was not keeping it.
   */
  readonly failureMessage?: string;
  /** Which invariant Zod rejected — the capability #106 added. */
  readonly validationMessages: readonly string[];
  /** Evidence entries #115 synthesized; a non-empty list means F5 was healed. */
  readonly autoCompletedEvidence: number;
  /** Retrieved chunk ids — part of what the model was shown. "Only a full
   *  trajectory distinguishes
   *  a harness defect from a model regression" (evaluation ch.7). */
  readonly retrievedChunkIds: readonly string[];
  readonly toolCallsMade: readonly string[];
}


/**
 * Summarises tool activity from a trace.
 *
 * KNOWN LIMIT, stated because the artefact must not overclaim: the trace
 * contract (packages/contracts/src/agent-trace-event.ts) carries only
 * `toolCallId` and `toolName` on TOOL_REQUESTED/TOOL_COMPLETED. Tool INPUTS
 * and OUTPUTS are not in it. So two runs where the model queried different
 * services are indistinguishable here, and this is a call LEDGER rather than
 * the full trajectory. Recording the ids at least distinguishes "called the
 * same tool twice" from "called it once", which the bare name list did not.
 *
 * Widening the contract is a product change affecting persisted rows, out of
 * scope for a measurement script — noted in docs/reviews/48 instead of being
 * papered over here.
 */
function summarizeToolCalls(
  trace: readonly { readonly type: string; readonly toolName?: string; readonly toolCallId?: string }[],
): string[] {
  return trace.flatMap((event) =>
    event.type === "TOOL_COMPLETED" && event.toolName !== undefined
      ? [`${event.toolName}#${event.toolCallId ?? "unknown"}`]
      : [],
  );
}

/**
 * Writes the artefact and returns its path.
 *
 * Called after EVERY run, not only at the end. A round that dies on run 12 of
 * 15 otherwise discards eleven billed runs of evidence — the same "lose the
 * paid data" defect that cost this investigation round D's failure
 * attribution, just relocated to a crash path. The file is rewritten in place
 * each time, so a partial round is still a readable artefact.
 */
function writeArtefact(artefact: { readonly startedAt: string }): string {
  const outputDir = resolve(import.meta.dirname, "../../../../docs/measurements");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(
    outputDir,
    `completion-rate-${artefact.startedAt.replace(/[:.]/g, "-")}.json`,
  );
  // Write to a sibling temp file, then rename. writeFileSync truncates the
  // destination BEFORE writing, so an in-place rewrite that fails midway (disk
  // full, process killed between flushes) destroys the last good snapshot —
  // the persistence added to prevent data loss would itself become a way to
  // lose it. rename(2) within a directory is atomic, so a reader sees either
  // the previous complete artefact or the new one, never a truncated file.
  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(artefact, null, 2), "utf8");
  renameSync(tempPath, outputPath);
  return outputPath;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL?.trim() ?? "claude-sonnet-5");
  const runCount = parseRunCount(process.env.RUN_COUNT);

  const { chunks } = await loadDefaultRunbookCorpus();
  const retriever = new InMemoryKeywordRunbookRetriever(chunks, DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE);

  // Match the DEPLOYED LIVE policy. Two earlier versions got this wrong in the
  // same direction — more permissive than deployment — so a completion this
  // script recorded could be one the deployed path would never have reached.
  //
  // DEFAULT_MAX_RETRIES (1) is NOT the deployed LIVE value. run-execution-config.ts
  // REFUSES TO BOOT unless ANTHROPIC_MAX_RETRIES === 0 whenever
  // LIVE_AGENT_RUNS_ENABLED is true: a retried attempt may have reached the
  // provider and been billed without being observable, so a live run's cost
  // could not be reported honestly. Every deployed LIVE run therefore has
  // exactly one provider attempt, and this measurement must too.
  const rateLimit = resolveRateLimit();
  const runIntervalMs = minRunIntervalMs(rateLimit);
  const outputBudget = resolveOutputBudget();
  const providerDeadlineMs = resolveProviderDeadlineMs();
  const timeoutMs = parseBoundedEnvInteger(
    process.env.ANTHROPIC_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "ANTHROPIC_TIMEOUT_MS",
  );
  const maxRetries = LIVE_RUN_MAX_RETRIES;
  // Rebuilt on a connection-class failure rather than constructed once.
  //
  // KNOWN INSUFFICIENT — kept deliberately, with its result recorded.
  //
  // A TLS record fault destroys the SDK's HTTP/2 session, after which requests
  // fail in about a millisecond without leaving the machine (issue #125).
  // Rebuilding the client was the obvious remedy and it DOES NOT WORK: a
  // measured round rebuilt three times and still failed at 5.1ms and 3.9ms.
  // The broken state is therefore not owned by the client object — every fetch
  // in the process shares Node's global undici dispatcher regardless of how
  // many clients exist.
  //
  // Left in place because it is harmless and because removing it would delete
  // the evidence that this approach was tried and measured. The fault is also
  // INTERMITTENT: some rounds never hit it, one hit it from run 1, several
  // from run 5. What triggers it is not known.
  const buildClient = (): Anthropic =>
    new Anthropic({
      apiKey,
      logLevel: "off",
      timeout: timeoutMs,
      maxRetries,
    });

  let anthropicClient = buildClient();
  // Every provider error event of the round, in order. The adapter puts the
  // only fields that can classify a PROVIDER_UNAVAILABLE here —
  // terminalErrorCategory, errorSource, errorClass, errorStatus — and the
  // measurement previously configured no logger, so a round where 11 of 15
  // runs failed could not say why any of them did.
  const providerErrors: ProviderErrorRecord[] = [];

  // Set by the logger when the adapter reports a connection-class failure, and
  // consumed by the loop to rebuild the client before the next run.
  let sawConnectionFault = false;
  let sawOurFault: string | null = null;

  const buildProvider = (): InstanceType<typeof ClaudeLlmProvider> =>
    new ClaudeLlmProvider({
    client: anthropicClient,
    model,
    configuredMaxRetries: maxRetries,
    diagnosticTools: DIAGNOSTIC_TOOL_CATALOG,
    logger: (event) => {
      if (event.outcome !== "error") return;
      const record: ProviderErrorRecord = {
        at: new Date().toISOString(),
        // Distinguishes an unclassified SDK exception from an HTTP 200 whose
        // body omitted _request_id — both terminate as UNKNOWN and were
        // otherwise indistinguishable.
        errorSource: event.errorSource,
        terminalErrorCategory: event.terminalErrorCategory,
        // A constructor name only. The adapter deliberately never logs
        // error.message, which for an APIError can embed the raw response
        // body, so this stays safe to persist.
        errorClass: event.errorClass,
        errorStatus: event.errorStatus,
        latencyMs: event.latencyMs,
      };
      providerErrors.push(record);
      // APIConnectionError means the request never reached Anthropic. On this
      // client that is terminal: the HTTP/2 session is gone and will not come
      // back (issue #125).
      if (record.errorClass === "APIConnectionError") sawConnectionFault = true;
      // OUR OWN configuration failing is not a measurement outcome. The
      // orchestrator reports all of these as PROVIDER_UNAVAILABLE (issue
      // #123), so without the logger's category the round would quietly
      // exclude them and report a rate — the exact mistake this investigation
      // made once already, reading a spend-limit rejection as an upstream
      // outage. With the category in hand there is no excuse for it.
      if (OUR_FAULT_CATEGORIES.has(record.terminalErrorCategory)) {
        sawOurFault = record.terminalErrorCategory;
      } else if (
        record.terminalErrorCategory === "UNKNOWN" &&
        record.errorClass !== "APIConnectionError"
      ) {
        // UNKNOWN means the adapter could NOT classify the failure — it may be
        // ours or the provider's. Excluding it would let an unexplained
        // failure silently shrink the denominator, which is the same error as
        // excluding a billing failure, one step further out.
        //
        // APIConnectionError is the exception: it is UNKNOWN by category but
        // its cause IS understood (issue #125) and it is handled by rebuilding.
        // Voiding on it would make every round void, since it accounted for 35
        // of 49 invocations.
        sawOurFault = `UNKNOWN (${String(record.errorClass)}) — unclassified, cause not established`;
      }
      console.log(
        `  provider error: category=${record.terminalErrorCategory} ` +
          `source=${record.errorSource} class=${String(record.errorClass)} ` +
          `status=${String(record.errorStatus)} latencyMs=${record.latencyMs}`,
      );
    },
  });

  let provider = buildProvider();
  let clientRebuilds = 0;
  console.log(`provider policy: timeoutMs=${timeoutMs} maxRetries=${maxRetries} (deployed defaults)`);

  const tickets = generateTickets(runCount, TICKET_SEED);
  console.log(
    `tickets: ${runCount} distinct, seed=${TICKET_SEED} ` +
      `(of ${TICKET_COMBINATION_COUNT} possible combinations)`,
  );

  const outcomes: RunOutcome[] = [];
  const excluded: string[] = [];
  let lastRunStartedAt = 0;

  // Built before the loop and flushed after EVERY run, so a crash on run 12 of
  // 15 still leaves eleven billed runs on disk. `completedAt` stays null until
  // the round finishes, which is how a reader tells a partial artefact from a
  // complete one.
  const artefact: {
    schemaVersion: number;
    startedAt: string;
    completedAt: string | null;
    executionProtocol: Record<string, unknown>;
    scoringRule: Record<string, string>;
    tallies: Record<string, number> | null;
    excludedTickets: string[];
    providerErrors: ProviderErrorRecord[];
    clientRebuilds: number;
    runs: RunOutcome[];
  } = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    completedAt: null,
    executionProtocol: {
      model,
      maxRetries,
      timeoutMs,
      // The RESOLVED values, not the defaults: a reader must be able to tell
      // which budget a given round actually ran under.
      providerDeadlineMs,
      outputBudget,
      rateLimit,
      minRunIntervalMs: runIntervalMs,
      retrievalTopK: DEPLOYED_RETRIEVAL_TOP_K,
      retrievalQueryRule: "ticket summary verbatim (apps/api/src/execution/retrieval-input.ts)",
      ticketSeed: TICKET_SEED,
      requestedRuns: runCount,
    },
    scoringRule: {
      completed: 'orchestrator status === "completed"',
      excluded:
        "PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_CANCELLED — the run did not produce " +
        "a report for reasons outside report quality (the cause is NOT established " +
        "as upstream — issue #123). " +
        "PROVIDER_UNAVAILABLE additionally collapses AUTHENTICATION/BILLING/REQUEST_INVALID, " +
        "so such a run cannot even be shown to have reached the model.",
      voided: "any non-LlmProviderError throw is a defect in this repo, not a measurement outcome",
    },
    tallies: null,
    excludedTickets: excluded,
    // Persisted so a failing round is diagnosable from the artefact alone.
    providerErrors,
    // A round that needed rebuilds hit issue #125 mid-flight. Recorded so the
    // result is never read as if the apparatus ran cleanly.
    clientRebuilds: 0,
    runs: outcomes,
  };

  for (let i = 0; i < runCount; i += 1) {
    const ticket = tickets[i]!;
    const registry = new InMemoryToolRegistry([getServiceStatusTool, getRecentDeploymentsTool]);

    // Pace to the deployed rate. Measured from the START of the previous run,
    // so a slow run consumes its own interval rather than adding to it.
    if (i > 0) {
      const sinceLastStart = Date.now() - lastRunStartedAt;
      const waitMs = runIntervalMs - sinceLastStart;
      if (waitMs > 0) {
        process.stdout.write(`(pacing to the deployed rate: waiting ${Math.ceil(waitMs / 1000)}s)\n`);
        await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      }
    }
    lastRunStartedAt = Date.now();

    if (sawOurFault !== null) {
      // Void, not "excluded". Persist first so the paid runs survive.
      writeArtefact(artefact);
      throw new MeasurementConfigurationError(
        `Round VOID: the provider reported ${sawOurFault}, which is our configuration ` +
          "failing, not a measurement outcome. Fix it and re-run; a rate computed over " +
          "the runs that happened to precede it would be meaningless.",
      );
    }

    if (sawConnectionFault) {
      // Rebuilds the client and the provider that references it. Measured as
      // insufficient (see above) — retained so a round's artefact records
      // that recovery was attempted and did not help.
      anthropicClient = buildClient();
      provider = buildProvider();
      clientRebuilds += 1;
      // Updated on the artefact immediately: it was previously assigned only
      // in the finalization block, so a round that crashed mid-flight
      // persisted clientRebuilds: 0 while having rebuilt several times —
      // under-reporting the very defect the field exists to surface.
      artefact.clientRebuilds = clientRebuilds;
      sawConnectionFault = false;
      console.log("(rebuilding the Anthropic client after a connection fault — issue #125)");
    }

    process.stdout.write(`\n--- run ${i + 1}/${runCount} — ${ticket.id} ---\n`);

    try {
      // Rebuilt per run: the deadline bounds one investigation, not the round.
      const deadlineSignal = AbortSignal.timeout(providerDeadlineMs);
      const abortContext: RunAbortContext = {
        deadlineSignal,
        // No HTTP client here, so nothing can disconnect. A never-aborting
        // signal keeps the shape identical to deployment without inventing an
        // event that cannot occur locally.
        disconnectSignal: new AbortController().signal,
        signal: deadlineSignal,
      };

      const result = await runAgentOrchestrator({
        provider,
        toolRegistry: registry,
        initialConversation: [
          {
            role: "ticket_context",
            ticketId: ticket.id,
            summary: ticket.summary,
          } satisfies AgentConversationMessage,
        ],
        retriever,
        // The deployed LIVE ceilings, not agent-runtime's more generous
        // 4096/4096 defaults.
        outputBudget,
        // The deployed per-RUN deadline, carried in a RunAbortContext exactly
        // as apps/api does. A bare AbortSignal.timeout is NOT equivalent: the
        // deployed path keeps the deadline signal distinguishable from a
        // client disconnect, so resolveAbortProvenance reports a blown
        // deadline as PROVIDER_TIMEOUT. Without the context the same event
        // reaches the tally as PROVIDER_CANCELLED — a mislabelled cause on a
        // measurement whose whole purpose is attribution.
        signal: abortContext.signal,
        // EXACTLY what the deployed path does — apps/api/src/execution/
        // retrieval-input.ts: buildRetrievalInput() passes the ticket summary
        // verbatim with topK 3. A hand-tuned keyword query would hand the
        // model better evidence than any visitor can supply and make the
        // measured rate incomparable to the deployed baseline (caught in
        // review, after a first version did exactly that).
        retrievalInput: { query: ticket.summary, topK: DEPLOYED_RETRIEVAL_TOP_K },
      });

      // The orchestrator collapses AUTHENTICATION / BILLING / REQUEST_INVALID /
      // UNKNOWN into the SAME PROVIDER_UNAVAILABLE code it uses for genuine
      // outages (agent-orchestrator.ts's category switch). So the failure code
      // alone cannot tell a real outage from a broken API key, and the
      // isProviderOutage() guard on the throw path does not help here — this
      // is the orchestrator's normal RETURN path, not a throw.
      //
      // A completion-rate sample must not silently absorb a configuration
      // problem, so a PROVIDER_UNAVAILABLE result is surfaced loudly and
      // EXCLUDED from the denominator rather than recorded as a failed run.
      // Under-reporting the sample size is recoverable; a rate computed over
      // runs that never reached the model is not.
      // The orchestrator CATCHES provider errors and returns a failure code;
      // very little reaches the throw path. So classification has to happen
      // here, on the returned code, or the stated policy is fiction:
      //
      //   PROVIDER_UNAVAILABLE — ambiguous. Collapses real outages together
      //     with AUTHENTICATION/BILLING/REQUEST_INVALID, so a run carrying it
      //     cannot be shown to have reached the model. EXCLUDED.
      //   PROVIDER_TIMEOUT / PROVIDER_CANCELLED — the run did not finish.
      //     May be a LOCAL deadline rather than an upstream fault, so it is
      //     recorded as "did not reach a report", not as a provider failure.
      //     EXCLUDED, and counted rather than silently dropped (PROVIDER_TIMEOUT was previously invisible in the
      //     tallies, and PROVIDER_CANCELLED was counted as an ordinary
      //     report failure).
      // The deployed path resolves an abort-derived code through the context
      // before recording it; without this a blown deadline is recorded as
      // PROVIDER_CANCELLED instead of PROVIDER_TIMEOUT.
      const resolvedCode =
        result.status === "failed"
          ? resolveAbortProvenance(result.code, abortContext)
          : undefined;

      if (
        result.status === "failed" &&
        resolvedCode !== undefined &&
        NON_REPORT_BEARING_CODES.has(resolvedCode)
      ) {
        // Recorded as a full outcome, not just an id: an excluded run can
        // still have retrieved chunks and executed tool calls before the
        // provider failed, and that trajectory is billed evidence. Dropping it
        // is the data loss this artefact exists to prevent.
        outcomes.push({
          ticketId: ticket.id,
          ticketSummary: ticket.summary,
          ticketParameters: ticket.parameters,
          retrievedChunkIds: (result.trace ?? [])
            .filter((event) => event.type === "RETRIEVAL_COMPLETED")
            .flatMap((event) => event.chunks.map((chunk) => chunk.chunkId)),
          toolCallsMade: summarizeToolCalls(result.trace ?? []),
          status: "excluded",
          failureCode: resolvedCode,
          failureMessage: result.message,
          validationMessages: [],
          autoCompletedEvidence: 0,
        });
        console.log(`  provider message: ${result.message}`);
        console.log(
          `status=failed code=${resolvedCode} — EXCLUDED from the sample. ` +
            "The run did not produce a report. The cause is NOT established as " +
            "upstream: this code also covers auth, billing and malformed requests " +
            "(issue #123). Excluded because it cannot speak to report quality.",
        );
        excluded.push(`${ticket.id} (${resolvedCode})`);
        writeArtefact(artefact);
        continue;
      }

      const validationMessages =
        result.status === "failed"
          ? (result.reportValidationIssues ?? [])
              .map((issue) => issue.message ?? `${issue.code}@${issue.path.join(".")}`)
              .filter((m): m is string => typeof m === "string")
          : [];

      // Event names taken from packages/contracts/src/agent-trace-event.ts —
      // the discriminated union is the authority, and a guessed name would
      // silently yield an empty list rather than fail.
      const trace = result.trace ?? [];
      const retrievalChunks = trace.flatMap((event) =>
        event.type === "RETRIEVAL_COMPLETED" ? event.chunks.map((chunk) => chunk.chunkId) : [],
      );
      const toolCalls = summarizeToolCalls(trace);

      outcomes.push({
        ticketId: ticket.id,
        ticketSummary: ticket.summary,
        ticketParameters: ticket.parameters,
        retrievedChunkIds: retrievalChunks,
        toolCallsMade: toolCalls,
        status: result.status,
        ...(result.status === "failed"
          ? { failureCode: result.code, failureMessage: result.message }
          : {}),
        validationMessages,
        autoCompletedEvidence:
          result.status === "completed" ? result.autoCompletedEvidence.length : 0,
      });

      console.log(
        `status=${result.status}` +
          (result.status === "failed" ? ` code=${result.code}` : "") +
          (result.status === "completed"
            ? ` autoCompletedEvidence=${result.autoCompletedEvidence.length}`
            : ""),
      );
      for (const message of validationMessages) console.log(`  invariant: ${message}`);
      writeArtefact(artefact);
    } catch (error) {
      // A genuine provider outage is a real-world outcome and belongs in the
      // ledger. ANY other throw is a defect in this repo, and folding it into
      // folding a crash into the excluded set would let it pass as an ordinary
      // non-report-bearing run
      // — a 4-completion/1-crash run would still read as meeting the
      // threshold. Rethrow so the measurement fails loudly instead.
      if (!isProviderOutage(error)) {
        // Preserve the runs already paid for before letting the defect
        // surface. Losing them would repeat the exact data loss this
        // persistence was added to prevent.
        writeArtefact(artefact);
        throw error;
      }
      outcomes.push({
        ticketId: ticket.id,
        ticketSummary: ticket.summary,
        ticketParameters: ticket.parameters,
        retrievedChunkIds: [],
        toolCallsMade: [],
        status: "threw",
        failureCode: error.category,
        failureMessage: error.message,
        validationMessages: [],
        autoCompletedEvidence: 0,
      });
      console.log(`status=threw code=${error.category}`);
      writeArtefact(artefact);
    }
  }

  // Excluding provider-unreachable runs is right, but it must not be able to
  // empty the sample: 0 of 0 completions would print as a flawless result
  // while measuring nothing at all — the same fail-quietly shape as the
  // unvalidated RUN_COUNT. A measurement with no usable runs is void.
  // Also checked AFTER the loop: a fault on the final run would otherwise
  // never be seen, since the pre-run check cannot run again.
  if (sawOurFault !== null) {
    writeArtefact(artefact);
    throw new MeasurementConfigurationError(
      `Round VOID: the provider reported ${sawOurFault}, which is our configuration ` +
        "failing, not a measurement outcome. Fix it and re-run.",
    );
  }

  const reportBearing = outcomes.filter((outcome) => outcome.status !== "excluded");
  if (reportBearing.length === 0) {
    writeArtefact(artefact);
    // A count and literal text — no provider-derived content — so this is
    // safe to surface, and it is the one message the operator most needs.
    throw new MeasurementConfigurationError(
      `No usable runs: all ${outcomes.length} invocation(s) failed before producing a report. ` +
        "This measures nothing — check credentials, credit and connectivity.",
    );
  }
  if (excluded.length > 0) {
    console.log(
      `\nEXCLUDED ${excluded.length} run(s) that never produced a report ` +
        `(${excluded.join(", ")}). outcomes.length now INCLUDES excluded runs, so the ` +
          `report-bearing figure below is over ${reportBearing.length}, not ${outcomes.length}.`,
    );
  }
  const completed = outcomes.filter((o) => o.status === "completed").length;
  const schemaInvalid = outcomes.filter((o) => o.failureCode === "REPORT_SCHEMA_INVALID").length;
  // Must use the same predicate as the exclusion branch. It previously counted
  // only PROVIDER_UNAVAILABLE, so a PROVIDER_TIMEOUT was excluded from the
  // sample yet invisible in the tally — a run that cost money and appeared
  // nowhere.
  const nonReportBearing = outcomes.filter(
    (o) =>
      o.status === "threw" ||
      (o.failureCode !== undefined && NON_REPORT_BEARING_CODES.has(o.failureCode)),
  ).length;
  const healed = outcomes.filter((o) => o.autoCompletedEvidence > 0).length;

  console.log("\n=== Completion rate ===");
  console.table(
    outcomes.map((o) => ({
      ticket: o.ticketId,
      status: o.status,
      code: o.failureCode ?? "",
      autoCompleted: o.autoCompletedEvidence,
    })),
  );
  // Two denominators, because they answer different questions and conflating
  // them is how a 2/5 round gets reported as 2/4.
  //
  //   End-to-end — every invocation, including provider failures. This is what
  //     the public-trial gate means and what the 2/8 baseline counted, so it is
  //     the only figure comparable to either.
  //   Report-bearing — runs that reached the model. Provider failures cannot
  //     speak to report quality, so this is the figure the .describe() change
  //     is judged against. It is NOT a completion rate.
  console.log(`END-TO-END COMPLETED:   ${completed}/${outcomes.length} (comparable to the 2/8 baseline)`);
  console.log(
    `REPORT-BEARING:         ${completed}/${reportBearing.length} ` +
      "(excludes runs that never reached a report; not a completion rate)",
  );
  console.log(`REPORT_SCHEMA_INVALID:  ${schemaInvalid}/${outcomes.length}`);
  if (providerErrors.length > 0) {
    const byCause = new Map<string, number>();
    for (const record of providerErrors) {
      const key = `${record.terminalErrorCategory}/${record.errorSource}/${String(record.errorClass)}/${String(record.errorStatus)}`;
      byCause.set(key, (byCause.get(key) ?? 0) + 1);
    }
    console.log("\nProvider errors by cause (category/source/class/status):");
    for (const [cause, count] of [...byCause].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x  ${cause}`);
    }
  }

  console.log(
    `did not reach a report:  ${nonReportBearing}/${outcomes.length} ` +
      "(cause NOT attributable to the provider — see issue #123)",
  );
  console.log(`runs where #115 healed an F5 omission: ${healed}`);
  // PERSIST. Four earlier rounds left no artefact: their only record was
  // terminal output that a `tail` truncated, so the per-failure attribution
  // was lost and the doc had to rely on transcription (which got one figure
  // wrong). "Only auditing a full trajectory distinguishes a harness defect
  // from a model regression" — evaluation ch.7.
  //
  // The execution protocol and scoring rule are stored ALONGSIDE the results,
  // not just in prose: two rounds of this measurement were voided precisely
  // because the configuration they ran under was not recorded with them.
  artefact.clientRebuilds = clientRebuilds;
  artefact.completedAt = new Date().toISOString();
  artefact.tallies = {
    invocations: outcomes.length,
    reportBearing: reportBearing.length,
    completed,
    schemaInvalid,
    nonReportBearing,
    healed,
    excluded: excluded.length,
  };
  const outputPath = writeArtefact(artefact);
  // Deliberately not "full trajectory": tool inputs/outputs are absent from
  // the trace contract, so this is a run record, not a replayable trajectory.
  console.log(`\nRun record written to ${outputPath}`);

  console.log(
    `\nBaseline for comparison: 2/8 COMPLETED (25%) on deployed runs, 2026-09-14/15 (#105).`,
  );
  console.log(
    `This run is n=${outcomes.length} on GENERATED tickets (a ${TICKET_COMBINATION_COUNT}-combination ` +
      `template space, not real traffic) through the in-process ` +
      `orchestrator — the same validation path as deployed, but not deployed traffic.`,
  );
}

// Only run the measurement when invoked as a script — the exported helpers
// above are imported by tests, which must never bill a provider call.
const isMainModule = process.argv[1] !== undefined && process.argv[1].endsWith("measure-completion-rate.ts");
if (isMainModule) {
  main().catch((error: unknown) => {
  // Never print the caught VALUE — it could carry request bodies, headers or
  // API keys. The constructor name is safe (a fixed class identifier, not
  // model- or network-derived) and is the difference between "a defect in
  // this script" and "an outage", which the rethrow above now surfaces here
  // rather than burying in the sample.
  if (error instanceof MeasurementConfigurationError) {
    // Safe by construction: see the class doc.
    console.error(`[completion-rate] Configuration error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  console.error(
    `[completion-rate] The measurement failed to run (${kind}). ` +
      "No further details are printed. A non-provider failure here is a defect, " +
      "not a measurement outcome — the run is void, not a recorded failure.",
  );
    process.exitCode = 1;
  });
}
