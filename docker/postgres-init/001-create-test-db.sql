-- First-boot convenience only: this script runs exclusively when Postgres
-- initializes a brand-new data volume. It is NOT the authoritative mechanism
-- for creating these databases on an existing/old volume — see
-- scripts/ensure-test-database.sh, which is idempotent and safe to rerun.
CREATE DATABASE opspilot_test OWNER opspilot;
-- Used only by `pnpm db:migrate:drift` (prisma migrate diff) as a throwaway
-- comparison target — see docs/11-agent-run-persistence.md.
CREATE DATABASE opspilot_shadow OWNER opspilot;
