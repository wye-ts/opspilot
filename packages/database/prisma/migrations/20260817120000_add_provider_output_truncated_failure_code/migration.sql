-- Widen agent_runs_failure_code_chk to include PROVIDER_OUTPUT_TRUNCATED.
--
-- normalizeClaudeMessage now classifies stop_reason === "max_tokens" as its own
-- protocol_error code instead of letting a truncated response fall through into
-- the content decision tree, where it was previously misclassified (most often
-- as REPORT_SCHEMA_INVALID for a partially-filled report tool_use block). See
-- packages/provider-claude/src/claude-response-normalization.ts.
--
-- Recreated rather than edited in place: PostgreSQL has no ALTER CONSTRAINT for
-- a CHECK expression, matching 20260729224500_add_live_run_budget_and_usage's
-- precedent for widening this same constraint. The parity test in
-- schema-constraints.integration.test.ts asserts this list equals
-- AgentOrchestratorErrorCodeSchema's values, so the two cannot drift.
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_failure_code_chk";

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_failure_code_chk"
  CHECK ("failure_code" IS NULL OR "failure_code" IN (
    'RETRIEVAL_PARAMS_INVALID',
    'RETRIEVAL_FAILED',
    'RETRIEVAL_RESPONSE_INVALID',
    'TOOL_NOT_FOUND',
    'TOOL_INPUT_INVALID',
    'TOOL_OUTPUT_INVALID',
    'TOOL_EXECUTION_FAILED',
    'REPORT_SCHEMA_INVALID',
    'REPORT_EVIDENCE_INVALID',
    'PROVIDER_PROTOCOL_INVALID',
    'PROVIDER_OUTPUT_TRUNCATED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_CANCELLED'
  ));
