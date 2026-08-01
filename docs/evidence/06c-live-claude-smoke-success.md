# Evidence — LIVE Claude smoke: successful re-test after the `REPORT_SCHEMA_INVALID` fix

## Purpose and scope

This document records a single controlled production LIVE re-test performed after the fix in
`docs/evidence/06c-live-claude-smoke-failure.md` (PR #32, `073bf2f`) merged to `main`. It exists to
close the loop on that failure honestly: the fix changed the system prompt and added a sanitized
diagnostic, but it did not — and could not — prove by itself that a real model call would now produce
a schema-valid report. This is that proof, for one run, followed by an immediate return to the safe
FAKE-only deployment posture.

This is a **verification-only** exercise. No application code changed as part of this document.

## Sanitized production evidence

Verified directly against the public, unauthenticated read endpoints
(`GET /v1/agent-runs/:runId`, `GET /v1/agent-runs/:runId/approval`) — the same evidence path
established by `docs/reviews/17-live-demo-evidence-plan.md` §3.2 B8 — rather than transcribed from an
external log.

```text
Ticket ID:            DEMO-e3ff4471-d258-4757-8ba3-1c966f6f91bf
Job ID:                218236cc-0177-4124-ac79-f9f2c8b1931a
Run ID:                8c2090de-f145-47a4-a8e0-0df9b4f3c5f3

Provider mode:         LIVE
Model:                 claude-sonnet-5
Status:                COMPLETED
Attempt:               1
Started:               2026-08-01T00:10:49.052Z
Finished:              2026-08-01T00:11:00.990Z
Duration:              11.9s (~12s)
Estimated cost:        $0.021854

Trace:
  1. get_service_status requested
  2. get_service_status completed
  3. report generated

Report category:       UNKNOWN
Confidence:            0.25
Suggested actions:     2 (CREATE_ESCALATION, UPDATE_TICKET_STATUS)
Approval status:       PENDING (reviewerName null, note null, decidedAt null)

REPORT_SCHEMA_INVALID: did not recur
```

**Fields not captured in this document.** Input/output token counts, provider call count, pricing
status, `possibleUnobservedCost`, and the daily budget's `runs_reserved` / `runs_completed` /
`pricing_unknown_runs` counters before and after this run are not exposed by the public API
(`AgentRunResponseData` publishes only a formatted `estimatedCostUsd` string or `null` — see
`apps/api/src/agent-runs/dto/agent-run-response.mapper.ts` — never raw token counts or budget-table
state), and this verification session had no `DATABASE_URL` or Render dashboard access. Confirming
those fields requires the deployment owner's own database or dashboard access, the same boundary
`docs/reviews/17-live-demo-evidence-plan.md` §2.2 already draws around Render/Neon-side facts. This is
recorded honestly as a gap rather than inferred or estimated.

**Deployed commit SHA at the time of this run.** Not independently confirmed here. Per
`docs/reviews/17-live-demo-evidence-plan.md` F9, the running service exposes no version or
commit-SHA endpoint, so the deployed commit can only be read from the Render dashboard by the owner
and cross-checked against `git`/`gh` (§3.1 P5) — this session had neither. `main` at the time of
writing is `f10d1d3` (PR #32's merge, which shipped the `REPORT_SCHEMA_INVALID` fix this run verifies).

## Safe baseline before enabling LIVE, and current state

`render.yaml` declares the safe defaults directly: `AGENT_RUN_PROVIDER_MODE=FAKE`,
`LIVE_AGENT_RUNS_ENABLED=false`, `ANTHROPIC_MAX_RETRIES=0`. Enabling LIVE for this one re-test was a
temporary, deliberate departure from that committed baseline, made and reverted by the deployment
owner outside this repository (a Render dashboard environment-variable change, not a code or config
change) — the same boundary drawn in `docs/reviews/17-live-demo-evidence-plan.md` §2.2 for
Render/Neon-side facts.

Verified directly against the production endpoints at the time this document was written:

```text
GET /v1/health/live         -> 200 {"data":{"status":"ok"}}
GET /v1/health/ready        -> 200 {"data":{"status":"ready"}}
GET /v1/capabilities        -> 200 {"data":{"liveAgentRuns":"UNAVAILABLE","liveAccess":"NOT_APPLICABLE"}}
```

`liveAgentRuns: UNAVAILABLE` confirms LIVE is disabled again at the time of writing. A FAKE
investigation was not separately re-run in this session, since `AGENT_RUN_PROVIDER_MODE=FAKE` and the
kill switch being off are the same committed configuration `docker-smoke` already verifies in CI on
every merge to `main` (`docs/08-cicd-deployment.md` §20); re-proving it here would not add information
beyond what `render.yaml` and CI already establish.

## What this run does and does not prove

- **Proves:** a real Claude Sonnet 5 call, under the `REPORT_FIELD_BOUNDS` prose added in PR #32, can
  produce a `submit_resolution_report` payload that satisfies `ResolutionReportSchema` end to end —
  persisted as a `COMPLETED` run with a real report, not a `REPORT_SCHEMA_INVALID` failure.
- **Does not prove:** that the fix eliminates the failure class entirely. One passing run is one data
  point against a model that is not deterministic; the fix's actual guarantee is that the bounds are
  now stated to the model on every call (verified by the unit/integration tests listed in
  `docs/evidence/06c-live-claude-smoke-failure.md` "Test coverage added"), not that no future LIVE call
  can ever violate them. This document does not claim otherwise.
- **Does not prove:** anything about the specific field or value that caused the original historical
  failure — that remains genuinely unrecoverable, as `docs/evidence/06c-live-claude-smoke-failure.md`
  already states.

## Confirmations

- Exactly one paid LIVE execution was used to produce this evidence (the run above). No additional
  paid retry occurred — `ANTHROPIC_MAX_RETRIES=0` throughout, and this document only reads the
  already-persisted result via the public GET endpoints; no second run was created while preparing it.
- No secret (`ANTHROPIC_API_KEY`, `LIVE_RUN_ACCESS_TOKEN`, `Idempotency-Key`), database DSN, raw
  provider request/response, or full client IP is reproduced anywhere in this document.
- Production ended this exercise with LIVE disabled and FAKE as the default, matching `render.yaml`'s
  committed baseline (verified above).
- Approval was left `PENDING`. No approve/reject decision was recorded against this run as part of
  this evidence-capture exercise — see "Approval evidence" below.

## Approval evidence

Out of scope for this document. Recording a decision on this run was not necessary to close the
`REPORT_SCHEMA_INVALID` regression this evidence exists to verify, and doing so only to change this
run's terminal state would misrepresent why the decision was made. If approval-workflow evidence
against a real LIVE run is wanted later, it should be its own deliberate, explicitly-scoped exercise —
not a byproduct of this one.
