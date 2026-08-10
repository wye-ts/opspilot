import {
  mapInvestigationEventToExecutionStage,
  type ExecutionStageProgress,
  type InvestigationEventRecord,
  type InvestigationExecutionStage,
} from "@opspilot/contracts";

import type { InvestigationProgressStageStatus } from "./investigation-progress-stages";
import { formatInvestigationEventLabel } from "./investigation-event-labels";

/**
 * One child row under the run row, keyed to one of the four canonical
 * execution stages. Status is carried entirely by the badge; the label is
 * a factual step name — no separate active/completed wording.
 *
 * `events` is present only when the stage's nested event rows have been
 * grouped from an observed investigation-event stream (never fabricated for
 * a stage that never ran).
 */
export interface ExecutionStageRowViewModel {
  readonly key: string;
  readonly status: InvestigationProgressStageStatus;
  readonly label: string;
  readonly events?: readonly InvestigationEventViewModel[];
}

/** One nested event row under an execution-stage child row. */
export interface InvestigationEventViewModel {
  readonly sequence: number;
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
 * Groups observed investigation events under the execution stage each one
 * belongs to, in canonical sequence order. Terminal events (RUN_COMPLETED,
 * RUN_FAILED) and the legacy REPORT_GENERATED type map to `null` and are
 * skipped — they never nest beneath a stage row.
 */
export function groupEventsByStage(
  events: readonly InvestigationEventRecord[],
): Map<InvestigationExecutionStage, readonly InvestigationEventViewModel[]> {
  const map = new Map<InvestigationExecutionStage, InvestigationEventViewModel[]>();
  for (const record of events) {
    const stage = mapInvestigationEventToExecutionStage(record.payload);
    if (stage === null) continue;
    const vm: InvestigationEventViewModel = {
      sequence: record.sequence,
      label: formatInvestigationEventLabel(record.payload),
    };
    const existing = map.get(stage);
    if (existing !== undefined) {
      existing.push(vm);
    } else {
      map.set(stage, [vm]);
    }
  }
  return map;
}

/**
 * Maps the four reducer-derived {@link ExecutionStageProgress} entries into
 * view-model rows, using the `ExecutionStageProgress.status` field to decide
 * the frontend badge status, and attaching each stage's grouped nested
 * events when the caller supplied them.
 */
export function buildExecutionStageRows(
  stages: readonly ExecutionStageProgress[],
  eventsByStage: ReadonlyMap<
    InvestigationExecutionStage,
    readonly InvestigationEventViewModel[]
  > = new Map(),
): readonly ExecutionStageRowViewModel[] {
  return stages.map((stage) => {
    const events = eventsByStage.get(stage.key);
    return {
      key: stage.key,
      status: stage.status,
      label: EXECUTION_STAGE_LABELS[stage.key] ?? stage.key,
      // `events` is absent (not `undefined`) when the stage has no nested
      // events — exactOptionalPropertyTypes keeps the key off the row.
      ...(events !== undefined ? { events } : {}),
    };
  });
}
