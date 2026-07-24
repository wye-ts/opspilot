import { fileURLToPath } from "node:url";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type {
  AgentConversationMessage,
  AgentOrchestratorResult,
  FakeAgentScenario,
} from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";

import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

const { runAgentOrchestrator, FakeLlmProvider } = opspilotAgentRuntime;

export interface DemoTicket {
  readonly id: string;
  readonly subject: string;
}

// Kept as the single source of truth for both the seeded ticket_context
// message and the printed header, so the two can't drift apart.
export const DEMO_TICKET: DemoTicket = {
  id: "TICKET-1001",
  subject: "Notification emails are delayed",
};

const DEMO_TOOL_CALL_ID = "call-1";

function buildDemoScenario(): FakeAgentScenario {
  const usage = { inputTokens: 120, outputTokens: 40 };

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
    id: "opspilot-demo",
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

export async function runDemoScenario(): Promise<AgentOrchestratorResult> {
  const ticketContext: AgentConversationMessage = {
    role: "ticket_context",
    ticketId: DEMO_TICKET.id,
    summary: DEMO_TICKET.subject,
  };

  const provider = new FakeLlmProvider(buildDemoScenario());
  const toolRegistry = new InMemoryToolRegistry([getServiceStatusTool]);

  return runAgentOrchestrator({
    provider,
    toolRegistry,
    initialConversation: [ticketContext],
  });
}

function formatTraceLine(
  index: number,
  event: AgentOrchestratorResult["trace"][number],
): string {
  switch (event.type) {
    case "RETRIEVAL_COMPLETED":
      // This demo never supplies a retriever, so this case is unreachable
      // here in practice — handled only to keep this switch exhaustive
      // against the shared AgentTraceEvent union.
      return `${index}. RETRIEVAL_COMPLETED — ${event.chunks.length} chunk(s)`;
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
  result: AgentOrchestratorResult,
): string {
  const lines: string[] = [
    "OpsPilot Agent Demo",
    "",
    `Ticket: ${ticket.id}`,
    `Subject: ${ticket.subject}`,
    "",
    "Trace",
    ...result.trace.map((event, index) => formatTraceLine(index + 1, event)),
  ];

  if (result.status === "completed") {
    const { report } = result;
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
    );
  } else {
    lines.push("", "Demo Failed", `Code: ${result.code}`, `Message: ${result.message}`);
  }

  return lines.join("\n");
}

export function getExitCode(result: AgentOrchestratorResult): number {
  return result.status === "failed" ? 1 : 0;
}

async function main(): Promise<void> {
  const result = await runDemoScenario();
  console.log(formatDemoOutput(DEMO_TICKET, result));
  process.exitCode = getExitCode(result);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
