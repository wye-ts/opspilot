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

import Anthropic from "@anthropic-ai/sdk";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentConversationMessage } from "@opspilot/agent-runtime";
import opspilotProviderClaude, {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from "@opspilot/provider-claude";
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
 * A NaN, zero, negative or fractional RUN_COUNT would skip the loop and print
 * "0/0 COMPLETED" as a clean success — a measurement that silently measured
 * nothing. An unbounded one would bill without a ceiling. Both are rejected.
 */
export function parseRunCount(raw: string | undefined): number {
  const trimmed = raw?.trim();
  const value = trimmed === undefined || trimmed === "" ? 5 : Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUN_COUNT) {
    throw new Error(`RUN_COUNT must be an integer in 1..${MAX_RUN_COUNT}`);
  }
  return value;
}

/**
 * Whether a thrown value is a real provider outage (a legitimate ledger row)
 * or a defect in this repository (which must void the measurement instead of
 * being counted as an ordinary failure).
 */
export function isProviderOutage(error: unknown): error is InstanceType<typeof LlmProviderError> {
  return error instanceof LlmProviderError;
}

/** Mirrors RETRIEVAL_TOP_K in apps/api/src/execution/retrieval-input.ts. */
const DEPLOYED_RETRIEVAL_TOP_K = 3;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/**
 * Ordinary operational tickets over the seeded three-service world, written to
 * the shape the deployed composer accepts (>= TICKET_SUMMARY_MIN_LENGTH, plain
 * operator prose). None is adversarial: no injection, no role confusion, no
 * attempt to elicit a forbidden action. The point is to exercise the NORMAL
 * path, which is what the deployed 25% was measured on.
 */
const TICKETS: ReadonlyArray<{
  readonly id: string;
  readonly summary: string;
}> = [
  {
    id: "TICKET-4001",
    summary:
      "Customers on one tenant report outbound notification emails arriving late or not at all. " +
      "The notification worker pool looks healthy and no release has been announced.",
  },
  {
    id: "TICKET-4002",
    summary:
      "Billing service API calls are returning elevated 5xx rates since this morning. " +
      "On-call wants to know whether a recent deployment is involved before paging the team.",
  },
  {
    id: "TICKET-4003",
    summary:
      "Search results are showing stale data for some customers — records updated an hour ago " +
      "are still missing from search. No alerts have fired on the search service itself.",
  },
  {
    id: "TICKET-4004",
    summary:
      "Several customers cannot sign in this morning and report their credentials being rejected. " +
      "The identity provider status page shows no incident.",
  },
  {
    id: "TICKET-4005",
    summary:
      "Uploads to the storage service are failing intermittently for one tenant with quota errors, " +
      "even though the account should be well under its limit.",
  },
];

interface RunOutcome {
  readonly ticketId: string;
  readonly status: string;
  readonly failureCode?: string;
  /** Which invariant Zod rejected — the capability #106 added. */
  readonly validationMessages: readonly string[];
  /** Evidence entries #115 synthesized; a non-empty list means F5 was healed. */
  readonly autoCompletedEvidence: number;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const model = requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL?.trim() ?? "claude-sonnet-5");
  const runCount = parseRunCount(process.env.RUN_COUNT);

  const { chunks } = await loadDefaultRunbookCorpus();
  const retriever = new InMemoryKeywordRunbookRetriever(chunks, DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE);

  // Match the DEPLOYED provider policy exactly. An earlier version hardcoded
  // maxRetries: 2 with no timeout — more permissive than deployment, so a
  // completion this script recorded could be one the deployed path would have
  // given up on. The defaults come from provider-claude's own config module
  // (DEFAULT_TIMEOUT_MS / DEFAULT_MAX_RETRIES), the same constants
  // loadClaudeConfig() applies when the env vars are unset.
  const timeoutMs = Number(process.env.ANTHROPIC_TIMEOUT_MS?.trim() ?? DEFAULT_TIMEOUT_MS);
  const maxRetries = Number(process.env.ANTHROPIC_MAX_RETRIES?.trim() ?? DEFAULT_MAX_RETRIES);
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

  const outcomes: RunOutcome[] = [];

  for (let i = 0; i < runCount; i += 1) {
    const ticket = TICKETS[i % TICKETS.length]!;
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
        // EXACTLY what the deployed path does — apps/api/src/execution/
        // retrieval-input.ts: buildRetrievalInput() passes the ticket summary
        // verbatim with topK 3. A hand-tuned keyword query would hand the
        // model better evidence than any visitor can supply and make the
        // measured rate incomparable to the deployed baseline (caught in
        // review, after a first version did exactly that).
        retrievalInput: { query: ticket.summary, topK: DEPLOYED_RETRIEVAL_TOP_K },
      });

      const validationMessages =
        result.status === "failed"
          ? (result.reportValidationIssues ?? [])
              .map((issue) => issue.message ?? `${issue.code}@${issue.path.join(".")}`)
              .filter((m): m is string => typeof m === "string")
          : [];

      outcomes.push({
        ticketId: ticket.id,
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
    } catch (error) {
      // A genuine provider outage is a real-world outcome and belongs in the
      // ledger. ANY other throw is a defect in this repo, and folding it into
      // "provider-side failures" would let a crash pass as an ordinary outage
      // — a 4-completion/1-crash run would still read as meeting the
      // threshold. Rethrow so the measurement fails loudly instead.
      if (!isProviderOutage(error)) throw error;
      outcomes.push({
        ticketId: ticket.id,
        status: "threw",
        failureCode: error.category,
        validationMessages: [],
        autoCompletedEvidence: 0,
      });
      console.log(`status=threw code=${error.category}`);
    }
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
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  console.error(
    `[completion-rate] The measurement failed to run (${kind}). ` +
      "No further details are printed. A non-provider failure here is a defect, " +
      "not a measurement outcome — the run is void, not a recorded failure.",
  );
    process.exitCode = 1;
  });
}
