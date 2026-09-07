# OpsPilot — Agent Run API

| Field | Value |
|---|---|
| Document | Agent Run API (Milestone 6B) — Implementation Record |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Document the local-only, synchronous NestJS HTTP API in `apps/api` — endpoints, envelopes, error catalog, request/body handling, the deterministic fake provider, and the local-only/no-auth scope of this milestone |
| Related documents | `docs/03-technical-design.md` §16, `docs/11-agent-run-persistence.md` (the persistence layer this API sits on top of) |

---

## 1. Scope

`apps/api` is a NestJS application exposing HTTP endpoints over the persistence and agent-runtime packages built in this and later milestones. **This list was originally "eight endpoints" as of Milestone 6B/6C/production-deployment; two more were added since and are marked below** — 10 endpoints as of issue #72:

```text
POST /v1/agent-jobs
POST /v1/agent-jobs/:jobId/runs
GET  /v1/agent-jobs/:jobId
GET  /v1/agent-jobs/:jobId/investigation   # added later — issue #34/#38, Timeline live-progress work
GET  /v1/agent-runs/:runId
POST /v1/agent-runs/:runId/approval
GET  /v1/agent-runs/:runId/approval
GET  /v1/health/live
GET  /v1/health/ready
GET  /v1/capabilities                      # added later — issue #19/#39, LIVE admission/public-trial work
```

Milestone 6C (see `docs/13-approval-workflow.md`) adds the approval pair: `POST /v1/agent-runs/:runId/approval` and `GET /v1/agent-runs/:runId/approval`, recording a human approve/reject decision against a completed run's suggested actions. The workflow records a decision only — it never executes, simulates executing, or schedules execution of the approved action.

The production deployment milestone (see `docs/08-cicd-deployment.md`) adds the health pair:
`GET /v1/health/live` (process-only, never queries the database) and `GET /v1/health/ready` (a
lightweight `SELECT 1` through the same Prisma handle; a database failure reuses the existing
`PERSISTENCE_UNAVAILABLE` catalog entry rather than a new code). Both follow the same `{ data: ... }`
success envelope and error catalog as every other endpoint in this document.

Every request runs synchronously, end to end:

```text
HTTP request
→ Zod validation
→ AgentRunService (packages/database + packages/agent-runtime)
→ persisted AgentJob / AgentRun / AgentTraceEvent
→ stable HTTP response
```

This milestone (6B) does **not** add a React UI, a job queue, CI/CD, deployment configuration, authentication/authorization, or streaming (SSE/WebSockets). It also does not call any live model or embedding provider — every run executes against a deterministic, in-process fake LLM provider (see §7). The human-approval workflow — recording only, never executing an approved action — is a later, additive milestone (6C, `docs/13-approval-workflow.md`), documented in §3 and §4 below.

### Why synchronous `201`, not queue-backed `202`

