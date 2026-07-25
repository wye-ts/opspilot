import type { AgentTraceEvent } from "../api/types";

const MAX_CHUNK_ROWS = 5;

export interface ChunkSummaryRow {
  readonly rank: number;
  readonly chunkId: string;
  readonly score: string;
}

export interface TracePresentation {
  readonly label: string;
  readonly detail: string;
  readonly toolCallId?: string;
  readonly chunkRows?: readonly ChunkSummaryRow[];
  readonly moreChunksCount?: number;
}

// Pure AgentTraceEvent -> presentation mapping, tested independently of
// React (see trace-presentation.test.ts). Renders every contract variant
// exhaustively, plus a safe fallback for anything not in the current union —
// the fallback prints only the `type` string, never a blind JSON.stringify
// of an unknown payload.
export function presentTraceEvent(event: AgentTraceEvent): TracePresentation {
  switch (event.type) {
    case "TOOL_REQUESTED":
      return { label: "Tool requested", detail: event.toolName, toolCallId: event.toolCallId };
    case "TOOL_COMPLETED":
      return { label: "Tool completed", detail: event.toolName, toolCallId: event.toolCallId };
    case "REPORT_GENERATED":
      return { label: "Report generated", detail: "The agent submitted its resolution report." };
    case "RETRIEVAL_COMPLETED": {
      const rows = event.chunks.slice(0, MAX_CHUNK_ROWS).map((chunk) => ({
        rank: chunk.rank,
        chunkId: chunk.chunkId,
        score: chunk.score.toFixed(3),
      }));
      const moreCount = event.chunks.length - rows.length;
      return {
        label: "Runbook retrieval completed",
        detail: `${event.chunks.length} chunk${event.chunks.length === 1 ? "" : "s"} retrieved`,
        chunkRows: rows,
        ...(moreCount > 0 ? { moreChunksCount: moreCount } : {}),
      };
    }
    default: {
      const unknown = event as { type: string };
      return { label: "Unknown event", detail: unknown.type };
    }
  }
}
