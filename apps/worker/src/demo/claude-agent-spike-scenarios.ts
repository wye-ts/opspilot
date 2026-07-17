import { ResolutionReportSchema } from "@opspilot/contracts";

import { findInvalidEvidence, runAgentOrchestrator } from "../agent/agent-orchestrator";
import { LlmProviderError, type AgentConversationMessage, type LlmProvider } from "../providers/llm-provider";
import { InMemoryToolRegistry, getServiceStatusTool } from "../tools";

const TICKET_ID = "TICKET-1001";
const TICKET_SUMMARY = "Notification emails are delayed";
const PROBE_TOOL_CALL_ID = "call-1";

export interface SpikeScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failureCode?: string;
}

function passed(name: string): SpikeScenarioResult {
  return { name, passed: true };
}

function failed(name: string, failureCode: string): SpikeScenarioResult {
  return { name, passed: false, failureCode };
}

export function hasFailingScenario(results: readonly SpikeScenarioResult[]): boolean {
  return results.some((result) => !result.passed);
}

// Runs the real, unmodified AgentOrchestrator against a live-backed
// LlmProvider: ticket -> one diagnostic tool call -> forced report
// submission. Only a LlmProviderError (a transport/auth/rate-limit/timeout/
// server failure, never a normal model response) is caught here — anything
// else is a genuine bug and propagates to the caller's top-level boundary.
export async function runToolThenReportScenario(provider: LlmProvider): Promise<SpikeScenarioResult> {
  const name = "tool-then-report";
  console.log(`\n=== Scenario: ${name} (full orchestrator run) ===`);

  const ticketContext: AgentConversationMessage = {
    role: "ticket_context",
    ticketId: TICKET_ID,
    summary: TICKET_SUMMARY,
  };
  const toolRegistry = new InMemoryToolRegistry([getServiceStatusTool]);

  try {
    const result = await runAgentOrchestrator({
      provider,
      toolRegistry,
      initialConversation: [ticketContext],
    });

    console.log(`status=${result.status}`);
    console.log(`trace=${JSON.stringify(result.trace)}`);

    if (result.status !== "completed") {
      console.log(`code=${result.code} message=${result.message}`);
      return failed(name, result.code);
    }

    console.log(`report=${JSON.stringify(result.report, null, 2)}`);
    return passed(name);
  } catch (error) {
    if (error instanceof LlmProviderError) {
      console.log(`[${name}] LlmProviderError category=${error.category} message=${error.message}`);
      return failed(name, `LLM_PROVIDER_ERROR_${error.category}`);
    }
    throw error;
  }
}

// Bypasses runAgentOrchestrator entirely: the orchestrator's own loop always
// starts a fresh call at turnIndex 0 -> INVESTIGATION, so it cannot express
// "this is actually the forced-finalization turn" for a standalone probe.
// The seeded conversation mirrors exactly what turn 0 of a real run would
// have produced, letting Claude's forced submit_resolution_report call cite
// real, validated evidence.
export async function runForcedFinalizationProbe(provider: LlmProvider): Promise<SpikeScenarioResult> {
  const name = "forced-finalization-probe";
  console.log(`\n=== Scenario: ${name} ===`);

  const conversation: AgentConversationMessage[] = [
    { role: "ticket_context", ticketId: TICKET_ID, summary: TICKET_SUMMARY },
    {
      role: "diagnostic_tool_request",
      toolCallId: PROBE_TOOL_CALL_ID,
      toolName: "get_service_status",
      input: { serviceSlug: "notification-service" },
    },
    {
      role: "diagnostic_tool_result",
      toolCallId: PROBE_TOOL_CALL_ID,
      toolName: "get_service_status",
      output: { serviceSlug: "notification-service", status: "DEGRADED" },
    },
  ];

  try {
    const result = await provider.runAgentTurn({
      turnIndex: 1,
      phase: "FINALIZATION",
      maxOutputTokens: 4096,
      conversation,
    });

    console.log(`result.type=${result.type}`);
    if (result.type !== "report_submission") {
      return failed(name, `UNEXPECTED_RESULT_TYPE_${result.type}`);
    }

    const parsedReport = ResolutionReportSchema.safeParse(result.rawInput);
    console.log(`ResolutionReportSchema.safeParse: success=${parsedReport.success}`);
    if (!parsedReport.success) {
      console.log(`schema errors: ${JSON.stringify(parsedReport.error.issues)}`);
      return failed(name, "REPORT_SCHEMA_INVALID");
    }

    const hasInvalidEvidence = findInvalidEvidence(
      parsedReport.data.evidence,
      new Set(),
      new Set([PROBE_TOOL_CALL_ID]),
    );
    console.log(`evidence-grounding valid=${!hasInvalidEvidence}`);
    console.log(`evidence=${JSON.stringify(parsedReport.data.evidence)}`);
    if (hasInvalidEvidence) {
      return failed(name, "REPORT_EVIDENCE_INVALID");
    }

    return passed(name);
  } catch (error) {
    if (error instanceof LlmProviderError) {
      console.log(`[${name}] LlmProviderError category=${error.category} message=${error.message}`);
      return failed(name, `LLM_PROVIDER_ERROR_${error.category}`);
    }
    throw error;
  }
}
