import type { AgentTraceEvent } from "./agent-trace-event";
import type { InvestigationEventRecord } from "./investigation-event";

/**
 * An ORIGIN marker — deliberately NOT lifecycle validation, and not a
 * well-formedness check of any kind.
 *
 * It answers exactly one question:
 *
 *   Was this event stream written in the canonical (#37) lifecycle format,
 *   rather than the historical four-type `AgentTraceEvent` legacy format?
 *
 * The answer depends only on origin evidence: a canonical writer always
 * records `RUN_CREATED` first, and the pre-#36 orchestrator never could,
 * because that concept did not exist. So `RUN_CREATED` at sequence 1 is
 * proof of format, and nothing else is consulted — deliberately including
 * `runStatus`, which is why that parameter is not part of the signature.
 * Origin detection does not need status.
 *
 * CRITICALLY: a canonical stream that is CORRUPT is still canonical. A
 * missing terminal event, a runStatus/terminal mismatch, an event after a
 * terminal event, or a duplicated lifecycle fact all leave this returning
 * `true`. Those are reducer validation failures, not reasons to reclassify
 * canonical data as legacy — doing so would route genuinely broken
 * canonical data into the frontend's legacy inference path, silently
 * rendering a plausible Timeline for a history that should have raised an
 * error. Misclassifying corruption as "old data" is worse than rejecting it.
 *
 * An EMPTY stream returns `false`: there is no origin evidence at all, so
 * the format cannot be proven and #38 should use its legacy/empty fallback.
 * The reducer separately accepts an explicitly selected empty `RUNNING`
 * prefix, but that is the caller's choice, not something marker-based
 * auto-detection can establish.
 *
 * Full validation lives in exactly one place — `deriveExecutionStageProgress`
 * — which rejects malformed canonical histories with typed
 * `InvestigationEventContractError` codes. The state machine is not
 * duplicated here.
 *
 * See docs/16-investigation-event-contract.md §6.
 */
export function hasCanonicalInvestigationLifecycleMarker(
  events: readonly InvestigationEventRecord[],
): boolean {
  // Deliberately defensive rather than trusting the TypeScript signature.
  // #38 will call this on data that just crossed an HTTP boundary, and a
  // JavaScript caller can hand over a partial or null-bearing object. A
  // classifier that throws on malformed input is worse than one that says
  // "not canonical": the caller would lose the ability to route at all,
  // whereas `false` cleanly falls through to the legacy/empty path. Full
  // record validation stays the reducer's job (INVALID_EVENT_RECORD).
  const first: unknown = events[0];
  if (typeof first !== "object" || first === null) return false;

  const { sequence, payload } = first as { sequence?: unknown; payload?: unknown };
  if (sequence !== 1) return false;
  if (typeof payload !== "object" || payload === null) return false;

  return (payload as { type?: unknown }).type === "RUN_CREATED";
}

/**
 * Compile-time exhaustiveness guard. If a new member is added to
 * `InvestigationEventRecordPayload` and the projection switch below does not
 * handle it, `value` stops being `never` and this call fails to compile —
 * forcing an explicit projection decision (identity / remap / null) for
 * every future event type rather than silently defaulting to null.
 */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Projects one canonical/read event record down to the narrower
 * `AgentTraceEvent` "agent activity" shape that `TraceTimeline` already
 * renders (apps/web/src/components/TraceTimeline.tsx,
 * apps/web/src/trace/trace-presentation.ts), or `null` when the record is a
 * lifecycle-only fact with no place in that view.
 *
 * Implemented as an EXHAUSTIVE switch with an `assertNever` default rather
 * than a membership test plus casts: every one of the 13 record payload
 * types below makes an explicit choice, and adding a 14th will not compile
 * until its choice is made too. That is the property this function exists
 * for — a future activity-relevant event must not be able to fall through
 * to `null` unnoticed.
 *
 * `TOOL_FAILED → null` is a DELIBERATE current choice, not an oversight:
 * `TraceTimeline`'s exhaustive switch has no case for it today, so emitting
 * it would break that component. Changing this requires changing
 * `TraceTimeline` (out of scope for #36) plus this projection, its test,
 * and docs/16 §7 together.
 *
 * #37 must call this from the database mapper before producing the existing
 * `run.trace` response, once incrementally persisted rows can include the
 * wider canonical vocabulary. It is NOT wired into
 * packages/database/src/mappers.ts by #36 — that file is untouched here.
 */
export function projectToLegacyAgentTraceEvent(
  record: InvestigationEventRecord,
): AgentTraceEvent | null {
  const { payload } = record;

  switch (payload.type) {
    // ── Identity: these ARE legacy activity events already. Their schemas
    // are the same objects AgentTraceEventSchema uses, so returning the
    // payload needs no transformation and no cast.
    case "RETRIEVAL_COMPLETED":
      return { type: "RETRIEVAL_COMPLETED", chunks: payload.chunks };
    case "TOOL_REQUESTED":
      return { type: "TOOL_REQUESTED", toolCallId: payload.toolCallId, toolName: payload.toolName };
    case "TOOL_COMPLETED":
      return { type: "TOOL_COMPLETED", toolCallId: payload.toolCallId, toolName: payload.toolName };
    case "REPORT_GENERATED":
      return { type: "REPORT_GENERATED" };

    // ── Remap: REPORT_VALIDATED means exactly what the legacy
    // REPORT_GENERATED has always meant (validated and accepted).
    case "REPORT_VALIDATED":
      return { type: "REPORT_GENERATED" };

    // ── Excluded: lifecycle-only facts with no agent-activity equivalent.
    case "RUN_CREATED":
    case "AGENT_STARTED":
    case "REPORT_GENERATION_STARTED":
    case "REPORT_SUBMITTED":
    case "REPORT_VALIDATION_FAILED":
    case "RUN_COMPLETED":
    case "RUN_FAILED":
      return null;

    // ── Excluded by deliberate current choice (see doc comment above).
    case "TOOL_FAILED":
      return null;

    default:
      return assertNever(payload, "projectToLegacyAgentTraceEvent");
  }
}
