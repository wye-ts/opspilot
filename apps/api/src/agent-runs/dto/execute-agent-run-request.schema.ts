import { z } from "zod";

// Accepts an absent body, `{}`, or an explicit provider mode. Absent-only
// normalization — `value === undefined ? {} : value` — deliberately, not
// `value ?? {}`, so an explicit `null` body is still rejected rather than
// coerced to `{}` (see docs/12-agent-run-api.md).
//
// `providerMode` was added in PR 6B1 and is optional, which is what keeps
// every existing caller working unchanged: the web client, the demo script,
// and the integration suite all send an absent body or `{}` and continue to
// get the server's default request mode (AGENT_RUN_PROVIDER_MODE, itself
// defaulting to FAKE).
//
// `.strict()` still rejects unknown keys, and the enum rejects any value other
// than the two supported modes — both surface as REQUEST_BODY_INVALID (400)
// through the shared validation pipe. A misspelled mode must never be treated
// as "use the default", because that would silently run the wrong provider.
export const ExecuteAgentRunRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z
    .object({
      providerMode: z.enum(["FAKE", "LIVE"]).optional(),
    })
    .strict(),
);

export type ExecuteAgentRunRequest = z.infer<typeof ExecuteAgentRunRequestSchema>;
