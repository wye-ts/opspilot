import type { AgentTraceEvent } from "../api/types";

export interface TraceProductLabel {
  /** Primary, readable, deterministic product language for this trace event. */
  readonly label: string;
  /**
   * Optional supporting detail line. Present only when the raw event carries
   * grounded data that reads naturally as product language — never a
   * blind dump of provider payload.
   */
  readonly detail: string | null;
}

/**
 * Deterministic tool-name -> product-language action.
 *
 * Only tools whose semantics are grounded in this repository belong here.
 * Everything else degrades safely to a generic phrasing below — the raw tool
 * name still surfaces in the Technical details disclosure, but never as the
 * primary Agent Activity copy.
 */
const TOOL_PRODUCT_ACTIONS: Readonly<Record<string, { readonly requested: string; readonly completed: string }>> = {
  get_service_status: { requested: "Checking service status", completed: "Checked service status" },
};

const UNKNOWN_TOOL_REQUESTED = "Running a diagnostic tool";
const UNKNOWN_TOOL_COMPLETED = "Diagnostic tool completed";

/**
 * Pure AgentTraceEvent -> product-language mapping, tested independently of
 * React (see trace/trace-product-labels.test.ts). Agent Activity is
 * trace/observability — readable, derived deterministically from real event
 * semantics, and never inventing prototype-only facts.
 */
export function presentTraceProductLabel(event: AgentTraceEvent): TraceProductLabel {
  switch (event.type) {
    case "TOOL_REQUESTED": {
      const action = TOOL_PRODUCT_ACTIONS[event.toolName]?.requested;
      return action !== undefined ? { label: action, detail: null } : { label: UNKNOWN_TOOL_REQUESTED, detail: null };
    }
    case "TOOL_COMPLETED": {
      const action = TOOL_PRODUCT_ACTIONS[event.toolName]?.completed;
      return action !== undefined ? { label: action, detail: null } : { label: UNKNOWN_TOOL_COMPLETED, detail: null };
    }
    case "REPORT_GENERATED":
      return { label: "Resolution report generated", detail: null };
    case "RETRIEVAL_COMPLETED":
      return {
        label: "Runbook retrieval completed",
        detail: `${event.chunks.length} chunk${event.chunks.length === 1 ? "" : "s"} retrieved`,
      };
    default: {
      const unknown = event as { type: string };
      return { label: "Agent activity recorded", detail: unknown.type };
    }
  }
}

/**
 * The raw tool name + call id pairs worth disclosing under Technical details.
 * Only grounded, sanitized identifiers — never prompts, arguments, payloads,
 * secrets, or provider internals.
 */
export function traceTechnicalEntries(trace: readonly AgentTraceEvent[]): readonly {
  readonly toolName: string;
  readonly toolCallId?: string;
}[] {
  return trace
    .filter((event) => event.type === "TOOL_REQUESTED")
    .map((event) => ({
      toolName: event.toolName,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
    }));
}
