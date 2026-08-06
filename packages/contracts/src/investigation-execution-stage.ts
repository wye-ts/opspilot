import { z } from "zod";

import { AgentOrchestratorErrorCodeSchema } from "./agent-orchestrator";

// The shared, backend-execution-only stage vocabulary for issue #36. Exactly
// four phases the agent's own execution passes through — never the run's
// terminal status (RUNNING/COMPLETED/FAILED stays a separate axis, see
// docs/16-investigation-event-contract.md §1) and never a frontend-only
// presentation concept (LIVE-availability preflight, approval loading —
// both remain apps/web-only, composed around this enum rather than merged
// into it).
export const InvestigationExecutionStageSchema = z.enum([
  "INVESTIGATION_CREATED",
  "AGENT_ANALYSIS",
  "DIAGNOSTIC_EXECUTION",
  "REPORT_GENERATION",
]);

export type InvestigationExecutionStage = z.infer<
  typeof InvestigationExecutionStageSchema
>;

// The run-status axis, kept deliberately separate from the stage enum
// above: status answers "is the run still going", a stage answers "what is
// it doing". Mirrors the values of the existing AgentRunStatus in
// packages/database (RUNNING | COMPLETED | FAILED) — restated here as a
// runtime schema because packages/contracts cannot depend on the database
// package, and because the reducer needs to validate this input at runtime
// rather than trusting a TypeScript-only union that a JavaScript caller or
// a package boundary can bypass.
export const InvestigationRunStatusSchema = z.enum(["RUNNING", "COMPLETED", "FAILED"]);

export type InvestigationRunStatus = z.infer<typeof InvestigationRunStatusSchema>;

// Fixed product order — the shared reducer always returns exactly one
// ExecutionStageProgress entry per key, in this order, regardless of which
// events were actually observed.
export const INVESTIGATION_EXECUTION_STAGE_ORDER: readonly InvestigationExecutionStage[] =
  [
    "INVESTIGATION_CREATED",
    "AGENT_ANALYSIS",
    "DIAGNOSTIC_EXECUTION",
    "REPORT_GENERATION",
  ];

// "omitted" extends the correction-requested pending/active/completed/failed
// set with the status the existing, already-shipped frontend Timeline
// already uses for a stage that provably will not happen (see
// apps/web/src/investigation-progress/investigation-progress-stages.ts's
// own stage-omission logic) — reused here rather than reinvented, so a
// never-started stage after a terminal outcome is never rendered as a
// permanently "pending" row.
export const ExecutionStageProgressStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
  "omitted",
]);

export type ExecutionStageProgressStatus = z.infer<
  typeof ExecutionStageProgressStatusSchema
>;

export const ExecutionStageProgressSchema = z
  .object({
    key: InvestigationExecutionStageSchema,
    status: ExecutionStageProgressStatusSchema,
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    failureCode: AgentOrchestratorErrorCodeSchema.optional(),
  })
  .strict()
  .readonly()
  .superRefine((value, ctx) => {
    const hasFailureCode = value.failureCode !== undefined;
    if (value.status === "failed" && !hasFailureCode) {
      ctx.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failureCode is required when status is \"failed\".",
      });
    }
    if (value.status !== "failed" && hasFailureCode) {
      ctx.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failureCode must be absent unless status is \"failed\".",
      });
    }

    const timestamped = value.status === "active" || value.status === "completed" || value.status === "failed";
    if (!timestamped) {
      if (value.startedAt !== null || value.completedAt !== null || value.elapsedMs !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "pending/omitted stages must have null startedAt, completedAt, and elapsedMs.",
        });
      }
      return;
    }

    if (value.startedAt === null || value.elapsedMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "active/completed/failed stages require startedAt and elapsedMs.",
      });
    }

    const settled = value.status === "completed" || value.status === "failed";
    if (settled && value.completedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "completed/failed stages require completedAt.",
      });
    }
    if (value.status === "active" && value.completedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "an active stage must not have completedAt set.",
      });
    }
  });

export type ExecutionStageProgress = z.infer<typeof ExecutionStageProgressSchema>;

// The reducer's full return shape. Exported so the reducer can validate its
// OWN output at runtime before returning it (see
// investigation-stage-progress-reducer.ts) — the invariants encoded in
// ExecutionStageProgressSchema's refinement are worthless if nothing ever
// executes them, so the reducer runs every result through this schema and
// throws INVALID_PROGRESS_OUTPUT rather than returning a value that
// violates its own contract.
//
// The list shape is enforced here, not merely documented: exactly four
// entries, one per execution stage, in INVESTIGATION_EXECUTION_STAGE_ORDER.
// A plain `z.array(...)` would have accepted an empty list, a partial list,
// duplicate keys, or a reordered list — none of which the reducer is
// allowed to return, so none of which the schema should admit.
export const ExecutionStageProgressListSchema = z
  .array(ExecutionStageProgressSchema)
  .length(INVESTIGATION_EXECUTION_STAGE_ORDER.length)
  .superRefine((entries, ctx) => {
    INVESTIGATION_EXECUTION_STAGE_ORDER.forEach((expectedKey, index) => {
      const actualKey = entries[index]?.key;
      if (actualKey !== expectedKey) {
        ctx.addIssue({
          code: "custom",
          path: [index, "key"],
          message: `Expected stage "${expectedKey}" at index ${index}, received "${String(actualKey)}". The progress list is exactly one entry per execution stage, in INVESTIGATION_EXECUTION_STAGE_ORDER.`,
        });
      }
    });
  })
  .readonly();

export type ExecutionStageProgressList = z.infer<typeof ExecutionStageProgressListSchema>;
