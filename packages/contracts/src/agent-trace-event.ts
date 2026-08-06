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
//
// Each branch is exported individually so packages/contracts/src/
// investigation-event.ts (issue #36's canonical execution-event contract)
// can reuse these exact schema objects for the three overlapping event
// types (RETRIEVAL_COMPLETED, TOOL_REQUESTED, TOOL_COMPLETED) plus the
// legacy REPORT_GENERATED read-compat variant, instead of redeclaring
// structurally-identical branches in a second, independently maintained
// union that could silently drift from this one. AgentTraceEventSchema's
// own shape/behavior is unchanged by this — still the same 4-branch
// discriminated union, still validates every existing persisted row and
// fixture identically.
export const RetrievalCompletedTraceEventSchema = z
  .object({
    type: z.literal("RETRIEVAL_COMPLETED"),
    chunks: z.array(RetrievalSummaryEntrySchema).readonly(),
  })
  .strict()
  .readonly();

export const ToolRequestedTraceEventSchema = z
  .object({
    type: z.literal("TOOL_REQUESTED"),
    toolCallId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
  })
  .strict()
  .readonly();

export const ToolCompletedTraceEventSchema = z
  .object({
    type: z.literal("TOOL_COMPLETED"),
    toolCallId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
  })
  .strict()
  .readonly();

// The proven meaning of this event, traced against
// packages/agent-runtime/src/agent/agent-orchestrator.ts: it is pushed only
// after ResolutionReportSchema validation AND evidence validation both
// succeed — never for a merely-submitted, not-yet-validated candidate
// report. Read-compatible with the new contract's REPORT_VALIDATED, never
// with REPORT_SUBMITTED. See docs/16-investigation-event-contract.md.
export const ReportGeneratedTraceEventSchema = z
  .object({
    type: z.literal("REPORT_GENERATED"),
  })
  .strict()
  .readonly();

export const AgentTraceEventSchema = z.discriminatedUnion("type", [
  RetrievalCompletedTraceEventSchema,
  ToolRequestedTraceEventSchema,
  ToolCompletedTraceEventSchema,
  ReportGeneratedTraceEventSchema,
]);

export type AgentTraceEvent = z.infer<typeof AgentTraceEventSchema>;
