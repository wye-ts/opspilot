import { fileURLToPath } from "node:url";

import type { ResolutionReport } from "@opspilot/contracts";

import {
  runAgentOrchestrator,
  type AgentOrchestratorResult,
} from "../agent/agent-orchestrator";
import {
  FakeLlmProvider,
  type FakeAgentScenario,
} from "../providers/fake-llm-provider";
import type { AgentConversationMessage } from "../providers/llm-provider";
import {
  InMemoryKeywordRunbookRetriever,
  RunbookLoadError,
  loadDefaultRunbookCorpus,
  type RunbookCorpusLoadResult,
} from "../rag";
import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

export interface DemoTicket {
  readonly id: string;
  readonly subject: string;
}

export const DEMO_TICKET: DemoTicket = {
  id: "TICKET-2001",
  subject: "Notification emails are delayed after a service degradation",
};

const DEMO_TOOL_CALL_ID = "call-1";
const DEMO_RAG_CHUNK_ID = "runbook-notification-degradation-001";
// topK=2 keeps retrieval unambiguous for this fixed query: the two genuinely
// relevant chunks score well above every other chunk (verified in
// in-memory-runbook-retriever.test.ts's scoring assertions), so the demo
// never has to explain a tie-break or an incidental irrelevant hit.
const DEMO_RETRIEVAL_INPUT = {
  query: "notification service degradation delayed emails",
  topK: 2,
};

// Exactly two provider turns, matching MAX_PROVIDER_TURNS: turn 0 is a
// diagnostic_tool_request, turn 1 is the required report_submission.
function buildDemoScenario(): FakeAgentScenario {
  const usage = { inputTokens: 150, outputTokens: 50 };

  const report: ResolutionReport = {
    category: "SERVICE_DEGRADATION",
    summary: "Notification delivery is delayed for some customers.",
    rootCause: "notification-service is running in a degraded state.",
    customerImpact:
      "Some customers are experiencing delayed notification emails.",
    recommendedResolution:
      "Escalate to the messaging platform team to investigate notification-service degradation.",
    confidence: 0.9,
    evidence: [
      {
        evidenceId: DEMO_TOOL_CALL_ID,
        sourceType: "TOOL_EXECUTION",
        finding: "notification-service reported status DEGRADED.",
      },
      {
        evidenceId: DEMO_RAG_CHUNK_ID,
        sourceType: "RAG_CHUNK",
        finding: "Runbook confirms notification-service degradation is a known failure mode.",
      },
    ],
    suggestedActions: [
      {
        type: "CREATE_ESCALATION",
        payload: {
          team: "Messaging Platform",
          reason: "notification-service is degraded and delaying emails.",
          priority: "HIGH",
        },
      },
    ],
  };

  return {
    id: "opspilot-rag-demo",
    turns: [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: DEMO_TOOL_CALL_ID,
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
          },
        ],
      },
      { kind: "report_submission", usage, rawInput: report },
    ],
  };
}

export interface RagDemoScenarioResult {
  readonly agentResult: AgentOrchestratorResult;
  readonly corpusLoad: RunbookCorpusLoadResult;
}

// Loads the real Markdown corpus (see load-default-runbook-corpus.ts) before
// any provider/tool call — a RunbookLoadError here propagates to the caller
// (see main(), below) without ever constructing a provider or tool registry.
export async function runRagDemoScenario(): Promise<RagDemoScenarioResult> {
  const corpusLoad = await loadDefaultRunbookCorpus();

  const ticketContext: AgentConversationMessage = {
    role: "ticket_context",
    ticketId: DEMO_TICKET.id,
    summary: DEMO_TICKET.subject,
  };

  const provider = new FakeLlmProvider(buildDemoScenario());
  const toolRegistry = new InMemoryToolRegistry([getServiceStatusTool]);
  const retriever = new InMemoryKeywordRunbookRetriever(corpusLoad.chunks);

  const agentResult = await runAgentOrchestrator({
    provider,
    toolRegistry,
    initialConversation: [ticketContext],
    retriever,
    retrievalInput: DEMO_RETRIEVAL_INPUT,
  });

  return { agentResult, corpusLoad };
}

