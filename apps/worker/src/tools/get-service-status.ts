import { z } from "zod";

import type { DiagnosticToolDefinition } from "./diagnostic-tool";

const InputSchema = z
  .object({
    serviceSlug: z.string().min(1).max(100),
  })
  .strict();

const OutputSchema = z
  .object({
    serviceSlug: z.string().min(1).max(100),
    status: z.enum(["OPERATIONAL", "DEGRADED", "OUTAGE", "UNKNOWN"]),
  })
  .strict();

// A fixed, seeded lookup table — deterministic and free of network/clock
// reads, matching docs/04-agent-design.md §21's fake-provider-adjacent
// determinism requirement for tests. A serviceSlug outside this table is
// genuinely unknown to the agent, not OPERATIONAL: defaulting to
// OPERATIONAL would assert an unsupported operational-status claim.
const SEEDED_STATUS_BY_SERVICE_SLUG: Readonly<
  Record<string, "OPERATIONAL" | "DEGRADED" | "OUTAGE">
> = {
  "notification-service": "DEGRADED",
  "billing-service": "OUTAGE",
  "auth-service": "OPERATIONAL",
};

export const getServiceStatusTool: DiagnosticToolDefinition = {
  name: "get_service_status",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  async execute(rawInput) {
    const { serviceSlug } = InputSchema.parse(rawInput);
    const seededStatus = SEEDED_STATUS_BY_SERVICE_SLUG[serviceSlug];

    return {
      serviceSlug,
      status: seededStatus ?? "UNKNOWN",
    };
  },
};
