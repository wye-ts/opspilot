import type { DiagnosticToolDefinition } from "./diagnostic-tool";
import { getRecentDeploymentsTool } from "./get-recent-deployments";
import { getServiceStatusTool } from "./get-service-status";

/**
 * A tool plus the natural-language description a model is shown when the tool
 * is offered to it.
 *
 * The description lives here, next to the tool, rather than at each call site:
 * it describes an OpsPilot capability, not an Anthropic concept, so it is
 * provider-neutral and belongs in the runtime package. It previously existed
 * as two byte-identical string literals in apps/worker/src/demo — one per
 * spike runner — which is exactly the drift risk a single catalog removes.
 */
export interface DiagnosticToolCatalogEntry {
  readonly tool: DiagnosticToolDefinition;
  readonly description: string;
}

export const GET_SERVICE_STATUS_CATALOG_ENTRY: DiagnosticToolCatalogEntry = {
  tool: getServiceStatusTool,
  description:
    "Look up the current operational status (OPERATIONAL, DEGRADED, OUTAGE, or UNKNOWN) of a named internal service.",
};

export const GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY: DiagnosticToolCatalogEntry = {
  tool: getRecentDeploymentsTool,
  description:
    "Look up the recent deployment history of a named internal service. Returns " +
    "`knownService` plus a list of deployments (most recent first), each with an " +
    "outcome of SUCCEEDED, FAILED, or ROLLED_BACK. Read the two empty-list cases " +
    "differently: `knownService: true` with no deployments means the service is " +
    "known and has not deployed recently, which is evidence that deployment is " +
    "not a contributing factor; `knownService: false` means this tool has no " +
    "record of the service at all and supports no conclusion in either " +
    "direction. A recent FAILED or ROLLED_BACK deployment is a lead to " +
    "investigate, not a root cause on its own — it does not establish that the " +
    "deployment caused the current problem.",
};

/**
 * Every diagnostic tool the agent may be offered. Ordering is stable so a
 * provider's tool list is deterministic across runs.
 *
 * This array is the single source of truth for BOTH what a provider offers and
 * what a registry can execute. Those two were once wired separately — the
 * provider defaulted to this catalog while apps/api hand-listed its registry
 * contents — which meant appending an entry here would have made LIVE runs
 * offer a tool the registry could not resolve, failing every run with
 * TOOL_NOT_FOUND. Build registries from this array (or from an explicit,
 * deliberately-pinned subset), never from a second hand-maintained list.
 */
export const DIAGNOSTIC_TOOL_CATALOG: readonly DiagnosticToolCatalogEntry[] = [
  GET_SERVICE_STATUS_CATALOG_ENTRY,
  GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY,
];

/**
 * The catalog's tools, in catalog order — the shape a ToolRegistry consumes.
 * Exists so no call site has to re-derive `.map((entry) => entry.tool)` and
 * risk drifting from the catalog it is supposed to mirror.
 */
export const DIAGNOSTIC_TOOLS: readonly DiagnosticToolDefinition[] = DIAGNOSTIC_TOOL_CATALOG.map(
  (entry) => entry.tool,
);
