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
  /**
   * True only for an `omitted` stage that follows another stage's `failed`
   * status in canonical order — the truthful reason it never ran is that an
   * earlier stage failed, not "this step never applies to this kind of run"
   * (e.g. DIAGNOSTIC_EXECUTION omitted on a successful no-tool run). Drives
   * the "Not reached" vs "Not applicable" badge text only — the underlying
   * `status` stays the single backend-truthful `omitted` value either way
   * (HQ review: copy-only distinction, no backend contract change).
   */
  readonly notReached?: boolean;
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
  // Tracked across the canonical-ordered array as we go: a `failed` stage
  // can only precede the `omitted` stages after it (the reducer never
  // resumes a stage once a later one has failed), so seeing one is enough to
  // mark every subsequent `omitted` stage "Not reached" rather than
  // "Not applicable".
  let sawFailure = false;
  return stages.map((stage) => {
    if (stage.status === "failed") sawFailure = true;
    const events = eventsByStage.get(stage.key);
    const notReached = stage.status === "omitted" && sawFailure;
    return {
      key: stage.key,
      status: stage.status,
      label: EXECUTION_STAGE_LABELS[stage.key] ?? stage.key,
      // `events`/`notReached` are absent (not `undefined`/`false`) when they
      // don't apply — exactOptionalPropertyTypes keeps the key off the row.
      ...(events !== undefined ? { events } : {}),
      ...(notReached ? { notReached: true } : {}),
    };
  });
}

/**
 * The lowercase-first-letter label of the one canonical child row that is
 * `failed`, or `null` when there is no canonical breakdown or none failed.
 * The sole source ReportPanel's grounded failure summary reads from — never
 * a separately-invented mapping (HQ review §3).
 */
export function findFailedExecutionStageLabel(
  children: readonly ExecutionStageRowViewModel[] | undefined,
): string | null {
  const failed = children?.find((child) => child.status === "failed");
  if (failed === undefined) return null;
  return failed.label.charAt(0).toLowerCase() + failed.label.slice(1);
}
