import type { InvestigationEventRecordPayload } from "@opspilot/contracts";

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
const UNKNOWN_TOOL_FAILED = "Diagnostic tool failed";

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
 * Compile-time exhaustiveness guard, matching the pattern already used by
 * `packages/contracts/src/investigation-lifecycle-compatibility.ts`'s
 * `projectToLegacyAgentTraceEvent`. If a 14th canonical/legacy payload type
 * is ever added and this switch is not updated, `value` stops being `never`
 * and this call fails to compile.
 */
function assertNeverActivityPayload(value: never): TraceProductLabel {
  const unknown = value as { type: string };
  return { label: "Agent activity recorded", detail: unknown.type };
}

/**
 * Issue #56 — Agent Activity's product-language mapping over the canonical
 * `InvestigationEventRecordPayload` union (13 types: the 12 new-write
 * canonical types plus the one legacy read-compat `REPORT_GENERATED`).
 *
 * The 4 types Agent Activity already covered via `presentTraceProductLabel`
 * keep BYTE-IDENTICAL wording here — no tone drift for what's already
 * shipped (verified by a dedicated parity test). `REPORT_VALIDATED` reuses
 * the exact same copy as legacy `REPORT_GENERATED`, since it is documented
 * (`packages/contracts/src/agent-trace-event.ts`) to mean exactly what that
 * legacy type has always meant.
 *
 * As with `presentTraceProductLabel`, no raw failure code, tool name beyond
 * the existing allowlist, or other payload field is ever interpolated into
 * a label.
 */
export function presentInvestigationActivityLabel(payload: InvestigationEventRecordPayload): TraceProductLabel {
  switch (payload.type) {
    case "TOOL_REQUESTED": {
      const action = TOOL_PRODUCT_ACTIONS[payload.toolName]?.requested;
      return action !== undefined ? { label: action, detail: null } : { label: UNKNOWN_TOOL_REQUESTED, detail: null };
    }
    case "TOOL_COMPLETED": {
      const action = TOOL_PRODUCT_ACTIONS[payload.toolName]?.completed;
      return action !== undefined ? { label: action, detail: null } : { label: UNKNOWN_TOOL_COMPLETED, detail: null };
    }
    case "TOOL_FAILED": {
      const action = TOOL_PRODUCT_ACTIONS[payload.toolName];
      return action !== undefined
        ? { label: `${action.requested} — failed`, detail: null }
        : { label: UNKNOWN_TOOL_FAILED, detail: null };
    }
    case "RETRIEVAL_COMPLETED":
      return {
        label: "Runbook retrieval completed",
        detail: `${payload.chunks.length} chunk${payload.chunks.length === 1 ? "" : "s"} retrieved`,
      };
    case "REPORT_GENERATED":
    case "REPORT_VALIDATED":
      return { label: "Resolution report generated", detail: null };
    case "RUN_CREATED":
      return { label: "Investigation created", detail: null };
    case "AGENT_STARTED":
      return { label: "Agent started analyzing the ticket", detail: null };
    case "REPORT_GENERATION_STARTED":
      return { label: "Preparing the final report", detail: null };
    case "REPORT_SUBMITTED":
      return { label: "Report submitted for validation", detail: null };
    case "REPORT_VALIDATION_FAILED":
      return { label: "Report failed validation", detail: null };
    case "RUN_COMPLETED":
      return { label: "Investigation completed", detail: null };
    case "RUN_FAILED":
      return { label: "Investigation failed", detail: null };
    default:
      return assertNeverActivityPayload(payload);
  }
}

/** The minimal shape `traceTechnicalEntries` needs from a TOOL_REQUESTED item — satisfied by both the legacy `AgentTraceEvent` union and the canonical `InvestigationEventRecordPayload` union. */
interface ToolRequestedLike {
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

/**
 * The raw tool name + call id pairs worth disclosing under Technical details.
 * Only grounded, sanitized identifiers — never prompts, arguments, payloads,
 * secrets, or provider internals.
 *
 * Accepts either the legacy `AgentTraceEvent[]` or the canonical
 * `InvestigationEventRecordPayload[]` — both carry the identical
 * `toolName`/`toolCallId` shape on their `TOOL_REQUESTED` variant (Issue #56;
 * see `packages/contracts/src/investigation-event.ts`'s
 * `ToolRequestedTraceEventBaseSchema` — the two are structurally the same
 * fields by construction, not a coincidence this cast relies on unsafely).
 */
export function traceTechnicalEntries(trace: readonly ToolRequestedLike[]): readonly {
  readonly toolName: string;
  readonly toolCallId?: string;
}[] {
  return trace
    .filter((event): event is ToolRequestedLike & { toolName: string } => event.type === "TOOL_REQUESTED")
    .map((event) => ({
      toolName: event.toolName,
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
    }));
}
