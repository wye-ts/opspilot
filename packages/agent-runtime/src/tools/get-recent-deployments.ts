import { z } from "zod";

import type { DiagnosticToolDefinition } from "./diagnostic-tool";

const InputSchema = z
  .object({
    serviceSlug: z.string().min(1).max(100),
  })
  .strict();

// No time-range parameter. A caller-supplied window would imply a "now" this
// tool does not have (it reads no clock — see SEEDED_DEPLOYMENTS_BY_SERVICE_SLUG
// below), and accepting one only to ignore it would be a schema that promises
// scoping it cannot perform. What "recent" means is defined by the fixture.

// Bounded, matching the spirit of get_service_status's fixed vocabulary: a tool
// must not be able to flood the conversation with an unbounded list.
const MAX_RETURNED_DEPLOYMENTS = 5;

const DeploymentRecordSchema = z
  .object({
    deploymentId: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
    // Closed vocabulary. Deliberately NOT a boolean "succeeded": a rollback is
    // a distinct fact from a failure, and collapsing them would destroy the
    // only distinction this tool contributes.
    outcome: z.enum(["SUCCEEDED", "FAILED", "ROLLED_BACK"]),
    // z.iso.datetime() rejects "yesterday", "2026-13-99", bare dates, local
    // offsets, and impossible calendar dates like 2026-02-30. A plain
    // z.string() would let a hand-edited fixture smuggle any of those past the
    // tool boundary, where the model would reason from them and the
    // most-recent-first ordering contract would silently break.
    deployedAt: z.iso.datetime(),
  })
  .strict();

const OutputSchema = z
  .object({
    serviceSlug: z.string().min(1).max(100),
    // THE load-bearing field. `deployments: []` is structurally ambiguous in a
    // way get_service_status's UNKNOWN enum is not: it could mean "this service
    // is known and has deployed nothing recently" (a real negative a model may
    // use to rule deployment out) or "this tool has never heard of this
    // service" (which supports nothing at all). Collapsing the two would let a
    // model ground "no recent deploys, so deployment is ruled out" on the mere
    // absence of a fixture entry — the same unearned-negative failure mode that
    // made get_service_status return UNKNOWN instead of defaulting to
    // OPERATIONAL.
    knownService: z.boolean(),
    deployments: z.array(DeploymentRecordSchema).max(MAX_RETURNED_DEPLOYMENTS),
  })
  .strict();

type DeploymentRecord = z.infer<typeof DeploymentRecordSchema>;

// A fixed, seeded lookup table — deterministic and free of network/clock reads,
// exactly like get_service_status's. Timestamps are fixture-fixed literals, not
// derived from Date.now(): a tool whose output changed with wall-clock time
// could not be asserted byte-identically by an evaluation case, and would be
// the first non-deterministic entry in the catalog.
//
// Ordering within each array is most-recent-first and is part of the contract.
//
// The three slugs are exactly those get_service_status knows, so the two tools
// describe one world a run can corroborate across, rather than two disjoint
// ones. Each carries a deliberately different evidential shape — see the
// per-entry notes, and get-recent-deployments.test.ts's "evidential shapes"
// block, which locks them because Issue #94's evaluation cases depend on them.
//
// A Map, not an object literal: an object's inherited keys (`constructor`,
// `toString`, `__proto__`, ...) are schema-valid strings a model can emit, and
// a plain `table[slug]` lookup would return an inherited FUNCTION rather than
// undefined for them — turning an ordinary unknown service into a crash that
// fails the whole investigation with TOOL_EXECUTION_FAILED. A Map has no
// prototype-chain lookup, so unknown is unknown for every string.
const SEEDED_DEPLOYMENTS_BY_SERVICE_SLUG: ReadonlyMap<
  string,
  readonly DeploymentRecord[]
> = new Map(Object.entries({
  // DEGRADED in get_service_status, and its most recent deployment was rolled
  // back. This is an unresolved LEAD, never a root cause: runbook chunk
  // runbook-deployment-rollback-001 requires an error-budget burn rate
  // tripling within ten minutes of the rollout AND reproducibility on the new
  // revision but not the previous one. This tool reports neither, and a
  // completed rollback may describe an already-remediated incident.
  "notification-service": [
    {
      deploymentId: "deploy-notification-0042",
      version: "4.2.0",
      outcome: "ROLLED_BACK",
      deployedAt: "2026-09-10T18:15:00.000Z",
    },
    {
      deploymentId: "deploy-notification-0041",
      version: "4.1.3",
      outcome: "SUCCEEDED",
      deployedAt: "2026-09-04T09:30:00.000Z",
    },
  ],
  // OUTAGE in get_service_status, with NO recent deployments. This is the one
  // shape that supports a genuine conclusion, and it is a negative one:
  // deployment is ruled OUT as a contributing factor. `knownService: true` is
  // what makes that inference legitimate rather than an argument from missing
  // data.
  "billing-service": [],
  // OPERATIONAL in get_service_status, with a failed deployment behind a later
  // successful one. Ambiguous on purpose: a FAILED deployment may never have
  // reached production at all, so this supports nothing in either direction.
  "auth-service": [
    {
      deploymentId: "deploy-auth-0113",
      version: "2.7.1",
      outcome: "SUCCEEDED",
      deployedAt: "2026-09-09T14:05:00.000Z",
    },
    {
      deploymentId: "deploy-auth-0112",
      version: "2.7.0",
      outcome: "FAILED",
      deployedAt: "2026-09-09T11:40:00.000Z",
    },
  ],
} satisfies Record<string, readonly DeploymentRecord[]>));

export const getRecentDeploymentsTool: DiagnosticToolDefinition = {
  name: "get_recent_deployments",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  async execute(rawInput) {
    const { serviceSlug } = InputSchema.parse(rawInput);
    const seeded = SEEDED_DEPLOYMENTS_BY_SERVICE_SLUG.get(serviceSlug);

    return {
      serviceSlug,
      knownService: seeded !== undefined,
      // Deep-copied, never the fixture's own array OR its record objects: the
      // orchestrator hands tool output onward as evidence, and a caller
      // mutating what it received must not be able to change what the next call
      // returns. A shallow [...seeded] was not enough — it copies the array
      // while sharing every record, so mutating one field corrupted the fixture
      // for the rest of the process and could make a later call's output fail
      // its own outputSchema (TOOL_OUTPUT_INVALID, which fails the whole run).
      deployments: seeded === undefined ? [] : seeded.map((entry) => ({ ...entry })),
    };
  },
};
