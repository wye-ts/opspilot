import { fileURLToPath } from "node:url";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentOrchestratorResult, FakeAgentScenario } from "@opspilot/agent-runtime";
import opspilotDatabase from "@opspilot/database";
import type { ResolutionReport } from "@opspilot/contracts";

const { createPrismaClient } = opspilotDatabase;
const {
  FakeLlmProvider,
  createAgentRunService,
  createPrismaAgentRunRepository,
  AgentRunServiceError,
  InMemoryToolRegistry,
  getServiceStatusTool,
} = opspilotAgentRuntime;

export interface DemoTicket {
  readonly id: string;
  readonly subject: string;
}

// Deliberately the same style/shape as run-agent-demo.ts's DemoTicket — this
// demo only adds persistence around the identical deterministic scenario,
// it does not introduce new agent behavior.
export const DEMO_TICKET: DemoTicket = {
  id: "TICKET-2001",
  subject: "Elevated API error rate on billing-service",
};

const DEMO_TOOL_CALL_ID = "call-1";

function buildDemoScenario(): FakeAgentScenario {
  const usage = { inputTokens: 120, outputTokens: 40 };

  const report: ResolutionReport = {
    category: "SERVICE_DEGRADATION",
    summary: "billing-service is returning elevated error rates.",
    rootCause: "billing-service reported an OUTAGE status.",
    customerImpact: "Some customers may be unable to complete billing operations.",
    recommendedResolution: "Escalate to the billing platform team to investigate the outage.",
    confidence: 0.9,
    evidence: [
      {
        evidenceId: DEMO_TOOL_CALL_ID,
        sourceType: "TOOL_EXECUTION",
        finding: "billing-service reported status OUTAGE.",
      },
    ],
    suggestedActions: [
      {
        type: "CREATE_ESCALATION",
        payload: {
          team: "Billing Platform",
          reason: "billing-service is reporting an outage.",
          priority: "URGENT",
        },
      },
    ],
  };

  return {
    id: "opspilot-persisted-demo",
    turns: [
      {
        kind: "diagnostic_tool_requests",
        usage,
        requests: [
          {
            toolCallId: DEMO_TOOL_CALL_ID,
            toolName: "get_service_status",
            input: { serviceSlug: "billing-service" },
          },
        ],
      },
      { kind: "report_submission", usage, rawInput: report },
    ],
  };
}

function formatTraceLine(index: number, event: AgentOrchestratorResult["trace"][number]): string {
  switch (event.type) {
    case "RETRIEVAL_COMPLETED":
      return `${index}. RETRIEVAL_COMPLETED — ${event.chunks.length} chunk(s)`;
    case "TOOL_REQUESTED":
      return `${index}. TOOL_REQUESTED — ${event.toolName}`;
    case "TOOL_COMPLETED":
      return `${index}. TOOL_COMPLETED — ${event.toolName}`;
    case "REPORT_GENERATED":
      return `${index}. REPORT_GENERATED`;
  }
}

async function main(): Promise<void> {
  console.log("OpsPilot Persisted Agent Demo");
  console.log("");
  console.log(`Ticket: ${DEMO_TICKET.id}`);
  console.log(`Subject: ${DEMO_TICKET.subject}`);
  console.log("");

  // Fixed setup message only if DATABASE_URL is absent — never a raw driver
  // error, never the connection string itself.
  const { prisma, close } = createPrismaClient();

  try {
    const repository = createPrismaAgentRunRepository(prisma);
    const service = createAgentRunService(repository);

    const job = await service.createAgentJob({
      ticketId: DEMO_TICKET.id,
      summary: DEMO_TICKET.subject,
    });
    console.log(`Job created: ${job.id}`);

    // Only job.id is passed on — never job itself. executeAndPersist derives
    // the ticket_context conversation from the AgentJob row it loads from
    // PostgreSQL under startRun's own lock, so the agent can never
    // investigate a different ticket than the one this job was created for.
    const provider = new FakeLlmProvider(buildDemoScenario());
    const toolRegistry = new InMemoryToolRegistry([getServiceStatusTool]);

    let result: Awaited<ReturnType<typeof service.executeAndPersist>>;
    try {
      result = await service.executeAndPersist({
        jobId: job.id,
        providerMode: "FAKE",
        createProvider: () => provider,
        toolRegistry,
      });
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        // Only the stable code, fixed message, and safe run ID are ever
        // printed — never the raw cause, a stack trace, or provider/tool text.
        console.log("");
        console.log("Agent Execution Crashed");
        console.log(`Code: ${error.code}`);
        console.log(`Message: ${error.message}`);
        console.log(`Run ID: ${error.runId}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    console.log(`Run started: ${result.persistence === "persisted" ? result.run.run.id : "(see below)"}`);

    if (result.persistence === "unavailable") {
      console.log("");
      console.log("Persistence Unavailable");
      console.log(`Stage: ${result.stage}`);
      console.log(`Code: ${result.error.code}`);
      console.log(`Message: ${result.error.message}`);
      if (result.stage === "finalization") {
        console.log(`Run ID: ${result.runId}`);
        console.log(
          `Agent outcome (in memory only, not persisted): ${result.agentResult.status}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    console.log("Agent executed and trace persisted.");
    console.log("");

    const persisted = await service.getAgentRun(result.run.run.id);
    console.log("Run read back from PostgreSQL:");
    console.log(`  status: ${persisted.run.status}`);
    console.log(`  attempt: ${persisted.run.attemptNumber}`);
    console.log("");
    console.log("Trace");
    persisted.trace.forEach((event, index) => console.log(formatTraceLine(index + 1, event)));
    console.log("");

    if (persisted.outcome.type === "COMPLETED") {
      const { report } = persisted.outcome;
      console.log("Resolution Report");
      console.log(`Category: ${report.category}`);
      console.log(`Summary: ${report.summary}`);
      console.log(`Confidence: ${report.confidence.toFixed(2)}`);
    } else if (persisted.outcome.type === "FAILED") {
      console.log("Terminal Outcome: FAILED");
      console.log(`Code: ${persisted.outcome.code}`);
      console.log(`Message: ${persisted.outcome.message}`);
      process.exitCode = 1;
    }
  } finally {
    // The pg.Pool is ours to manage under the driver-adapter model — must
    // always close it or the process hangs on an open connection.
    await close();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void main();
}
