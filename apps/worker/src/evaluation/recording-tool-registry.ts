import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { DiagnosticToolDefinition, ToolRegistry } from "@opspilot/agent-runtime";

const { InMemoryToolRegistry } = opspilotAgentRuntime;

export interface RecordedToolExecution {
  readonly toolName: string;
  readonly input: unknown;
  // Present only when the wrapped execute() returned successfully — a thrown
  // execute leaves the attempt output-less, so a failed execution is never
  // fabricated into a completed tool with output (see observed-facts.ts §4.3).
  readonly output?: unknown;
}

function wrapForRecording(
  tool: DiagnosticToolDefinition,
  recorder: RecordedToolExecution[],
): DiagnosticToolDefinition {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    async execute(input: unknown): Promise<unknown> {
      // Recorded before delegating, so an attempt is captured even when the
      // real execute() then throws — never converted into a success. The
      // mutable local keeps the capture-before-delegate ordering while still
      // attaching `output` only after a successful return.
      const entry: { toolName: string; input: unknown; output?: unknown } = { toolName: tool.name, input };
      recorder.push(entry);
      const output = await tool.execute(input);
      entry.output = output;
      return output;
    },
  };
}

// Wraps each definition's execute() before constructing the existing
// InMemoryToolRegistry, so lookup/find behavior is entirely the real
// registry's — this never reimplements lookup, input/output validation, or
// error mapping, all of which stay in the orchestrator/registry.
export function createRecordingToolRegistry(
  tools: readonly DiagnosticToolDefinition[],
  recorder: RecordedToolExecution[],
): ToolRegistry {
  return new InMemoryToolRegistry(tools.map((tool) => wrapForRecording(tool, recorder)));
}
