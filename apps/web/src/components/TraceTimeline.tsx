import type { AgentTraceEvent } from "../api/types";
import { presentTraceProductLabel, traceTechnicalEntries } from "../trace/trace-product-labels";
import { TechnicalDetails } from "./TechnicalDetails";

export interface TraceTimelineProps {
  readonly trace: readonly AgentTraceEvent[];
}

type TraceItemStatus = "completed" | "running" | "neutral";

/**
 * Issue #41 polish §11 — Agent Activity is a secondary execution log, NOT a
 * second primary timeline. Each item carries a compact checklist glyph:
 * completed = green check, running = small blue dot (a tool request whose
 * matching completion has not arrived yet), anything unknown = a restrained
 * neutral dot. No numbered 1/2/3 circles, no bold oversized rows.
 */
function traceItemStatus(
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

const TRACE_ITEM_GLYPH: Readonly<Record<TraceItemStatus, string>> = {
  completed: "✓",
  running: "●",
  neutral: "•",
};

// Array order is the ordering source — the repository produced it with
// sequence_number ASC and the API forwards it unsorted; this component NEVER
// re-sorts. No per-event timestamp exists over the wire, so activity order is
// the array order only, never invented clock times.
export function TraceTimeline({ trace }: TraceTimelineProps) {
  if (trace.length === 0) {
    return <p className="trace-timeline-empty">No trace events were recorded for this run.</p>;
  }

  const technicalRows = traceTechnicalEntries(trace).map((entry) => ({
    label: entry.toolName,
    value: entry.toolCallId !== undefined ? entry.toolCallId : entry.toolName,
  }));

  return (
    <>
      <ol className="trace-timeline">
        {trace.map((event, index) => {
          const presentation = presentTraceProductLabel(event);
          const status = traceItemStatus(trace, index, event);
          return (
            <li
              key={index}
              className={`trace-timeline-item trace-timeline-item--${status}`}
            >
              <span className={`trace-timeline-step trace-timeline-step--${status}`} aria-hidden="true">
                {TRACE_ITEM_GLYPH[status]}
              </span>
              <div className="trace-timeline-content">
                <p className="trace-timeline-label">{presentation.label}</p>
                {presentation.detail !== null ? (
                  <p className="trace-timeline-detail">{presentation.detail}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <TechnicalDetails rows={technicalRows} />
    </>
  );
}
