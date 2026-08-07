import type { AgentOrchestratorErrorCode, InvestigationExecutionStage } from "@opspilot/contracts";

import type { PrismaClient } from "../client";
import { appendInvestigationEvent } from "../repositories/agent-run-repository";

/**
 * Test-only helpers for building the canonical lifecycle prefix a run must
 * already carry before `finalizeCompleted`/`finalizeFailed` can succeed.
 *
 * As of issue #37 Phase B, terminal finalization reducer-validates the whole
 * stored stream before it will update the run's status. A test that creates a
 * run and finalizes it immediately would therefore be asking the repository
 * to commit `RUN_CREATED -> RUN_COMPLETED`, which the contract correctly
 * rejects: strict completion requires AGENT_STARTED, REPORT_SUBMITTED and
 * REPORT_VALIDATED to have actually happened.
 *
 * These helpers emit exactly the events the real orchestrator would have
 * emitted on the corresponding path, through the real `appendInvestigationEvent`
 * — never raw SQL — so a fixture cannot drift into a stream the runtime could
 * not actually produce.
 *
 * `RUN_CREATED` is NOT emitted here: `startRun`/`startLiveRunWithAttemptLimit`
 * already write it atomically with the run row.
 */

export const FIXTURE_TOOL_CALL_ID = "call-1";
export const FIXTURE_TOOL_NAME = "get_service_status";

/** `AGENT_STARTED -> REPORT_SUBMITTED -> REPORT_VALIDATED` — the direct, no-tool success path. */
export async function appendDirectSuccessPrefix(prisma: PrismaClient, runId: string): Promise<void> {
  await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_VALIDATED" });
}

/**
 * The one-tool success path:
 * `AGENT_STARTED -> TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_GENERATION_STARTED
 *  -> REPORT_SUBMITTED -> REPORT_VALIDATED`.
 */
export async function appendOneToolSuccessPrefix(prisma: PrismaClient, runId: string): Promise<void> {
  await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
  await appendInvestigationEvent(prisma, runId, {
    type: "TOOL_REQUESTED",
    toolCallId: FIXTURE_TOOL_CALL_ID,
    toolName: FIXTURE_TOOL_NAME,
  });
  await appendInvestigationEvent(prisma, runId, {
    type: "TOOL_COMPLETED",
    toolCallId: FIXTURE_TOOL_CALL_ID,
    toolName: FIXTURE_TOOL_NAME,
  });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_GENERATION_STARTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
  await appendInvestigationEvent(prisma, runId, { type: "REPORT_VALIDATED" });
}

/**
 * Builds the canonical prefix a given orchestrator failure code would really
 * have produced, and returns the `failedStage` that must accompany it —
 * mirroring the orchestrator's own compile-exhaustive mapping.
 *
 * The pre-agent `RETRIEVAL_PARAMS_INVALID` case deliberately emits NOTHING:
 * `validateOrchestratorParams` fails before the orchestrator traces or emits
 * anything, so the contract's single pre-agent exception applies and the
 * stream is exactly `RUN_CREATED -> RUN_FAILED`.
 */
export async function appendFailurePrefix(
  prisma: PrismaClient,
  runId: string,
  code: AgentOrchestratorErrorCode,
): Promise<InvestigationExecutionStage> {
  switch (code) {
    case "RETRIEVAL_PARAMS_INVALID":
      return "AGENT_ANALYSIS";

    case "RETRIEVAL_FAILED":
    case "RETRIEVAL_RESPONSE_INVALID":
    case "PROVIDER_PROTOCOL_INVALID":
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_CANCELLED":
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      return "AGENT_ANALYSIS";

    case "TOOL_NOT_FOUND":
    case "TOOL_INPUT_INVALID":
    case "TOOL_EXECUTION_FAILED":
    case "TOOL_OUTPUT_INVALID":
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_REQUESTED",
        toolCallId: FIXTURE_TOOL_CALL_ID,
        toolName: FIXTURE_TOOL_NAME,
      });
      await appendInvestigationEvent(prisma, runId, {
        type: "TOOL_FAILED",
        toolCallId: FIXTURE_TOOL_CALL_ID,
        toolName: FIXTURE_TOOL_NAME,
        failureCode: code,
      });
      return "DIAGNOSTIC_EXECUTION";

    case "REPORT_SCHEMA_INVALID":
    case "REPORT_EVIDENCE_INVALID":
      await appendInvestigationEvent(prisma, runId, { type: "AGENT_STARTED" });
      await appendInvestigationEvent(prisma, runId, { type: "REPORT_SUBMITTED" });
      await appendInvestigationEvent(prisma, runId, {
        type: "REPORT_VALIDATION_FAILED",
        failureCode: code,
      });
      return "REPORT_GENERATION";
  }
}
