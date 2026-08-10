-- Issue #39 — Public LIVE Trial: durable schema extension.
-- See docs/reviews/23-issue-39-public-live-trial-plan.md §6/§7.
--
-- Extends live_run_budget (#19, 20260729224500_add_live_run_budget_and_usage)
-- with two PUBLIC-scoped global counters, and adds one narrowly-scoped
-- insert-only table for the per-visitor daily gate — a cardinality that does
-- not fit a single daily row.
--
-- ROLLBACK (nothing else references either object):
--
--   DROP TABLE "live_run_visitor_usage";
--   ALTER TABLE "live_run_budget"
--     DROP CONSTRAINT "live_run_budget_public_runs_reserved_chk",
--     DROP CONSTRAINT "live_run_budget_public_cost_nano_usd_chk",
--     DROP CONSTRAINT "live_run_budget_public_within_overall_chk",
--     DROP COLUMN "public_runs_reserved",
--     DROP COLUMN "public_estimated_cost_nano_usd";

-- AlterTable: live_run_budget — two PUBLIC-scoped counters only. No
-- public_runs_completed counterpart: the existing shared
-- runs_completed = runs_reserved latch remains the sole staleness guard for
-- both the private and public paths (see agent-run-repository.ts).
ALTER TABLE "live_run_budget"
  ADD COLUMN "public_runs_reserved" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "public_estimated_cost_nano_usd" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_runs_reserved_chk"
  CHECK ("public_runs_reserved" >= 0);
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_cost_nano_usd_chk"
  CHECK ("public_estimated_cost_nano_usd" >= 0);

-- A PUBLIC run is also an overall run, so its count can never exceed the
-- overall reservation count for the same day.
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_within_overall_chk"
  CHECK ("public_runs_reserved" <= "runs_reserved");

-- CreateTable: live_run_visitor_usage — insert-only, one row per
-- (visitor_id, usage_date). Written once via ON CONFLICT DO NOTHING at
-- reservation time (agent-run-repository.ts startLiveRunWithAttemptLimit)
-- and never updated afterward: the row's mere presence for today is the
-- entire fact this table records, so there is no counter column and no
-- reconciliation step.
CREATE TABLE "live_run_visitor_usage" (
    "visitor_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_run_visitor_usage_pkey" PRIMARY KEY ("visitor_id", "usage_date")
);
