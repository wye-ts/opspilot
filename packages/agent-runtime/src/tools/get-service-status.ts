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
//
// A Map, not an object literal (issue #96): an object's inherited keys
// ("constructor", "toString", "__proto__", ...) are schema-valid strings a
// model can emit, and a plain `table[slug]` lookup returns an inherited
// FUNCTION rather than undefined for them — so `?? "UNKNOWN"` never fires, the
// returned `status` is not a status, and outputSchema rejects it, failing the
// WHOLE run with TOOL_OUTPUT_INVALID instead of answering UNKNOWN. A Map has no
// prototype-chain lookup, so unknown is unknown for every string. Same idiom as
// get-recent-deployments.ts, for the same reason.
const SEEDED_STATUS_BY_SERVICE_SLUG: ReadonlyMap<
  string,
  "OPERATIONAL" | "DEGRADED" | "OUTAGE"
> = new Map(
  Object.entries({
    "notification-service": "DEGRADED",
    "billing-service": "OUTAGE",
    "auth-service": "OPERATIONAL",
  } satisfies Record<string, "OPERATIONAL" | "DEGRADED" | "OUTAGE">),
);

export const getServiceStatusTool: DiagnosticToolDefinition = {
  name: "get_service_status",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  async execute(rawInput) {
    const { serviceSlug } = InputSchema.parse(rawInput);
    const seededStatus = SEEDED_STATUS_BY_SERVICE_SLUG.get(serviceSlug);

    return {
      serviceSlug,
      status: seededStatus ?? "UNKNOWN",
    };
  },
};
