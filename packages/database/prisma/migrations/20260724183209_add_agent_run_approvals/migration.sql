BEGIN;

-- CreateTable
CREATE TABLE "agent_run_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewer_name" TEXT NOT NULL,
    "note" TEXT,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_approvals_run_id_key" ON "agent_run_approvals"("run_id");

-- AddForeignKey
ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: agent_run_approvals (hand-authored — Prisma's schema DSL
-- cannot express CHECK constraints or JSONB predicates; see docs/11-agent-run-persistence.md)
ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_decision_chk"
  CHECK ("decision" IN ('APPROVED', 'REJECTED'));

ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_reviewer_name_not_blank_chk"
  CHECK (char_length(btrim("reviewer_name")) > 0);

COMMIT;
