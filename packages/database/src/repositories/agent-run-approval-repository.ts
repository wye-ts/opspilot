import type { PrismaClient } from "../client";
import { Prisma } from "../generated/prisma-client/client";
import { AgentRunApprovalError } from "../approval-errors";
import { normalizeDatabaseError, PersistenceError } from "../errors";
import { buildApprovalView, fromAgentRunApprovalRow, toRecordApprovalDecisionWrite } from "../mappers";
import type {
  AgentRunApprovalView,
  RecordApprovalDecisionParams,
  RecordApprovalDecisionResult,
} from "../types";

export async function recordApprovalDecision(
  prisma: PrismaClient,
  runId: string,
  input: RecordApprovalDecisionParams,
): Promise<RecordApprovalDecisionResult> {
  // Sole runtime validation/normalization boundary, before BEGIN — an invalid
  // write never touches the database. Still called with `input` treated as
  // untrusted at runtime, regardless of its compile-time type (docs/11 §6:
  // "TypeScript types are never trusted alone").
  const write = toRecordApprovalDecisionWrite(input);

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock AgentRun first (extends, does not replace, the AgentJob -> AgentRun ->
      // child-row order; this table never touches AgentJob at all).
      const [runRow] = await tx.$queryRaw<{ status: string; suggestedActionCount: number }[]>`
        SELECT status,
               jsonb_array_length(COALESCE(report -> 'suggestedActions', '[]'::jsonb)) AS "suggestedActionCount"
        FROM agent_runs WHERE id = ${runId}::uuid FOR UPDATE`;
      if (!runRow) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
      }

      const eligible = runRow.status === "COMPLETED" && runRow.suggestedActionCount >= 1;

      // Read and shape-validate any existing approval row BEFORE branching on
      // eligibility — always, regardless of what `eligible` is. This is what
      // lets the two "impossible" cross-table states below be distinguished
      // from an ordinary not-yet-eligible rejection, mirroring the identical
      // defensive check in getApprovalDecision.
      // Serialized entirely by the FOR UPDATE lock above — no separate lock
      // needed on agent_run_approvals; UNIQUE(run_id) is a defense-in-depth
      // backstop only.
      const existingRow = await tx.agentRunApproval.findUnique({ where: { runId } });
      const existing = existingRow ? fromAgentRunApprovalRow(existingRow) : null;

      if (existing && !eligible) {
        // Structurally impossible via this repository's own write path — a row
        // can only ever have been inserted here under eligible = true, and
        // eligibility never regresses. A manually restored backup, a future
        // migration bug, or a write that bypasses this repository could still
        // produce it. Treated as a data-integrity fault, not an ordinary
        // "not eligible" rejection.
        throw new PersistenceError(
          "PERSISTENCE_VALIDATION_FAILED",
          `AgentRunApproval exists for AgentRun ${runId}, which is not currently approval-eligible`,
        );
      }

      if (!existing && !eligible) {
        throw new AgentRunApprovalError("RUN_NOT_APPROVAL_ELIGIBLE", runId);
      }

      // eligible === true beyond this point.

      if (!existing) {
        // decidedAt is omitted here deliberately — the column's own
        // DEFAULT CURRENT_TIMESTAMP generates it, not application code.
        const createdRow = await tx.agentRunApproval.create({
          data: {
            runId,
            decision: write.decision,
            reviewerName: write.reviewerName,
            note: write.note,
          },
        });
        const record = fromAgentRunApprovalRow(createdRow);
        return { view: buildApprovalView(runId, true, record), outcome: "created" as const };
      }

      // Null-safe JS equality is correct and sufficient here (unlike the
      // SQL-side IS NOT DISTINCT FROM used for the trace-array replay check
      // in finalizeTerminal): this compares exactly one already-fetched row,
      // not an array, so there is no need for a second SQL round-trip.
      if (
        existing.decision === write.decision &&
        existing.reviewerName === write.reviewerName &&
        existing.note === write.note
      ) {
        return { view: buildApprovalView(runId, true, existing), outcome: "replayed" as const };
      }

      throw new AgentRunApprovalError("APPROVAL_ALREADY_DECIDED", runId);
    });
  } catch (error) {
    if (error instanceof AgentRunApprovalError) throw error;
    throw normalizeDatabaseError(error, "recordApprovalDecision");
  }
}

export async function getApprovalDecision(prisma: PrismaClient, runId: string): Promise<AgentRunApprovalView> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const [runRow] = await tx.$queryRaw<{ status: string; suggestedActionCount: number }[]>`
          SELECT status,
                 jsonb_array_length(COALESCE(report -> 'suggestedActions', '[]'::jsonb)) AS "suggestedActionCount"
          FROM agent_runs WHERE id = ${runId}::uuid`;
        if (!runRow) {
          throw new PersistenceError("PERSISTENCE_NOT_FOUND", `AgentRun ${runId} not found`);
        }
        const eligible = runRow.status === "COMPLETED" && runRow.suggestedActionCount >= 1;

        const approvalRow = await tx.agentRunApproval.findUnique({ where: { runId } });
        const record = approvalRow ? fromAgentRunApprovalRow(approvalRow) : null;

        // Defensive consistency check (docs/11 §6 discipline; the identical
        // check is also applied on the write path, recordApprovalDecision):
        // structurally impossible via this repository's own write path, but a
        // manually restored backup, a future migration bug, or a write that
        // bypasses this repository could still produce it.
        if (record && !eligible) {
          throw new PersistenceError(
            "PERSISTENCE_VALIDATION_FAILED",
            `AgentRunApproval exists for AgentRun ${runId}, which is not currently approval-eligible`,
          );
        }

        return buildApprovalView(runId, eligible, record);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (error) {
    throw normalizeDatabaseError(error, "getApprovalDecision");
  }
}
