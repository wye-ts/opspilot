import type { InvestigationEventRecord, InvestigationEventRecordPayload } from "@opspilot/contracts";

import type { ExecutionStageDerivation } from "../investigation-progress/execution-stage-derivation";
import type { AgentTraceEvent } from "../api/types";
import {
  presentInvestigationActivityLabel,
  presentTraceProductLabel,
  traceTechnicalEntries,
  type TraceProductLabel,
} from "../trace/trace-product-labels";
import { TechnicalDetails } from "./TechnicalDetails";

export interface TraceTimelineProps {
  readonly trace: readonly AgentTraceEvent[];
  /**
   * The canonical investigation-event stream (Issue #56). Optional and
   * defaults to `[]` — a caller that hasn't wired polling/canonical events at
   * all (or an existing test constructed before #56) gets the exact legacy
   * behavior below via `executionStageDerivation`'s own default.
   */
  readonly events?: readonly InvestigationEventRecord[];
  /**
   * The SAME reducer-validated derivation the Investigation Progress
   * Timeline already computes and trusts (`App.tsx`'s
   * `deriveInvestigationProgressStages` call site) — never re-derived here,
   * and never gated on the weaker `hasCanonicalInvestigationLifecycleMarker`
   * origin-only check alone (independent review, initial Codex pass,
   * MAJOR — a marker-bearing but reducer-REJECTED stream must never be
   * rendered as trusted activity, since the marker only proves the stream's
   * FORMAT, not its validity).
   *
   * Defaults to `{ kind: "legacy" }` — the same default `App.tsx` uses for a
   * fresh/unwired call site — so every pre-#56 caller (including every
   * existing test) renders exactly as before.
   */
  readonly executionStageDerivation?: ExecutionStageDerivation;
}

type TraceItemStatus = "completed" | "running" | "failed" | "neutral";

/**
 * Issue #41 polish §11 — Agent Activity is a secondary execution log, NOT a
 * second primary timeline. Each item carries a compact checklist glyph:
 * completed = green check, running = small blue dot (a tool request whose
 * matching completion has not arrived yet), failed = red X (Issue #56 — a
 * tool request whose matching failure HAS arrived, or a canonical event that
 * is itself a terminal/validation failure fact), anything unknown = a
 * restrained neutral dot. No numbered 1/2/3 circles, no bold oversized rows.
 */
function legacyTraceItemStatus(
  trace: readonly AgentTraceEvent[],
  index: number,
  event: AgentTraceEvent,
): TraceItemStatus {
  if (event.type === "TOOL_REQUESTED") {
    // A tool request is in-flight until its matching completion appears later
    // in the same ordered stream. No invented timers — purely grounded in the
    // observed trace.
    const callId = event.toolCallId;
    const completed = trace.some(
      (other, i) =>
        i > index && other.type === "TOOL_COMPLETED" && other.toolCallId === callId,
    );
    return completed ? "completed" : "running";
  }
  switch (event.type) {
    case "TOOL_COMPLETED":
    case "RETRIEVAL_COMPLETED":
    case "REPORT_GENERATED":
      return "completed";
    default:
      return "neutral";
  }
}

/**
 * Issue #56 — the canonical counterpart to `legacyTraceItemStatus`, over the
 * wider `InvestigationEventRecordPayload` union.
 *
 * Fixes a pre-existing bug that was invisible before this issue: a
 * `TOOL_REQUESTED` whose matching outcome is a `TOOL_FAILED` (never a
 * `TOOL_COMPLETED`) must resolve to `"failed"`, not stay `"running"` forever
 * — independent review (initial Codex pass, MAJOR) caught that the original
 * draft of this issue's plan reused the legacy completed-only lookahead
 * unchanged, which would have shown a real, terminal tool failure as
 * perpetually in-flight.
 *
 * Every one of the 7 new canonical types gets an INTENTIONAL status, not a
 * fallback-by-omission (independent review, second pass, MINOR): the success
 * facts (`REPORT_VALIDATED`, `RUN_COMPLETED`) resolve to `"completed"` —
 * `REPORT_VALIDATED` in particular must match legacy `REPORT_GENERATED`'s
 * existing `"completed"` glyph exactly, or canonical rendering would be a
 * REGRESSION on this one row rather than the strict superset this issue
 * promises. The failure facts (`TOOL_FAILED`, `REPORT_VALIDATION_FAILED`,
 * `RUN_FAILED`) resolve to `"failed"`. The remaining lifecycle-only markers
 * (`RUN_CREATED`, `AGENT_STARTED`, `REPORT_GENERATION_STARTED`,
 * `REPORT_SUBMITTED`) resolve to `"neutral"` — they describe something
 * starting or underway, always superseded by a completed/failed fact later
 * in the same stream.
 */
