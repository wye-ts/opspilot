-- Issue #37, Phase A — widen agent_trace_events for the canonical investigation
-- lifecycle contract (issue #36, docs/16-investigation-event-contract.md).
--
-- This migration is INERT: it only widens what the column ACCEPTS. No writer in
-- this phase persists any of the 9 newly-accepted event types — the existing
-- persist-after runtime (finalizeCompleted/finalizeFailed, toTraceEventCreateInputs)
-- continues writing exactly the 4 legacy types it always has
-- (RETRIEVAL_COMPLETED, TOOL_REQUESTED, TOOL_COMPLETED, REPORT_GENERATED), so
-- every row written by this migration's schema is legacy-shaped until a later
-- phase wires an incremental writer.
--
-- ROLLBACK (nothing else references either object):
--
--   DROP INDEX "agent_trace_events_run_id_canonical_event_type_key";
--   ALTER TABLE "agent_trace_events" DROP CONSTRAINT "agent_trace_events_event_type_chk";
--   ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_event_type_chk"
--     CHECK ("event_type" IN ('RETRIEVAL_COMPLETED', 'TOOL_REQUESTED', 'TOOL_COMPLETED', 'REPORT_GENERATED'));

-- Widen agent_trace_events_event_type_chk from the 4 legacy variants to the
-- full 13-member InvestigationEventRecordPayloadSchema vocabulary
-- (@opspilot/contracts) — the 12 canonical write-eligible types plus the one
-- legacy read-only type, REPORT_GENERATED. Widening only: every row a
-- pre-migration writer could ever have produced already satisfies this list,
-- so no existing row needs touching and none can be rejected retroactively.
--
-- agent_trace_events_event_type_matches_chk ("event_type" = "payload" ->> 'type')
-- is untouched — it already holds for every one of the 13 types, since it
-- makes no assumption about which types are legal, only that the two columns
-- agree with each other.
ALTER TABLE "agent_trace_events" DROP CONSTRAINT "agent_trace_events_event_type_chk";

ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_event_type_chk"
  CHECK ("event_type" IN (
    'RUN_CREATED',
    'AGENT_STARTED',
    'RETRIEVAL_COMPLETED',
    'TOOL_REQUESTED',
    'TOOL_COMPLETED',
    'TOOL_FAILED',
    'REPORT_GENERATION_STARTED',
    'REPORT_SUBMITTED',
    'REPORT_VALIDATED',
    'REPORT_VALIDATION_FAILED',
    'RUN_COMPLETED',
    'RUN_FAILED',
    'REPORT_GENERATED'
  ));

-- The all-12 exact-replay database invariant (docs/reviews/21-...md §3/§4):
-- under current-runtime V1, every one of the 12 canonical write-eligible
-- event types is at-most-once per run — retrieval events 0 or 1, tool calls
-- 0 or 1, tool outcomes 0 or 1, and every lifecycle singleton exactly once.
-- This is a real invariant, not a convenience, and it is what makes the
-- application-level exact-replay policy (resolveCanonicalEventReplay)
-- durable rather than merely conventional: even if the row lock were ever
-- bypassed, a concurrent duplicate write for the same (run_id, event_type)
-- fails at the database rather than silently succeeding.
--
-- REPORT_GENERATED is deliberately excluded — it is legacy read-only and no
-- writer in this codebase constructs a fresh one (it is structurally absent
-- from InvestigationEventPayloadSchema); every historical legacy trace
-- already satisfies this index without needing backfill, since a legacy
-- trace carries RETRIEVAL_COMPLETED / TOOL_REQUESTED / TOOL_COMPLETED /
-- REPORT_GENERATED at most once each.
--
-- Deliberately current-runtime-specific: a future multi-tool or
-- repeated-retrieval contract version replaces or narrows this index in a
-- coordinated migration alongside the #36 contract change that permits those
-- streams. Narrowing it now to avoid that future migration would weaken
-- correctness today for a version that does not exist.
CREATE UNIQUE INDEX "agent_trace_events_run_id_canonical_event_type_key"
  ON "agent_trace_events" ("run_id", "event_type")
  WHERE "event_type" IN (
    'RUN_CREATED', 'AGENT_STARTED', 'RETRIEVAL_COMPLETED',
    'TOOL_REQUESTED', 'TOOL_COMPLETED', 'TOOL_FAILED',
    'REPORT_GENERATION_STARTED', 'REPORT_SUBMITTED',
    'REPORT_VALIDATED', 'REPORT_VALIDATION_FAILED',
    'RUN_COMPLETED', 'RUN_FAILED'
  );
