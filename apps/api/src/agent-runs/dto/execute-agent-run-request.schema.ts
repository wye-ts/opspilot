import { z } from "zod";

// Accepts only an absent body or `{}`. Absent-only normalization —
// `value === undefined ? {} : value` — deliberately, not `value ?? {}`,
// so an explicit `null` body is rejected rather than coerced to `{}`
// (see docs/12-agent-run-api.md).
export const ExecuteAgentRunRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({}).strict(),
);
