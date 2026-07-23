import { z } from "zod";

// Mirrors apps/worker/src/agent/agent-orchestrator.ts's RetrievalSummaryEntry
// exactly: chunkId/rank/score only, never content/title/runbookId, and never
// raw embedding vectors. .readonly() preserves the original hand-written
// interface's `readonly` field modifiers so this relocation is a pure type
// move, not a behavior/type change.
export const RetrievalSummaryEntrySchema = z
  .object({
    chunkId: z.string().min(1).max(128),
    rank: z.number().int().positive(),
    score: z.number().finite(),
  })
  .strict()
  .readonly();

export type RetrievalSummaryEntry = z.infer<typeof RetrievalSummaryEntrySchema>;

// Mirrors apps/worker/src/agent/agent-orchestrator.ts's AgentTraceEvent
// exactly, including its readonly field/array modifiers. Only these four
// variants are ever produced by the current orchestrator
// (docs/04-agent-design.md §16.1 describes a larger future event vocabulary
// that this milestone's persistence layer does not implement — see
// docs/11-agent-run-persistence.md).
export const AgentTraceEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("RETRIEVAL_COMPLETED"),
      chunks: z.array(RetrievalSummaryEntrySchema).readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("TOOL_REQUESTED"),
      toolCallId: z.string().min(1).max(128),
      toolName: z.string().min(1).max(128),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("TOOL_COMPLETED"),
      toolCallId: z.string().min(1).max(128),
      toolName: z.string().min(1).max(128),
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("REPORT_GENERATED"),
    })
    .strict()
    .readonly(),
]);

export type AgentTraceEvent = z.infer<typeof AgentTraceEventSchema>;