function formatTraceLine(
  index: number,
  event: AgentOrchestratorResult["trace"][number],
): string {
  switch (event.type) {
    case "RETRIEVAL_COMPLETED":
      return (
        `${index}. RETRIEVAL_COMPLETED — ${event.chunks.length} chunk(s): ` +
        event.chunks
          .map((chunk) => `${chunk.chunkId} (rank ${chunk.rank}, score ${chunk.score})`)
          .join(", ")
      );
    case "TOOL_REQUESTED":
      return `${index}. TOOL_REQUESTED — ${event.toolName}`;
    case "TOOL_COMPLETED":
      return `${index}. TOOL_COMPLETED — ${event.toolName}`;
    case "REPORT_GENERATED":
      return `${index}. REPORT_GENERATED`;
  }
}

export function formatDemoOutput(
  ticket: DemoTicket,
  { agentResult, corpusLoad }: RagDemoScenarioResult,
): string {
  const lines: string[] = [
    "OpsPilot RAG Agent Demo",
    "",
    `Ticket: ${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Loaded ${corpusLoad.chunks.length} chunks from ${corpusLoad.sourceFileCount} Markdown runbooks.`,
    `Retrieval query: ${DEMO_RETRIEVAL_INPUT.query}`,
    `Retrieval topK: ${DEMO_RETRIEVAL_INPUT.topK}`,
    "",
    "Trace",
    ...agentResult.trace.map((event, index) => formatTraceLine(index + 1, event)),
  ];

  if (agentResult.status === "completed") {
    const { report } = agentResult;
    lines.push(
      "",
      "Resolution Report",
      `Category: ${report.category}`,
      `Summary: ${report.summary}`,
      `Root Cause: ${report.rootCause}`,
      `Customer Impact: ${report.customerImpact}`,
      `Recommended Resolution: ${report.recommendedResolution}`,
      `Confidence: ${report.confidence.toFixed(2)}`,
      "",
      "Evidence",
      ...report.evidence.map(
        (entry) => `- ${entry.sourceType} ${entry.evidenceId}: ${entry.finding}`,
      ),
      "",
      "Suggested Actions",
      ...report.suggestedActions.map((action) => {
        switch (action.type) {
          case "CREATE_ESCALATION":
            return `- CREATE_ESCALATION: ${action.payload.team} / ${action.payload.priority}`;
          case "UPDATE_TICKET_STATUS":
            return `- UPDATE_TICKET_STATUS: ${action.payload.status}`;
          case "DRAFT_CUSTOMER_REPLY":
            return `- DRAFT_CUSTOMER_REPLY: ${action.payload.subject}`;
        }
      }),
      "",
      "Evidence Validation",
      "PASSED — all cited evidenceId values were validated against this run's " +
        "successful tool executions and retrieved RAG chunks.",
    );
  } else {
    lines.push("", "Demo Failed", `Code: ${agentResult.code}`, `Message: ${agentResult.message}`);
  }

  return lines.join("\n");
}

export function getExitCode(result: AgentOrchestratorResult): number {
  return result.status === "failed" ? 1 : 0;
}

async function main(): Promise<void> {
  let result: RagDemoScenarioResult;
  try {
    result = await runRagDemoScenario();
  } catch (error) {
    if (error instanceof RunbookLoadError) {
      // Sanitized: category only, never the underlying message's raw path
      // details beyond what RunbookLoadError itself already guarantees.
      console.error(`[rag-demo] Failed to load runbook corpus (${error.category}): ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(formatDemoOutput(DEMO_TICKET, result));
  process.exitCode = getExitCode(result.agentResult);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
