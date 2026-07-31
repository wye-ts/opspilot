-- PR 6B2 — durable live-run budget, per-run usage accounting, and the
-- attempt-limit index. See docs/reviews/19-protected-live-claude-api-plan.md §15.
--
-- ROLLBACK (nothing references any of this; reverting the code alone is also safe):
--
--   DROP TABLE "live_run_budget";
--   DROP INDEX "agent_runs_job_id_provider_mode_idx";
--   ALTER TABLE "agent_runs"
--     DROP CONSTRAINT "agent_runs_usage_non_negative_chk",
--     DROP CONSTRAINT "agent_runs_pricing_status_chk",
--     DROP COLUMN "provider_calls_observed",
--     DROP COLUMN "input_tokens",
--     DROP COLUMN "output_tokens",
--     DROP COLUMN "estimated_cost_nano_usd",
--     DROP COLUMN "pricing_status",
--     DROP COLUMN "possible_unobserved_cost";
--   -- and restore the 10-value failure_code CHECK from the init migration.

-- CreateTable: live_run_budget
--
-- budget_date is a DATE primary key: one row per UTC day, and that date IS the
-- row's identity. estimated_cost_nano_usd is BIGINT nanoUSD — integer
-- billionths of a dollar — so costs accumulate across turns and days with no
-- floating-point drift. Nothing in the money path is ever a float.
CREATE TABLE "live_run_budget" (
    "budget_date" DATE NOT NULL,
    "runs_reserved" INTEGER NOT NULL DEFAULT 0,
    "runs_completed" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_nano_usd" BIGINT NOT NULL DEFAULT 0,
    "pricing_unknown_runs" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "live_run_budget_pkey" PRIMARY KEY ("budget_date")
);

-- AlterTable: agent_runs — six nullable per-run usage columns.
--
-- All nullable, and all left NULL for a FAKE run: "not measured" and "measured
-- as zero" are different facts. Writing 0 for a deterministic run would claim a
-- measurement that never happened.
ALTER TABLE "agent_runs"
    ADD COLUMN "provider_calls_observed" INTEGER,
    ADD COLUMN "input_tokens" INTEGER,
    ADD COLUMN "output_tokens" INTEGER,
    ADD COLUMN "estimated_cost_nano_usd" BIGINT,
    ADD COLUMN "pricing_status" TEXT,
    ADD COLUMN "possible_unobserved_cost" BOOLEAN;

-- CreateIndex: supports the in-transaction count that enforces the per-job live
-- attempt limit (SELECT count(*) ... WHERE job_id = $1 AND provider_mode = 'LIVE').
CREATE INDEX "agent_runs_job_id_provider_mode_idx" ON "agent_runs"("job_id", "provider_mode");

-- Prisma's schema DSL cannot express CHECK constraints — these are
-- hand-authored, not generated. See docs/11-agent-run-persistence.md.

-- CheckConstraint: live_run_budget — every counter is a non-negative quantity.
-- A negative reservation or cost would mean the reconciliation arithmetic had
-- gone wrong, and the database should refuse it rather than store it.
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_runs_reserved_chk"
  CHECK ("runs_reserved" >= 0);

ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_runs_completed_chk"
  CHECK ("runs_completed" >= 0);

ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_estimated_cost_nano_usd_chk"
  CHECK ("estimated_cost_nano_usd" >= 0);

ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_pricing_unknown_runs_chk"
  CHECK ("pricing_unknown_runs" >= 0);

-- A run can never be reported complete more times than it was reserved.
-- Reservations are taken before execution and never released, so completions
-- always trail them.
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_completed_within_reserved_chk"
  CHECK ("runs_completed" <= "runs_reserved");

-- CheckConstraint: agent_runs usage columns — non-negative when present.
-- Each is independently nullable, so each clause admits NULL explicitly rather
-- than relying on NULL propagation to make the whole predicate unknown.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_usage_non_negative_chk"
  CHECK (
    ("provider_calls_observed" IS NULL OR "provider_calls_observed" >= 0) AND
    ("input_tokens"            IS NULL OR "input_tokens"            >= 0) AND
    ("output_tokens"           IS NULL OR "output_tokens"           >= 0) AND
    ("estimated_cost_nano_usd" IS NULL OR "estimated_cost_nano_usd" >= 0)
  );

-- Mirrors the exact 4 values of @opspilot/provider-claude's PricingStatus.
-- Kept in sync only by a unit test asserting parity — see
-- schema-constraints.integration.test.ts.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_pricing_status_chk"
  CHECK ("pricing_status" IS NULL OR "pricing_status" IN (
    'CURRENT',
    'STALE',
    'UNKNOWN_MODEL',
    'INSUFFICIENT_USAGE_DETAIL'
  ));

-- Widen agent_runs_failure_code_chk to the full AgentOrchestratorErrorCodeSchema.
--
-- PR 6B1 added PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT / PROVIDER_CANCELLED to
-- the contract enum so an expected live-provider failure finalizes the run as
-- FAILED instead of leaving the row RUNNING forever — but it did not widen this
-- constraint, so writing any of those three would have been rejected by the
-- database and the run would have been orphaned anyway. That made the Gap A fix
-- unreachable in practice.
--
-- Recreated rather than edited in place: PostgreSQL has no ALTER CONSTRAINT for
-- a CHECK expression. A parity test now asserts this list equals the enum, so
-- the two cannot drift again.
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
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_CANCELLED'
  ));
