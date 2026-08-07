import type { ExecutionStageProgress } from "@opspilot/contracts";

/**
 * One child row under the run row, keyed to one of the four canonical
 * execution stages. Status is carried entirely by the badge; the label is
 * a factual step name — no separate active/completed wording.
 *
 * `status` is typed `string` here (not `InvestigationProgressStageStatus`)
 * because `ExecutionStageProgress.status` includes `"omitted"`, which the
 * frontend status union does not yet carry — Phase 5 adds it.
 */
export interface ExecutionStageRowViewModel {
  readonly key: string;
  readonly status: string;
  readonly label: string;
}

/** One label per stage — status is carried by the badge, not by the label. */
const EXECUTION_STAGE_LABELS: Record<string, string> = {
  INVESTIGATION_CREATED: "Investigation created",
  AGENT_ANALYSIS: "Agent analysis",
  DIAGNOSTIC_EXECUTION: "Diagnostic execution",
  REPORT_GENERATION: "Report generation",
};

/**
 * Maps the four reducer-derived {@link ExecutionStageProgress} entries into
 * view-model rows, using the `ExecutionStageProgress.status` field to decide
 * the frontend badge status. The status values are lowercase and directly
 * compatible with `InvestigationProgressStageStatus` once `"omitted"` is
 * added in Phase 5.
 */
export function buildExecutionStageRows(
  stages: readonly ExecutionStageProgress[],
): readonly ExecutionStageRowViewModel[] {
  return stages.map((stage) => ({
    key: stage.key,
    status: stage.status,
    label: EXECUTION_STAGE_LABELS[stage.key] ?? stage.key,
  }));
}
