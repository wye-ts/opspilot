-- CreateTable
CREATE TABLE "agent_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_context" JSONB NOT NULL,
    "external_ticket_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "provider_mode" TEXT NOT NULL,
    "model_identifier" TEXT,
    "report" JSONB,
    "failure_code" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_trace_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_trace_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_job_id_attempt_number_key" ON "agent_runs"("job_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "agent_trace_events_run_id_sequence_number_key" ON "agent_trace_events"("run_id", "sequence_number");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "agent_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: agent_jobs
-- Prisma's schema DSL cannot express CHECK constraints or JSONB predicates —
-- these are hand-authored, not generated. See docs/11-agent-run-persistence.md.
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_ticket_context_is_object_chk"
  CHECK (jsonb_typeof("ticket_context") = 'object');

ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_external_ticket_id_matches_chk"
  CHECK ("external_ticket_id" = ("ticket_context" ->> 'ticketId') AND "external_ticket_id" <> '');

-- CheckConstraint: agent_runs
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_attempt_number_chk"
  CHECK ("attempt_number" >= 1);

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_status_chk"
  CHECK ("status" IN ('RUNNING', 'COMPLETED', 'FAILED'));

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_provider_mode_chk"
  CHECK ("provider_mode" IN ('FAKE', 'LIVE'));

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_report_is_object_chk"
  CHECK ("report" IS NULL OR jsonb_typeof("report") = 'object');

-- Mirrors the exact 10 values of @opspilot/contracts' AgentOrchestratorErrorCodeSchema.
-- Kept in sync only by a unit test asserting parity — see docs/11-agent-run-persistence.md.
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
    'PROVIDER_PROTOCOL_INVALID'
  ));

-- Terminal-outcome invariant: RUNNING has no terminal fields set; COMPLETED
-- has finished_at + report and no failure_code; FAILED has finished_at +
-- failure_code and no report. Completed and failed can never coexist.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_terminal_outcome_chk"
  CHECK (
    ("status" = 'RUNNING'   AND "finished_at" IS NULL     AND "report" IS NULL     AND "failure_code" IS NULL) OR
    ("status" = 'COMPLETED' AND "finished_at" IS NOT NULL AND "report" IS NOT NULL AND "failure_code" IS NULL) OR
    ("status" = 'FAILED'    AND "finished_at" IS NOT NULL AND "report" IS NULL     AND "failure_code" IS NOT NULL)
  );

-- CheckConstraint: agent_trace_events
ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_sequence_number_chk"
  CHECK ("sequence_number" >= 1);

ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_payload_is_object_chk"
  CHECK (jsonb_typeof("payload") = 'object');

-- Mirrors the exact 4 variants of @opspilot/contracts' AgentTraceEventSchema.
ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_event_type_chk"
  CHECK ("event_type" IN ('RETRIEVAL_COMPLETED', 'TOOL_REQUESTED', 'TOOL_COMPLETED', 'REPORT_GENERATED'));

ALTER TABLE "agent_trace_events" ADD CONSTRAINT "agent_trace_events_event_type_matches_chk"
  CHECK ("event_type" = ("payload" ->> 'type'));
