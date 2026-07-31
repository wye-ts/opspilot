-- PR 6B2 follow-up — idempotent LIVE run creation.
--
-- A `POST /v1/agent-jobs/:jobId/runs` exception does not prove that no run was
-- created: finalization can fail after the provider executed, and a successful
-- response can be lost in transit after the server committed. Recovery has to be
-- able to say "the same request again" and be recognized as such, or re-entering
-- the token creates a SECOND paid attempt for the first one's ambiguity.
--
-- ROLLBACK (nothing else references either object):
--
--   DROP INDEX "agent_runs_job_id_client_request_id_key";
--   ALTER TABLE "agent_runs" DROP COLUMN "client_request_id";

-- AlterTable: agent_runs — the client-generated request key.
--
-- NULLABLE, and every existing row keeps NULL. Rows written before this
-- migration are untouched and stay valid; a FAKE run also leaves it NULL,
-- because a deterministic run spends nothing and is free to repeat.
--
-- UUID rather than TEXT: the format is then enforced by the column as well as by
-- the request schema, so the two cannot drift, and the stored form is canonical
-- lowercase regardless of how the client cased it.
ALTER TABLE "agent_runs" ADD COLUMN "client_request_id" UUID;

-- CreateIndex: the uniqueness rule that makes replay safe.
--
-- PARTIAL, on `WHERE client_request_id IS NOT NULL`. A total unique index would
-- also work in PostgreSQL — NULLs compare as distinct, so unkeyed rows would not
-- collide — but it would index every historical and FAKE row for a predicate
-- that can never match them. The partial form indexes only the rows that
-- participate.
--
-- SCOPED TO (job_id, client_request_id), not to the key alone. The key names a
-- request against ONE job; scoping it per job means a key reused against a
-- different job is simply a different request, and a client cannot accidentally
-- (or deliberately) make job B replay job A's run.
--
-- BELT AND BRACES, not the primary mechanism. Concurrent duplicates already
-- serialize on the `SELECT ... FROM agent_jobs FOR UPDATE` that opens
-- startLiveRunWithAttemptLimit, so the second request sees the first's committed
-- row and replays it. This index is what makes a duplicate IMPOSSIBLE rather
-- than merely unreachable: if that lock were ever bypassed, the insert fails and
-- the request errors out — no second paid execution — instead of silently
-- creating a duplicate run.
CREATE UNIQUE INDEX "agent_runs_job_id_client_request_id_key"
  ON "agent_runs" ("job_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL;
