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
 * are still hand-authored, and a rate measured on them is evidence about the
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
import type { AgentConversationMessage } from "@opspilot/agent-runtime";
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

const { runAgentOrchestrator, LlmProviderError } = opspilotAgentRuntime;
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
export const LIVE_RUN_OUTPUT_BUDGET = {
  investigationMaxOutputTokens: 1024,
  finalizationMaxOutputTokens: 3072,
} as const;

/**
 * The deployed per-run provider deadline (DEFAULT_PROVIDER_DEADLINE_MS in
 * apps/api/src/execution/run-abort-context.ts). It spans the WHOLE run, not one
 * call: three 41-second turns each clear a 45s per-call timeout while busting a
 * shared 120s budget, so a per-call timeout alone does not reproduce it.
 */
export const LIVE_RUN_PROVIDER_DEADLINE_MS = 120_000;

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

interface RunOutcome {
  readonly ticketId: string;
  readonly ticketSummary: string;
  readonly ticketParameters: Record<string, unknown>;
  readonly status: string;
  readonly failureCode?: string;
  /** Which invariant Zod rejected — the capability #106 added. */
  readonly validationMessages: readonly string[];
  /** Evidence entries #115 synthesized; a non-empty list means F5 was healed. */
  readonly autoCompletedEvidence: number;
  /** What the model was actually shown — "only a full trajectory distinguishes
   *  a harness defect from a model regression" (evaluation ch.7). */
  readonly retrievedChunkIds: readonly string[];
  readonly toolCallsMade: readonly string[];
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
  const timeoutMs = parseBoundedEnvInteger(
    process.env.ANTHROPIC_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "ANTHROPIC_TIMEOUT_MS",
  );
  const maxRetries = LIVE_RUN_MAX_RETRIES;
  const anthropicClient = new Anthropic({
    apiKey,
    logLevel: "off",
    timeout: timeoutMs,
    maxRetries,
  });
  const provider = new ClaudeLlmProvider({
    client: anthropicClient,
    model,
    configuredMaxRetries: maxRetries,
    diagnosticTools: DIAGNOSTIC_TOOL_CATALOG,
  });
  console.log(`provider policy: timeoutMs=${timeoutMs} maxRetries=${maxRetries} (deployed defaults)`);

  const tickets = generateTickets(runCount, TICKET_SEED);
  console.log(
    `tickets: ${runCount} distinct, seed=${TICKET_SEED} ` +
      `(of ${TICKET_COMBINATION_COUNT} possible combinations)`,
  );

  const outcomes: RunOutcome[] = [];
  const excluded: string[] = [];

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
    runs: RunOutcome[];
  } = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    completedAt: null,
    executionProtocol: {
      model,
      maxRetries,
      timeoutMs,
      providerDeadlineMs: LIVE_RUN_PROVIDER_DEADLINE_MS,
      outputBudget: LIVE_RUN_OUTPUT_BUDGET,
      retrievalTopK: DEPLOYED_RETRIEVAL_TOP_K,
      retrievalQueryRule: "ticket summary verbatim (apps/api/src/execution/retrieval-input.ts)",
      ticketSeed: TICKET_SEED,
      requestedRuns: runCount,
    },
    scoringRule: {
      completed: 'orchestrator status === "completed"',
      excluded:
        "PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_CANCELLED — the run did not produce " +
        "a report for provider-side reasons, so it cannot speak to report quality. " +
        "PROVIDER_UNAVAILABLE additionally collapses AUTHENTICATION/BILLING/REQUEST_INVALID, " +
        "so such a run cannot even be shown to have reached the model.",
      voided: "any non-LlmProviderError throw is a defect in this repo, not a measurement outcome",
    },
    tallies: null,
    excludedTickets: excluded,
    runs: outcomes,
  };

  for (let i = 0; i < runCount; i += 1) {
    const ticket = tickets[i]!;
    const registry = new InMemoryToolRegistry([getServiceStatusTool, getRecentDeploymentsTool]);

    process.stdout.write(`\n--- run ${i + 1}/${runCount} — ${ticket.id} ---\n`);

    try {
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
        outputBudget: LIVE_RUN_OUTPUT_BUDGET,
        // The deployed per-RUN deadline. A fresh signal per run, because it
        // bounds the whole investigation rather than one call — the SDK
        // timeout above only bounds a single request.
        signal: AbortSignal.timeout(LIVE_RUN_PROVIDER_DEADLINE_MS),
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
      //   PROVIDER_TIMEOUT / PROVIDER_CANCELLED — unambiguous, and both mean
      //     the run did not finish for reasons outside report quality.
      //     EXCLUDED, and counted as provider-side rather than silently
      //     dropped (PROVIDER_TIMEOUT was previously invisible in the
      //     tallies, and PROVIDER_CANCELLED was counted as an ordinary
      //     report failure).
      const PROVIDER_SIDE_CODES = new Set([
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_TIMEOUT",
        "PROVIDER_CANCELLED",
      ]);
      if (result.status === "failed" && PROVIDER_SIDE_CODES.has(result.code)) {
        console.log(
          `status=failed code=${result.code} — EXCLUDED from the sample. ` +
            "The run did not produce a report for provider-side reasons, so it cannot " +
            "speak to report quality either way.",
        );
        excluded.push(`${ticket.id} (${result.code})`);
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
      const toolCalls = trace.flatMap((event) =>
        event.type === "TOOL_COMPLETED" ? [event.toolName] : [],
      );

      outcomes.push({
        ticketId: ticket.id,
        ticketSummary: ticket.summary,
        ticketParameters: ticket.parameters,
        retrievedChunkIds: retrievalChunks,
        toolCallsMade: toolCalls,
        status: result.status,
        ...(result.status === "failed" ? { failureCode: result.code } : {}),
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
      // "provider-side failures" would let a crash pass as an ordinary outage
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
  if (outcomes.length === 0) {
    writeArtefact(artefact);
    // A count and literal text — no provider-derived content — so this is
    // safe to surface, and it is the one message the operator most needs.
    throw new MeasurementConfigurationError(
      `No usable runs: all ${excluded.length} invocation(s) failed before producing a report. ` +
        "This measures nothing — check credentials, credit and connectivity.",
    );
  }
  if (excluded.length > 0) {
    console.log(
      `\nEXCLUDED ${excluded.length} run(s) that never produced a report ` +
        `(${excluded.join(", ")}). The rate below is over the remaining ${outcomes.length}.`,
    );
  }
  const completed = outcomes.filter((o) => o.status === "completed").length;
  const schemaInvalid = outcomes.filter((o) => o.failureCode === "REPORT_SCHEMA_INVALID").length;
  const providerIssues = outcomes.filter(
    (o) => o.failureCode === "PROVIDER_UNAVAILABLE" || o.status === "threw",
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
  console.log(`COMPLETED:              ${completed}/${outcomes.length}`);
  console.log(`REPORT_SCHEMA_INVALID:  ${schemaInvalid}/${outcomes.length}`);
  console.log(`provider-side failures: ${providerIssues}/${outcomes.length}`);
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
  artefact.completedAt = new Date().toISOString();
  artefact.tallies = { completed, schemaInvalid, providerIssues, healed, excluded: excluded.length };
  const outputPath = writeArtefact(artefact);
  console.log(`\nFull trajectory written to ${outputPath}`);

  console.log(
    `\nBaseline for comparison: 2/8 COMPLETED (25%) on deployed runs, 2026-09-14/15 (#105).`,
  );
  console.log(
    `This run is n=${outcomes.length} on hand-authored tickets through the in-process ` +
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
