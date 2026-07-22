import {
  InMemoryToolRegistry,
  type DiagnosticToolDefinition,
  type ToolRegistry,
} from "../tools/diagnostic-tool";

export interface RecordedToolExecution {
  readonly toolName: string;
  readonly input: unknown;
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
      // real execute() then throws — never converted into a success.
      recorder.push({ toolName: tool.name, input });
      return tool.execute(input);
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
