-- Issue #57, Checkpoint A — split the canonical replay identity so that the
-- three repeatable diagnostic event types are identified per toolCallId
-- (docs/16-investigation-event-contract.md, issue #57 plan §2.3).
--
-- The #37 migration created a single partial unique index on (run_id,
-- event_type) for ALL 12 canonical write-eligible types. That encoded the
-- at-most-once-per-run assumption of the v1 runtime (zero or one tool call).
-- #57 generalizes the canonical contract to bounded serial multi-step
-- diagnostics, so TOOL_REQUESTED / TOOL_COMPLETED / TOOL_FAILED are now
-- repeatable with distinct toolCallIds, and their identity becomes
-- (run_id, event_type, payload->>'toolCallId'). The 9 singleton lifecycle
-- types keep (run_id, event_type) identity unchanged.
--
-- This migration is backward compatible without a data rewrite: under the
-- current runtime every canonical row has each type at most once, so every
-- existing row already satisfies both narrower indexes.
--
-- ROLLBACK (both index names are new; the old name is recreated):
--
--   DROP INDEX "agent_trace_events_run_id_event_type_tool_call_id_key";
--   DROP INDEX "agent_trace_events_run_id_canonical_singleton_key";
--   CREATE UNIQUE INDEX "agent_trace_events_run_id_canonical_event_type_key"
--     ON "agent_trace_events" ("run_id", "event_type")
--     WHERE "event_type" IN (
--       'RUN_CREATED', 'AGENT_STARTED', 'RETRIEVAL_COMPLETED',
--       'TOOL_REQUESTED', 'TOOL_COMPLETED', 'TOOL_FAILED',
--       'REPORT_GENERATION_STARTED', 'REPORT_SUBMITTED',
--       'REPORT_VALIDATED', 'REPORT_VALIDATION_FAILED',
--       'RUN_COMPLETED', 'RUN_FAILED'
--     );

-- 1. Drop the all-12 partial unique index created by the #37 migration.
DROP INDEX "agent_trace_events_run_id_canonical_event_type_key";

-- 2. The 9 singleton canonical types keep (run_id, event_type) uniqueness —
--    the exact-replay identity for lifecycle and report facts.
CREATE UNIQUE INDEX "agent_trace_events_run_id_canonical_singleton_key"
  ON "agent_trace_events" ("run_id", "event_type")
  WHERE "event_type" IN (
    'RUN_CREATED', 'AGENT_STARTED', 'RETRIEVAL_COMPLETED',
    'REPORT_GENERATION_STARTED', 'REPORT_SUBMITTED',
    'REPORT_VALIDATED', 'REPORT_VALIDATION_FAILED',
    'RUN_COMPLETED', 'RUN_FAILED'
  );

-- 3. The 3 repeatable diagnostic types are identified per toolCallId, so a
--    single run may hold several distinct TOOL_REQUESTED / TOOL_COMPLETED /
--    TOOL_FAILED rows. At-most-once-per-identity is still enforced at the
--    database (one request, one completion, one failure per toolCallId);
--    request→outcome matching remains the reducer's job, exactly as before.
CREATE UNIQUE INDEX "agent_trace_events_run_id_event_type_tool_call_id_key"
  ON "agent_trace_events" ("run_id", "event_type", ((payload ->> 'toolCallId')))
  WHERE "event_type" IN ('TOOL_REQUESTED', 'TOOL_COMPLETED', 'TOOL_FAILED');