function canonicalTraceItemStatus(
  events: readonly InvestigationEventRecordPayload[],
  index: number,
  payload: InvestigationEventRecordPayload,
): TraceItemStatus {
  if (payload.type === "TOOL_REQUESTED") {
    const callId = payload.toolCallId;
    const later = events.slice(index + 1);
    if (later.some((e) => e.type === "TOOL_COMPLETED" && e.toolCallId === callId)) return "completed";
    if (later.some((e) => e.type === "TOOL_FAILED" && e.toolCallId === callId)) return "failed";
    return "running";
  }
  switch (payload.type) {
    case "TOOL_COMPLETED":
    case "RETRIEVAL_COMPLETED":
    case "REPORT_GENERATED":
    case "REPORT_VALIDATED":
    case "RUN_COMPLETED":
      return "completed";
    case "TOOL_FAILED":
    case "REPORT_VALIDATION_FAILED":
    case "RUN_FAILED":
      return "failed";
    case "RUN_CREATED":
    case "AGENT_STARTED":
    case "REPORT_GENERATION_STARTED":
    case "REPORT_SUBMITTED":
      return "neutral";
    default:
      return "neutral";
  }
}

const TRACE_ITEM_GLYPH: Readonly<Record<TraceItemStatus, string>> = {
  completed: "✓",
  running: "●",
  failed: "✕",
  neutral: "•",
};

interface TraceActivityItem {
  readonly key: number;
  readonly status: TraceItemStatus;
  readonly presentation: TraceProductLabel;
}

// Issue #56: deliberately distinct wording from the Progress Timeline's own
// canonical-invalid note (`investigation-progress-stages.ts`'s
// `deriveCanonicalChildren`) — the two timelines are independent surfaces
// with their own vocabularies (docs/14-web-ui.md §6.1's "two timelines,
// deliberately not one"), and Agent Activity has no "frozen last-good
// events" concept to fall back to the way the Progress Timeline's stage rows
// do (`ExecutionStageDerivation.canonical-invalid.lastGoodStages` holds only
// 4 STAGE summaries, never raw investigation events) — so this message
// covers BOTH `lastGoodStages` cases uniformly, unlike the Progress
// Timeline's split behavior.
const CANONICAL_INVALID_MESSAGE = "Agent activity detail isn't available for this run right now.";

// Array order is the ordering source — the repository produced it with
// sequence_number ASC and the API forwards it unsorted; this component NEVER
// re-sorts. No per-event timestamp exists over the wire, so activity order is
// the array order only, never invented clock times.
export function TraceTimeline({
  trace,
  events = [],
  executionStageDerivation = { kind: "legacy" },
}: TraceTimelineProps) {
  // Issue #56: branch on the reducer-VALIDATED derivation, never on origin
  // alone — see the `executionStageDerivation` doc comment above for why.
  let items: readonly TraceActivityItem[] | null;
  let technicalRows: readonly { readonly label: string; readonly value: string }[];

  if (executionStageDerivation.kind === "canonical-invalid") {
    // Fail closed: a marker-bearing but reducer-REJECTED stream renders no
    // canonical detail and never falls back to the legacy `trace` — falling
    // back would silently fabricate a plausible-looking legacy timeline for
    // data the reducer has already proven corrupt (docs/16 §6).
    items = null;
    technicalRows = [];
  } else if (executionStageDerivation.kind === "canonical") {
    const payloads = events.map((e) => e.payload);
    items = events.map((event, index) => ({
      key: event.sequence,
      status: canonicalTraceItemStatus(payloads, index, event.payload),
      presentation: presentInvestigationActivityLabel(event.payload),
    }));
    technicalRows = traceTechnicalEntries(payloads).map((entry) => ({
      label: entry.toolName,
      value: entry.toolCallId !== undefined ? entry.toolCallId : entry.toolName,
    }));
  } else {
    // "legacy" — no canonical stream at all (pre-#37 run, or none started
    // yet). Renders exactly as this component always has.
    items = trace.map((event, index) => ({
      key: index,
      status: legacyTraceItemStatus(trace, index, event),
      presentation: presentTraceProductLabel(event),
    }));
    technicalRows = traceTechnicalEntries(trace).map((entry) => ({
      label: entry.toolName,
      value: entry.toolCallId !== undefined ? entry.toolCallId : entry.toolName,
    }));
  }

  if (items === null) {
    return <p className="trace-timeline-unavailable">{CANONICAL_INVALID_MESSAGE}</p>;
  }

  if (items.length === 0) {
    return <p className="trace-timeline-empty">No trace events were recorded for this run.</p>;
  }

  return (
    <>
      <ol className="trace-timeline">
        {items.map((item) => (
          <li
            key={item.key}
            className={`trace-timeline-item trace-timeline-item--${item.status}`}
          >
            <span className={`trace-timeline-step trace-timeline-step--${item.status}`} aria-hidden="true">
              {TRACE_ITEM_GLYPH[item.status]}
            </span>
            <div className="trace-timeline-content">
              <p className="trace-timeline-label">{item.presentation.label}</p>
              {item.presentation.detail !== null ? (
                <p className="trace-timeline-detail">{item.presentation.detail}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <TechnicalDetails rows={technicalRows} />
    </>
  );
}