`POST /v1/agent-jobs/:jobId/runs` runs the full orchestrator loop in the request handler and returns the terminal, persisted result as `201 Created` with a `Location` header pointing at the created run. A future queue-backed design (`docs/03-technical-design.md` §16) would instead enqueue the run and return `202 Accepted` immediately, with the caller polling or subscribing for the terminal result. This milestone deliberately keeps the simpler synchronous shape — the deterministic fake provider always completes in milliseconds, so there is no latency problem to hide behind a queue yet, and a synchronous handler is far simpler to reason about while `apps/api` is still local-only and unauthenticated *at Milestone 6B*. (Auth was added later for LIVE runs specifically — see §7's update note; the synchronous-vs-queued shape itself is unchanged and unrelated to that.)

---

## 2. Package layout

```text
apps/api/
  src/
    main.ts                     Bootstrap: owns the one PrismaClientHandle, guarded safeClose, middleware pipeline
    app.module.ts                AppModule.forRoot(handle, safeClose) — the only entry point into the module graph
    common/                      Request-ID middleware, JSON body parser + parser-error handler, logging interceptor, exception filter
    errors/                      ApiError, the error catalog, and PersistenceError/AgentRunServiceError -> ApiError mapping
    validation/                  Zod body/param validation pipes
    persistence/                 Prisma DI tokens, PrismaModule.forRoot, PrismaLifecycleService
    execution/                   AgentRunService DI wiring, the deterministic fake-provider factory
    agent-jobs/                  POST /v1/agent-jobs, GET /v1/agent-jobs/:jobId
    agent-runs/                  POST /v1/agent-jobs/:jobId/runs, GET /v1/agent-runs/:runId
  test/
    http-transport.integration.test.ts        Real Nest HTTP app + Supertest, mocked AgentRunService, no PostgreSQL
    agent-run-api.postgres.integration.test.ts Real Prisma/PostgreSQL, two-app persistence-boundary proof
  scripts/run-api-demo.ts        Pure fetch-based HTTP client demo (no workspace source imports)
```

It depends on the PR 1 packages (`@opspilot/contracts`, `@opspilot/database`, `@opspilot/agent-runtime`) and never imports source from `apps/worker`.

---

## 3. Endpoints and envelopes

Global prefix: `/v1`. Every success response is wrapped as `{ "data": ... }`.

### `POST /v1/agent-jobs`

Request body — validated against `TicketContextSchema` from `@opspilot/contracts`:
```json
{ "ticketId": "TICKET-2001", "summary": "Elevated API error rate on billing-service" }
```
`201 Created`:
```json
{ "data": { "id": "uuid", "ticketId": "TICKET-2001", "summary": "...", "createdAt": "ISO timestamp" } }
```
Duplicate `ticketId` submissions are allowed and create separate jobs — `ticketId` is not a uniqueness key.

### `POST /v1/agent-jobs/:jobId/runs`

`jobId` must be a UUID. Body accepts only an absent body or `{}` — any other value is rejected (see §5). No pre-read of the job happens before execution: the ticket context used by the run is loaded exclusively from the row `AgentRunService.executeAndPersist`'s own `startRun` call locks inside its own transaction.

A **LIVE** run additionally requires an `Idempotency-Key` header containing a
UUID (§10.6). FAKE requires none and stores none.

`201 Created`, with `Location: /v1/agent-runs/<runId>`:
```json
{ "data": { "job": {...}, "run": {...}, "trace": [...], "outcome": {...} } }
```

`200 OK`, same body and same `Location`, when a LIVE request's `Idempotency-Key`
already names a run on this job — the server returns that run and creates
nothing (§10.6).

### `GET /v1/agent-jobs/:jobId`

Returns the job snapshot plus its run summaries, ordered by `attemptNumber` ascending. No trace, report, failure payload, or pagination — this is a summary read model only.

### `GET /v1/agent-jobs/:jobId/investigation` **(#38)**

Returns one `RepeatableRead` snapshot of the job, its latest run (by `MAX(attemptNumber)`), the legacy trace projection, the run outcome, and the raw canonical event records — all from a single consistent database read. Anonymous, like every other read on this demo.

**Response shape** (`200`):

```jsonc
{ "data": {
  "job":     { "id", "ticketId", "summary", "createdAt" },
  "run":     { "id", "jobId", "attemptNumber", "status", "providerMode",
               "modelIdentifier", "startedAt", "finishedAt", "createdAt",
               "estimatedCostUsd" } | null,
  "trace":   [ /* legacy AgentTraceEvent, stored order */ ],
  "outcome": { "type": "RUNNING" | "COMPLETED" + report | "FAILED" + code/message } | null,
  "events":  [ { "runId", "sequence", "recordedAt", "payload" } ]   // sequence ASC
} }
```

- `run` / `outcome` are `null` and `trace` / `events` are `[]` when the job has no run yet (the window between `createAgentJob` resolving and the run-creation transaction committing). That is a real, expected state, not an error.
- **Latest attempt only**, selected by `MAX(attemptNumber)`. The client additionally applies a `minAttemptNumber` floor during a retry.
- `trace` is produced by the **same** `fromTraceEventRows` projection used by `GET /v1/agent-runs/:runId` — canonical events project to their legacy equivalents, lifecycle-only types are hidden, and legacy streams pass through byte-identical.
- `events` carries the raw, fully-validated `InvestigationEventRecord[]` for EVERY row the run has — canonical or legacy — via `fromInvestigationEventRows`, which is safe for both: the record payload schema is a strict superset of the four legacy trace-event types. The canonical-vs-legacy **verdict** is a client-side decision: the browser calls `hasCanonicalInvestigationLifecycleMarker(events)` itself — there is no server-side `eventsFormat` verdict field, and this is the one public/client boundary that decides the distinction.
- **Approval is deliberately not embedded.** Approval only becomes meaningful at terminal `COMPLETED`, polling stops there, and the terminal-settlement path already owns the "run just settled → load approval, freeze the clock, announce" sequence.
- **`clientRequestId` is absent** from the response and from every event payload, matching every other public endpoint in this document.

**Errors:**

| Case | Response |
| --- | --- |
| `jobId` not a UUID | `400 ROUTE_PARAMETER_INVALID` |
| Job absent | `404 AGENT_JOB_NOT_FOUND` |
| Stored stream fails validation/contiguity | `500 INTERNAL_DATA_INVALID` |
| Database outage | `503 PERSISTENCE_UNAVAILABLE` |

No new `ApiErrorCode` is added. **`GET /v1/agent-runs/:runId` is not touched** — its `{ job, run, trace, outcome }` shape, and every legacy consumer of it, stay exactly as they are.

### `GET /v1/agent-runs/:runId`

Returns the full persisted run projection: `job`, `run`, `trace` (in stored order — never re-sorted at the API layer), and `outcome` (`RUNNING` / `COMPLETED` with `report` / `FAILED` with `code` + `message`). Approval state is **not** embedded here — see the two endpoints below.

#### Trace content after issue #37 (incremental persistence)

The response **shape** is unchanged: the same `{ job, run, trace, outcome }`
envelope, the same four-variant `AgentTraceEvent` union in `trace`, no
canonical `events[]` field, and no `clientRequestId`. Canonical progress and
polling belong to #38.

Two content changes are worth knowing about:

1. **A `RUNNING` run can now return a partial `trace`.** Events are persisted
   as they happen rather than in one batch at the end, so a mid-flight run has
   rows to project. Before #37 a `RUNNING` run always returned `trace: []`.
   This is the point of the issue.

2. **`TOOL_NOT_FOUND` and `TOOL_INPUT_INVALID` now include a
   `TOOL_REQUESTED` event.** The canonical ledger records the tool request
   *before* registry lookup and input validation — truthfully, since the
   provider genuinely did request the tool — and the API's `trace` is projected
   from that ledger. Before #37 this response carried no tool event at all for
   those two codes, because it was derived from the orchestrator's in-memory
   array, whose own `TOOL_REQUESTED` push sits after validation (and still
   does, for direct orchestrator callers).

   This is a **content change within the existing union, not a response-shape
   change**: `TOOL_REQUESTED` is one of the four variants every existing
   consumer already renders. `TOOL_FAILED` remains hidden by the projection,
   and the run's failure is still communicated by `outcome.code` /
   `outcome.message` exactly as before. Consumers that pair a `TOOL_REQUESTED`
   with a later `TOOL_COMPLETED` should note that on these two failure paths
   there is no completion event — the request stands alone.

Lifecycle-only canonical events (`RUN_CREATED`, `AGENT_STARTED`,
`REPORT_GENERATION_STARTED`, `REPORT_SUBMITTED`, `REPORT_VALIDATION_FAILED`,
`RUN_COMPLETED`, `RUN_FAILED`) are never exposed here; `REPORT_VALIDATED`
surfaces under its long-standing legacy name `REPORT_GENERATED`. Runs created
before #37 keep reading back byte-for-byte unchanged through the legacy branch
of the mapper.

### `POST /v1/agent-runs/:runId/approval`

Records a human approve/reject decision against a `COMPLETED` run's `suggestedActions`. Records a decision only — never executes, simulates executing, or schedules execution of the approved action. Full design in `docs/13-approval-workflow.md`.

Request body — validated against `RecordApprovalDecisionInputSchema` from `@opspilot/contracts`; `note` may be omitted entirely (never sent as `null`):
```json
{ "decision": "APPROVED", "reviewerName": "jacky", "note": "Escalation looks correct, ship it." }
```

**First recording** — `201 Created`, `Location: /v1/agent-runs/<runId>/approval`:
```json
{ "data": { "runId": "8f14e45f-...", "status": "APPROVED", "reviewerName": "jacky", "note": "Escalation looks correct, ship it.", "decidedAt": "2026-07-23T10:15:00.000Z" } }
```

**Idempotent replay** of an identical `(decision, reviewerName, note)` — `200 OK`, same body, **no `Location` header** (signals "not newly created"):
```json
{ "data": { "runId": "8f14e45f-...", "status": "APPROVED", "reviewerName": "jacky", "note": "Escalation looks correct, ship it.", "decidedAt": "2026-07-23T10:15:00.000Z" } }
```

Run not approval-eligible (`RUNNING`, `FAILED`, or `COMPLETED` with zero `suggestedActions`) — `409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE`. A conflicting decision already recorded (opposite decision, or the same decision with a different `reviewerName`/`note`) — `409 AGENT_RUN_APPROVAL_ALREADY_DECIDED`. See §4.

### `GET /v1/agent-runs/:runId/approval`

Always `200 OK` for an existing run — `NOT_ELIGIBLE` is a legitimate, informative read-model state, never a 404/409 purely because the run isn't eligible. Four possible `status` values:

```json
{ "data": { "runId": "8f14e45f-...", "status": "NOT_ELIGIBLE", "reviewerName": null, "note": null, "decidedAt": null } }
{ "data": { "runId": "8f14e45f-...", "status": "PENDING", "reviewerName": null, "note": null, "decidedAt": null } }
{ "data": { "runId": "8f14e45f-...", "status": "APPROVED", "reviewerName": "jacky", "note": "Escalation looks correct, ship it.", "decidedAt": "2026-07-23T10:15:00.000Z" } }
{ "data": { "runId": "8f14e45f-...", "status": "REJECTED", "reviewerName": "jacky", "note": null, "decidedAt": "2026-07-23T10:20:00.000Z" } }
```

`decidedAt` is `null` for `NOT_ELIGIBLE`/`PENDING` (no decision recorded yet), and an ISO-8601 string for `APPROVED`/`REJECTED` — the response mapper is the sole `Date -> string` conversion point; a raw Prisma record or `Date` object is never returned.

---

## 4. Error catalog

Every error response uses one envelope shape:
```json
{ "error": { "code": "AGENT_JOB_NOT_FOUND", "message": "The requested agent job was not found.", "requestId": "uuid" } }
```
`AGENT_EXECUTION_CRASHED` additionally includes a stable `runId`. No other error includes extra detail — no raw exception, stack, SQL, filesystem path, or credential is ever serialized into a response, logged, or printed at startup.

| Code | Status | Message |
|---|---|---|
| `REQUEST_BODY_INVALID` | 400 | The request body failed validation. |
| `REQUEST_BODY_TOO_LARGE` | 413 | The request body exceeded the maximum allowed size. |
| `ROUTE_PARAMETER_INVALID` | 400 | The request path contained an invalid identifier. |
| `AGENT_JOB_NOT_FOUND` | 404 | The requested agent job was not found. |
| `AGENT_RUN_NOT_FOUND` | 404 | The requested agent run was not found. |
| `PERSISTENCE_CONFLICT` | 409 | The request could not be completed due to a conflicting persisted state. |
| `PERSISTENCE_UNAVAILABLE` | 503 | The database is temporarily unavailable. |
| `INTERNAL_DATA_INVALID` | 500 | The server encountered invalid persisted data and could not complete the request. |
| `AGENT_EXECUTION_CRASHED` | 500 | The agent execution terminated unexpectedly. |
| `INTERNAL_ERROR` | 500 | An unexpected internal error occurred. |
| `AGENT_RUN_NOT_APPROVAL_ELIGIBLE` | 409 | The agent run is not eligible for an approval decision. (Milestone 6C — see `docs/13-approval-workflow.md`.) |
| `AGENT_RUN_APPROVAL_ALREADY_DECIDED` | 409 | The agent run already has a recorded approval decision that does not match this request. (Milestone 6C — see `docs/13-approval-workflow.md`.) |
| `LIVE_RUN_IDEMPOTENCY_KEY_INVALID` | 400 | A live agent run requires an Idempotency-Key header containing a UUID. (§10.6) |
| `LIVE_RUN_CONTEXT_INVALID` | 422 | This investigation was created under older input rules and cannot run in LIVE mode. Start a new investigation with a 15–2000 character summary. (§10.7) |

`PersistenceError` is mapped by both its own code and the operation that produced it (`errors/map-domain-error.ts`) — the same underlying `PERSISTENCE_NOT_FOUND` code means `AGENT_JOB_NOT_FOUND` on a job read, `AGENT_RUN_NOT_FOUND` on a run read, `AGENT_JOB_NOT_FOUND` when `startRun` can't find the job, and `INTERNAL_DATA_INVALID` if a run row vanishes mid-finalization. Any value that isn't a recognized `PersistenceError`/`AgentRunServiceError` — including a non-`Error` throw — maps to a fixed `INTERNAL_ERROR`.

---

## 5. Request ID, body parsing, and limits

Raw Express middleware runs before Nest routing, in this exact order: **(1)** server-generated request ID, **(2)** JSON body parser (32 KB limit), **(3)** parser-error normalization, **(4)** Nest routes.

- **Request ID**: always server-generated via `crypto.randomUUID()`; any inbound `X-Request-Id` is ignored. Set on the response (`X-Request-Id`) before parsing or routing, so it appears on every response — including malformed-body and oversized-body errors.
- **Body parsing**: `express.json({ limit: "32kb", type: "*/*" })`. The `type: "*/*"` is deliberate — `express.json()`'s default type predicate only matches `application/json` and would silently skip a `text/plain` (or any other non-JSON) body, leaving it `undefined` and letting it slip past the run endpoint's empty-body allowance as if no body had been sent.
- **Failure mapping**: `entity.too.large` → `413 REQUEST_BODY_TOO_LARGE`; any other parse failure → `400 REQUEST_BODY_INVALID`. No Express HTML error page is ever returned — parser failures use the same error-envelope builder as the Nest exception filter.
- **Run body** (`POST /v1/agent-jobs/:jobId/runs`): accepts only an absent body or `{}`. `null`, an array, a string, a number, or an object with any property is rejected as `REQUEST_BODY_INVALID`. Absent-only normalization (`value === undefined ? {} : value`, not `value ?? {}`) means an explicit `null` body is rejected rather than silently coerced to `{}`.

---

## 6. Deterministic fake provider

`execution/deterministic-provider-factory.ts` builds a `FakeLlmProvider` scenario purely from the `AgentJobRecord` that `AgentRunService.executeAndPersist`'s own `startRun` call returns — never from a caller-supplied value, and never by pre-reading the job via `getAgentJob`. The scenario is a pure function of `job.id`, `job.ticketContext.ticketId`, and `job.ticketContext.summary`: no clock, randomness, network call, or environment-derived content.

- **Service slug**: bounded keyword matching over the ticket summary — `billing` → `billing-service`, `notification` → `notification-service`, `auth` → `auth-service`, otherwise `unspecified-service`.
- **Summary truncation**: the ticket summary is truncated to 200 characters before being interpolated into report fields.
- **`AGENT_RUN_PROVIDER_MODE`**: defaults to `FAKE`. As of PR 6B1 this is the **default request mode** — what a run request that omits `providerMode` gets — not the only mode the API supports. See §7.1.

### 7.1 Per-run provider selection (PR 6B1)

`POST /v1/agent-jobs/:jobId/runs` accepts an optional `providerMode`:

```jsonc
{}                          // → the server's default request mode
{ "providerMode": "FAKE" }  // → deterministic provider
{ "providerMode": "LIVE" }  // → live claude-sonnet-5, if permitted
```

An absent body and `{}` both remain valid, so every caller written before PR 6B1
behaves exactly as it did. An explicit `null` body is still rejected, unknown keys are
still rejected, and a `providerMode` that is neither value returns
`REQUEST_BODY_INVALID` (400) — a misspelled mode is never silently treated as the
default.

Four concepts are kept strictly separate, because a deployment can be in any
combination of them:

| Concept | Source | Default |
| --- | --- | --- |
| Default request mode | `AGENT_RUN_PROVIDER_MODE` | `FAKE` |
| Requested run mode | the request body's `providerMode` | the default request mode |
| Server live capability | `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` | absent |
| Live kill switch | `LIVE_AGENT_RUNS_ENABLED` | **`false`** |

**Live capability is optional.** A process with neither Anthropic variable set starts
normally and serves `FAKE` — that is the configuration CI and ordinary local
development run in. A *partial* configuration is a different matter and fails startup:
a key without a model, a model without a key, an unsupported model, or an
out-of-range timeout or retry count. Resolving a partial configuration to "absent"
would silently turn a deployment meant to be live into a deterministic one.

**A requested `LIVE` run is never downgraded to `FAKE`.** It is either served or
refused:

| Condition | Response |
| --- | --- |
| Capability absent | `503 LIVE_NOT_CONFIGURED` |
| Capability present, kill switch `false` | `503 LIVE_RUNS_DISABLED` |
| Capability present, kill switch `true` | executes against `claude-sonnet-5` |

Both refusals are decided before `startRun`, so no `AgentRun` row is created and no
Anthropic object is touched. `FAKE` requests never consult either.

The persisted run records what actually ran: `provider_mode` is `FAKE` or `LIVE`, and
`model_identifier` is `claude-sonnet-5` for a live run and `null` for a deterministic
one.

### Job-scoped `toolCallId`, and reuse across runs

The scenario's `toolCallId` is `` `${job.id}-call-1` `` — scoped to the **job**, not the run. The same job can execute multiple runs (each POST to `/v1/agent-jobs/:jobId/runs` allocates a new `attemptNumber`), and every one of those runs reuses this same job-scoped `toolCallId`. This is intentional and safe: tool-call identity and evidence grounding (`findInvalidEvidence` in `packages/agent-runtime`) are checked within the scope of a single run's own trace, never across runs — there is no global tool-call uniqueness constraint.

---

## 7. No-auth warning (Milestone 6B snapshot — superseded, see below)

**This section describes the Milestone 6B state only, before LIVE execution existed.** As of
Milestone 8 (`docs/08-cicd-deployment.md` §25) the deployed API does have authentication for LIVE
runs — the private `LIVE_RUN_ACCESS_TOKEN` path and the Turnstile-verified public-trial path — and
a real live-model code path exists and is reachable on the public deployment today (see
`README.md` "Provider selection and safety"). The claims below were true only for the
FAKE-only, pre-Milestone-8 API and are kept for historical record.

`apps/api` has **no authentication, authorization, or network exposure hardening** of its own — this
remains true regardless of `HOST`. Locally, `HOST` defaults to `127.0.0.1`, so nothing changes for
ordinary development. The production container (`docs/08-cicd-deployment.md`) sets `HOST=0.0.0.0`
deliberately, because a containerized service must accept connections from outside its own network
namespace to be reachable at all — that is a routing requirement, not a statement that the API grew
authentication. The public deployment's security posture rests entirely on the boundaries documented
in `docs/08-cicd-deployment.md` §22: single origin, FAKE provider only, no provider keys anywhere,
and explicit demo-only limitations stated alongside the live URL. Every run still executes against
the deterministic fake provider only; there is no live-model code path to accidentally invoke.

---

## 8. Running it

```bash
pnpm install
pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:deploy && pnpm db:generate

pnpm --filter @opspilot/api run build
pnpm --filter @opspilot/api run start     # Terminal A — blocks; binds to http://127.0.0.1:3000
```

In a second terminal, once Terminal A prints `OpsPilot API listening on http://127.0.0.1:3000`:
```bash
pnpm api:demo                             # Terminal B — POST job, POST run, GET job, GET run,
                                           # plus the TICKET-APPROVAL-DEMO approval-workflow flow
```
Stop Terminal A with `Ctrl+C` once the demo finishes — `main.ts` registers `SIGINT`/`SIGTERM` shutdown hooks that close the Prisma client and pg pool cleanly.

### No automatic reload yet

`pnpm --filter @opspilot/api run start:dev` is `pnpm run build && pnpm run start` — a clean rebuild followed by a normal blocking start, not a file-watching dev loop. Editing a source file does **not** automatically recompile or restart the server; re-run `start:dev` (or `build` then `start`) after each change. Automatic reload is deferred — see `docs/10-engineering-challenges.md` Challenge 4 for why the Nest CLI's own watch mode (`nest start --watch`) is not available here, and why a `tsc --watch`/process-manager-based replacement was deliberately not added in this pass (no new process-management dependency).

Test commands:
```bash
pnpm --filter @opspilot/api run test               # unit tests — no PostgreSQL
pnpm --filter @opspilot/api run test:integration    # HTTP-transport (mocked) + real-PostgreSQL suites
pnpm run test:integration:sequential                # packages/database's suite, then apps/api's — shared test database
```

---

## 9. Future direction (explicitly out of scope here)

- A job queue (BullMQ or similar) and `202 Accepted` + polling/SSE for run status, once run latency no longer fits comfortably inside one HTTP request/response cycle.
- Idempotency keys on `POST /v1/agent-jobs/:jobId/runs` for safe client-side retry.
- Authentication/authorization, once this API is exposed beyond a local developer machine.
- Public-demo safeguards for the live path — a shared access token, per-client rate
  limiting, a concurrency limiter, an atomic per-job attempt limit, and a durable daily
  token/cost budget. PR 6B1 ships the live path itself but leaves it switched off
  (`LIVE_AGENT_RUNS_ENABLED=false`) precisely because those safeguards do not exist
  yet. Deferred to PR 6B2.
- Per-run usage and cost persistence, and the `FAKE`/`LIVE` selector in the browser.
  Also PR 6B2 — the deployed frontend currently offers no way to request a live run.

The human-approval workflow — `POST`/`GET /v1/agent-runs/:runId/approval`, recording a decision only, never executing it — was future work as of Milestone 6B; it is implemented as of Milestone 6C. See §3/§4 above and `docs/13-approval-workflow.md` for the full design and implementation record.


---

## 10. PR 6B2 — live admission, usage, and capabilities

### 10.1 Canonical admission order

Identical in code, tests, and this document. Steps 2–8 are skipped entirely for
`FAKE`; step 1 applies to every request.

The order has **three phases**, and which phase a step belongs to is the point —
see §10.1.0.

```text
 1. validate the requested provider mode        -> REQUEST_BODY_INVALID (400)
1b. validate the Idempotency-Key (LIVE only)    -> LIVE_RUN_IDEMPOTENCY_KEY_INVALID (400)

    ── AUTHORIZATION — required for a replay AND for a new run ──────────────
 2. verify live capability                      -> LIVE_NOT_CONFIGURED (503)
 3. kill switch                                 -> LIVE_RUNS_DISABLED (503)
 4. shared access token                         -> LIVE_RUN_ACCESS_DENIED (401)

    ── REPLAY LOOKUP — read-only, holds nothing, consumes nothing ───────────
4b. lock AgentJob -> find the LIVE AgentRun bearing this key -> commit
      a row exists  -> 200 OK with that run; steps 5–12 do not happen
      no row        -> continue to step 5
                                                -> AGENT_JOB_NOT_FOUND (404)
                                                -> PERSISTENCE_UNAVAILABLE (503)

    ── SPEND ADMISSION — permission to start a NEW paid execution ───────────
 5. per-client rate limit                       -> LIVE_RUN_RATE_LIMITED (429)
 6. advisory budget pre-check (non-authoritative)-> LIVE_RUN_BUDGET_EXHAUSTED (429)
                                                -> PERSISTENCE_UNAVAILABLE (503) if the read itself fails
    closed by ANY of: daily run count used up | accumulated estimate over the
    ceiling | pricing_unknown_runs > 0 | an UNRECONCILED reservation
    (runs_completed != runs_reserved)  — see 10.1.1
 7. acquire concurrency lease (limit is exactly 1) -> LIVE_RUN_CONCURRENCY_LIMIT (429)
 8. AUTHORITATIVE TRANSACTION
      lock AgentJob -> RECHECK the key -> verify context -> count LIVE runs
      -> reserve daily budget -> allocate attempt_number -> insert AgentRun
                                                -> AGENT_JOB_NOT_FOUND (404)
                                                -> LIVE_RUN_CONTEXT_INVALID (422)
                                                -> LIVE_RUN_ATTEMPT_LIMIT (429)
                                                -> LIVE_RUN_BUDGET_EXHAUSTED (429)
      COMMIT — before any provider call
 9. execute the orchestrator under the composed abort signal
10. resolve abort provenance; finalize with persisted usage
11. reconcile the budget against the RESERVATION's date  (exception-safe)
12. release the concurrency lease                        (inner finally, always)
```

Capability is checked before the kill switch so an operator on a server with no
credential sees `LIVE_NOT_CONFIGURED` rather than a misleading "disabled". The
token is checked before the rate limit so an unauthenticated caller cannot
consume a client's rate-limit allowance.

### 10.1.0 Spend admission versus authenticated replay

Two questions, deliberately not one:

```text
capabilities / steps 5–8   ->  permission to start a NEW paid LIVE execution
authenticated same-key replay (step 4b)
                           ->  recovery of an EXISTING request; no new spend
                               admission, no reservation, no attempt, no lease
```

Steps 2–7 used to run as a single block, so a request could not be **recognized**
as a repeat until every gate governing new spending had already let it through.
That made the documented `200` replay unreachable in exactly the situations it
exists for, and the worst of them was self-inflicted:

```text
the original request consumes the day's final reservation (or fails to
reconcile, latching the day) -> its response is lost -> the recovery repeats
the same Idempotency-Key -> the advisory budget gate refuses at step 6, before
any lookup -> the run that already exists can never be handed back
```

The same held for an exhausted rate window and a busy concurrency slot.

So the lookup moved in front of the spend gates, and three properties keep it
safe:

- **Replay is not an authentication bypass.** Steps 2–4 still run first, and they
  run identically for a replay and for a new run. An unauthenticated caller
  receives the same `401` whether or not the key names a run, so the endpoint
  cannot be used to probe which keys exist.
- **The lookup takes the AgentJob lock.** A plain unlocked `SELECT` could read
  past an original transaction that has not committed yet, answer "nothing was
  created", and send the request on to admit a second paid execution. Waiting on
  the same lock means an ambiguous concurrent original either commits its row —
  after which the recovery sees it — or rolls back, after which the recovery
  correctly sees nothing.
- **A failed lookup does not fall through.** "Could not read" is answered as
  `503`, never as "no run exists". Treating the two alike is precisely how a
  request that may already have executed becomes a second paid one.

**Nothing is relaxed for a new key.** A request whose key names no run runs the
identical gates, in the identical order, with the identical codes.

**Step 8 still rechecks the key**, under the lock that serializes creation, and
that is not redundant with step 4b. Two requests carrying the same key can both
find nothing at 4b and both reach admission; only the locked transaction can
decide which of them creates the run. Step 4b is an early exit; step 8 is the
guarantee.

A replay accepts `RUNNING`, `COMPLETED` and `FAILED` rows identically — status is
never what decides a replay.

A database outage has **one** public contract wherever it lands. A
`PersistenceError` from step 6's advisory read maps to the same
`503 PERSISTENCE_UNAVAILABLE` that step 8's authoritative transaction already
produced; the earlier behaviour let it escape as `500 INTERNAL_ERROR`, so the
same outage read as "we broke" or "try again shortly" depending only on timing.
It fails **closed**: no lease is taken, no transaction is opened, no run row is
created, and no provider is constructed. Non-persistence failures are re-thrown
untouched rather than being dressed up as a transient 503. The public body is the
fixed catalog message — never a database message, SQL, or DSN.

Every LIVE request emits **exactly one** structured line
(`event: "live_run_admission"`) carrying the decision and the fixed catalog code,
and nothing else — no token, no client address, no budget figure, no headroom.
`decision` is one of three closed values:

```text
admitted   the AUTHORITATIVE transaction (step 8) actually created a new run —
           or, if the provider or finalization later failed, already ran one
replayed   answered from step 4b, OR the step-8 transaction itself resolved
           `execution: "replayed"` — either way: no allowance, no lease, no
           attempt, no spend
rejected   refused; `code` carries the fixed catalog identifier
```

**`admitted` is settled from step 8's result, never from step 5–7 passing.**
Passing the rate limit, the advisory budget check, and taking the concurrency
lease proves only that a request MAY reach the authoritative transaction — not
that the transaction will create a new run. A concurrent request carrying the
*same* key can still commit first, in which case this request's own step 8
discovers that row and answers `execution: "replayed"` instead, after every
spend gate had already passed it. Settling `admitted` as soon as the lease was
acquired would misreport that outcome as a paid execution that never happened.

A run that genuinely started keeps its `admitted` classification even when a
*later* step fails — a crashed provider call or a failed finalization write are
facts about execution, not about admission, and both are reachable only after
step 8 already created the run.

`replayed` is separate from `admitted` because collapsing them would make a free
recovery indistinguishable from a paid execution in the one place an operator
looks to count them. Exactly-one-line is structural rather than a convention: a
one-shot recorder is created per request when it is authorized, every stage
records through it, and the first record wins. The anonymous capabilities probe
(`isAvailable`) is deliberately **not** logged: it runs on every page load.

Step 7's limit is **exactly one** concurrent live run, and
`LIVE_RUN_MAX_CONCURRENCY` accepts no other value. That is what makes the
documented cost-ceiling bound — the **observed reconciled estimate** crossing the
ceiling by at most **one in-flight logical run** — true for every accepted
configuration rather than only for the default; see
[CI/CD and deployment](08-cicd-deployment.md) §25.2.1.

The bound is on the ESTIMATE, not on money. **Actual provider billing may be
higher** after an ambiguous network outcome or a process termination, and the
estimated-cost gate is not an actual-spend hard cap. The hard controls are the
daily run count, the per-job attempt cap, and the per-attempt output ceiling.

### 10.1.1 An unreconciled reservation closes the day

A reservation commits **before** the provider runs; the cost is added afterwards
by reconciliation (step 11). A reconciliation failure therefore leaves the row
with an accurate run count and **stale cost figures** — both
`estimated_cost_nano_usd` and `pricing_unknown_runs` are missing a run that has
already executed.

Admitting further runs against those figures would make the observed-estimate
gate fail **open**. So the counters are the latch: both the advisory pre-check
and the authoritative reservation statement require

```sql
live_run_budget.runs_completed = live_run_budget.runs_reserved
```

and an outstanding reservation closes the UTC day by itself — no run row, no
provider, no Anthropic call. The latch is durable (it is the PostgreSQL row, not
process memory), so it survives a restart and applies to every instance.

The refusal is the **same opaque 429** as an exhausted count, a crossed ceiling,
or unknown pricing, and `/v1/capabilities` reports the same
`UNAVAILABLE` / `NOT_APPLICABLE` body. A caller cannot tell which condition
closed the day. Recovery is the next UTC day, which starts from a clean row; see
[CI/CD and deployment](08-cicd-deployment.md) §25.2.3.

**No LIVE rejection ever silently retries as FAKE.**

### 10.2 Where the failure happens decides the status

**Before an `AgentRun` row exists** — no run is created, an error envelope is
returned: 400 / 401 / 404 / 429 / 503 as above.

**After the row exists — `201 Created`**, with the persisted run and the usual
`Location` header, even when `status` is `FAILED`. The resource genuinely was
created: the UI gets a `runId`, the timeline stays reachable, and a later `GET`
is consistent. `AGENT_PROVIDER_UNAVAILABLE` (502) and `AGENT_RUN_TIMED_OUT`
(504) remain **absent** as public controller errors — they contradicted a
finalized run resource. The distinctions survive as `failure_code` on the row.

**On an actual client disconnect** no response body is written at all, because
the connection is gone. The run still finalizes `FAILED` with
`PROVIDER_CANCELLED`.

### 10.3 `GET /v1/capabilities`

```json
{ "liveAgentRuns": "AVAILABLE" | "UNAVAILABLE",
  "liveAccess":    "TOKEN_REQUIRED" | "NOT_APPLICABLE" }
```

Opacity is the contract. Capability absent, kill switch off, no token
configured, and budget exhausted all render as exactly `UNAVAILABLE` — an
anonymous visitor learns that LIVE cannot be started and nothing else. No budget
values, no counts, no key or configuration details, no provider probe, and no
paid request. `PUBLIC` is absent from the type, not merely unset.

`/v1/health/ready` stays service and database readiness only. An exhausted daily
budget is not an unhealthy deployment, and putting product state on the probe
Render restarts containers over would make it one.

### 10.4 Money on the wire

`estimatedCostUsd` is a decimal **string** or `null` — never a JSON number.
Internally the money path is integer nanoUSD (`bigint`) end to end, with no
float intermediate and no reverse conversion from a USD number.

`null` means the cost is **not known**, which covers three cases:

- every FAKE run, which made no provider call;
- any LIVE run whose pricing could not be established;
- any run with `possibleUnobservedCost` — where the stored figure is a **lower
  bound**, not a total.

The third case is the subtle one. A first-turn timeout stores `0` while tokens
may genuinely have been billed; a failure on turn two stores only turn one's
cost. Publishing either would state a precise number known to be too low, and
`$0.00` would go further and assert the run was free. The observed bound stays in
PostgreSQL for audit; the API simply declines to present it as a total.
Consumers hide the row rather than rendering `$0.00`.

### 10.5 Input bounds

`ticketId` is a trimmed 1–64 characters; `summary` is a trimmed 15–2000. The
value is trimmed **once**, at the request boundary, and the normalized result is
what gets persisted. The backend is authoritative — the browser's counter and
disabled button are an affordance, and a request that bypasses the UI with a
short summary still receives a 400.

Stored rows are revalidated against a deliberately looser schema
(`StoredTicketContextSchema`), so rows written before these bounds existed stay
readable rather than becoming 500s. A tightened input rule must never invalidate
history — but it must not be bypassable either, which is a different requirement
and needs a different check (§10.7).

---

### 10.6 Idempotent LIVE run creation

**The problem.** A `POST /v1/agent-jobs/:jobId/runs` exception does not prove
that no run was created. Two shapes are unavoidable:

1. Finalization persistence fails **after** the provider executed and after the
   budget was reconciled. The API answers `PERSISTENCE_UNAVAILABLE` — the same
   code it uses for a pre-run outage.
2. The network loses a successful response after the server committed, executed,
   and finalized.

In both, the client has an ambiguous failure and a job with no visible run. If
its recovery is an ordinary new request, that recovery is a **second paid
execution**. Allowlisting error codes cannot fix this: a transport failure has
no code, and `PERSISTENCE_UNAVAILABLE` is genuinely raised at both stages.

**The contract.**

```text
POST /v1/agent-jobs/:jobId/runs
Idempotency-Key: <UUID>          # required for providerMode: "LIVE"
```

| Situation | Status | Effect |
|---|---|---|
| No run on this job bears the key | `201` | Exactly one run is created and executed. |
| A run on this job bears the key | `200` | That run is returned. No provider call, no reservation, no attempt consumed. |
| Absent, blank, malformed, or oversized key on LIVE | `400` | `LIVE_RUN_IDEMPOTENCY_KEY_INVALID`. Rejected before admission. |
| FAKE, with or without a key | `201` | The key is ignored and never stored. A deterministic run spends nothing, so repeating one is harmless. |

`200` rather than `201` because the request created nothing: a client counting
`201`s would otherwise count one paid attempt too many. `Location` is sent on
both, and the body is byte-identical, so a caller that only wants the run need
not care which happened.

**A replayed `RUNNING` row is valid** and is returned as it stands — it is the
normal residue of a failed finalization. `GET /v1/agent-runs/:runId` observes its
later state. The server never re-executes because a row looks unfinished.

**Where the key is validated.** In step 1b (request validation), *before*
everything else — the same position the Zod body pipe already occupies. A
malformed key therefore cannot consume another client's rate-limit budget or
take the single concurrency lease on its way to being rejected. Absent, blank,
malformed, and oversized all produce one code and one message; distinguishing
them would publish how the value is parsed and tells an honest caller nothing.

**Where the key is looked up.** Twice, and both are load-bearing:

| Step | What it is | Why |
|---|---|---|
| 4b | A locked, read-only lookup **before** the spend gates | So a run that already exists can be recovered when the day's budget, the rate window, or the concurrency slot is closed — including when this request's own original attempt is what closed it. See §10.1.0. |
| 8 | The recheck inside the authoritative transaction | So two same-key requests that both found nothing at 4b still produce exactly one run. |

A replay therefore consumes **no** rate-limit slot, reads **no** budget, takes
**no** concurrency lease, counts **no** attempt, and reserves **nothing**. It is
free in the ledger as well as in the provider. It still requires the same
authorization every new run does: capability, kill switch, and a valid access
token are checked first, so a `401` is returned identically whether or not the
key names a run.

**The key is not a credential.** It authorizes nothing — it names a request. It
is deliberately *reused* across recovery attempts, which is the exact opposite
of the live access token's lifetime (`docs/14-web-ui.md` §13.2), and the two are
never stored together. It is equally deliberately not written to logs.

Uniqueness is enforced per job by a partial unique index on
`(job_id, client_request_id)` — see `docs/11-agent-run-persistence.md` §5. A key
reused against a different job is simply a different request, and no job can
replay another job's run.

---

### 10.7 LIVE execution eligibility for legacy jobs

Stored-read permissiveness (§10.5) is correct for a GET and wrong for a paid
run. `startLiveRunWithAttemptLimit` reads the same stored snapshot and sends it
to a provider that charges for it, so a job created before the current bounds
existed could start a LIVE run with a summary no current caller may submit.

```text
stored-read compatibility  ->  permissive
LIVE execution eligibility ->  current bounds AND already-canonical form
                               (ticketId 1–64, summary 15–2000, and the stored
                                value equal to its own trimmed parse)
```

Canonical form, not merely parseability. The schema trims before it measures
while the provider is sent the stored value, so checking parseability alone
would bound a different string than the one billed for: 200 kB of whitespace
around a valid 26-character summary passes 15–2000 and produces a 200,000-
character prompt. Requiring the stored value to equal its parsed result makes
those two the same string.

The check runs inside the authoritative transaction, after the job row is locked
and **before** the attempt count, the budget reservation, the run insert, and any
provider construction. A rejection therefore consumes no attempt, no reservation,
and no provider call — the transaction simply rolls back.

An ineligible job is refused with **422 `LIVE_RUN_CONTEXT_INVALID`**: the request
is well-formed (not a 400) and nothing is concurrently conflicting with it (not a
409) — the referenced job is simply not something this server will execute in
LIVE mode, and repeating the request will never change that. The message states
the current rule and the one thing that works; it never echoes the stored
summary, its length, a schema name, or any SQL.

Nothing is truncated, padded, normalized, or written back to make a job fit —
the row is refused and left exactly as it is. FAKE stays fully compatible with
legacy rows: it spends nothing.

One ordering consequence, deliberate: the idempotency lookup runs **before** this
check, so an existing run on an ineligible job is still replayable. A rule about
what may start cannot change what a finished run already cost.
