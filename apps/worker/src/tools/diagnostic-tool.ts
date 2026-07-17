import type { z } from "zod";

/**
 * Non-generic on purpose: storing tool definitions with different concrete
 * TInput/TOutput in one ToolRegistry runs into function-parameter variance
 * problems ((input: SpecificInput) => ... is not assignable to
 * (input: unknown) => ...). Concrete tool modules do their own internal
 * typing against their own schemas; the registry and orchestrator only ever
 * see `unknown` at this boundary and rely on inputSchema/outputSchema to
 * validate it (docs/04-agent-design.md §12 steps 4/8).
 */
export interface DiagnosticToolDefinition {
  readonly name: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  // Callers (the orchestrator) must only invoke this with input that has
  // already been validated against inputSchema.
  execute(input: unknown): Promise<unknown>;
}

export interface ToolRegistry {
  find(name: string): DiagnosticToolDefinition | undefined;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly toolsByName: ReadonlyMap<string, DiagnosticToolDefinition>;

  constructor(tools: readonly DiagnosticToolDefinition[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  find(name: string): DiagnosticToolDefinition | undefined {
    return this.toolsByName.get(name);
  }
}
