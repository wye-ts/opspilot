import type { DiagnosticToolDefinition } from "@opspilot/agent-runtime";
import { z } from "zod";

// Evaluation-only fixture — never registered in production/demo/live-spike
// tool wiring. Its input schema accepts only `{}`, matching case 13's
// scripted `input: {}`; execute() always throws, to exercise
// TOOL_EXECUTION_FAILED deterministically.
export const alwaysFailsTool: DiagnosticToolDefinition = {
  name: "always_fails",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({}).strict(),
  async execute() {
    throw new Error("always_fails: deterministic evaluation-only failure");
  },
};
