import type { DiagnosticToolDefinition } from "./diagnostic-tool";
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

/**
 * Every diagnostic tool the agent may be offered. Ordering is stable so a
 * provider's tool list is deterministic across runs.
 */
export const DIAGNOSTIC_TOOL_CATALOG: readonly DiagnosticToolCatalogEntry[] = [
  GET_SERVICE_STATUS_CATALOG_ENTRY,
];
