import type { AgentTraceEvent } from "../api/types";
import { presentTraceEvent } from "../trace/trace-presentation";

export interface TraceTimelineProps {
  readonly trace: readonly AgentTraceEvent[];
}

// Array order is the ordering source — the repository produced it with
// sequence_number ASC and the API forwards it unsorted; this component NEVER
// re-sorts. No per-event timestamp exists over the wire, so steps are
// labeled with 1-based ordinals only, never invented clock times.
export function TraceTimeline({ trace }: TraceTimelineProps) {
  if (trace.length === 0) {
    return <p className="trace-timeline-empty">No trace events were recorded for this run.</p>;
  }

  return (
    <ol className="trace-timeline">
      {trace.map((event, index) => {
        const presentation = presentTraceEvent(event);
        return (
          <li key={index} className="trace-timeline-item">
            <span className="trace-timeline-step" aria-hidden="true">
              {index + 1}
            </span>
            <div className="trace-timeline-content">
              <p className="trace-timeline-label">
                Step {index + 1}: {presentation.label}
              </p>
              <p className="trace-timeline-detail">{presentation.detail}</p>
              {presentation.toolCallId !== undefined ? (
                <p className="trace-timeline-tool-call-id mono" title={presentation.toolCallId}>
                  {presentation.toolCallId}
                </p>
              ) : null}
              {presentation.chunkRows !== undefined && presentation.chunkRows.length > 0 ? (
                <ul className="trace-timeline-chunks">
                  {presentation.chunkRows.map((row) => (
                    <li key={row.chunkId} className="mono">
                      #{row.rank} · {row.chunkId} · {row.score}
                    </li>
                  ))}
                  {presentation.moreChunksCount !== undefined ? <li>+{presentation.moreChunksCount} more</li> : null}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
