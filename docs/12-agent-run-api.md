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

`apps/api` is a NestJS application exposing eight HTTP endpoints over the persistence and agent-runtime packages built in this and the prior milestone:

```text
POST /v1/agent-jobs
POST /v1/agent-jobs/:jobId/runs
GET  /v1/agent-jobs/:jobId
GET  /v1/agent-runs/:runId
POST /v1/agent-runs/:runId/approval
GET  /v1/agent-runs/:runId/approval
GET  /v1/health/live
GET  /v1/health/ready
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

`POST /v1/agent-jobs/:jobId/runs` runs the full orchestrator loop in the request handler and returns the terminal, persisted result as `201 Created` with a `Location` header pointing at the created run. A future queue-backed design (`docs/03-technical-design.md` §16) would instead enqueue the run and return `202 Accepted` immediately, with the caller polling or subscribing for the terminal result. This milestone deliberately keeps the simpler synchronous shape — the deterministic fake provider always completes in milliseconds, so there is no latency problem to hide behind a queue yet, and a synchronous handler is far simpler to reason about while `apps/api` is still local-only and unauthenticated.

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

`201 Created`, with `Location: /v1/agent-runs/<runId>`:
```json
{ "data": { "job": {...}, "run": {...}, "trace": [...], "outcome": {...} } }
```

### `GET /v1/agent-jobs/:jobId`

Returns the job snapshot plus its run summaries, ordered by `attemptNumber` ascending. No trace, report, failure payload, or pagination — this is a summary read model only.

### `GET /v1/agent-runs/:runId`

Returns the full persisted run projection: `job`, `run`, `trace` (in stored order — never re-sorted at the API layer), and `outcome` (`RUNNING` / `COMPLETED` with `report` / `FAILED` with `code` + `message`). Approval state is **not** embedded here — see the two endpoints below.

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
- **`AGENT_RUN_PROVIDER_MODE`**: defaults to `FAKE`. Any other value — in particular `LIVE` — fails the provider factory's own construction synchronously, before the Nest module graph finishes initializing, with a fixed message. No `ClaudeLlmProvider` is ever constructed and no network call is ever made by this API.

> **The live Claude provider does not change this.** `AGENT_RUN_PROVIDER_MODE=LIVE` selects `ClaudeLlmProvider` in `apps/worker` only. `apps/api` still rejects `LIVE` outright, still passes a hardcoded `providerMode: "FAKE"` on every run it executes, and still has no Anthropic SDK in its dependency closure — the production image's boundary check asserts that. This HTTP API is **not** live-provider capable; wiring it up, with the public-demo safeguards that would require, is a later milestone.

### Job-scoped `toolCallId`, and reuse across runs

The scenario's `toolCallId` is `` `${job.id}-call-1` `` — scoped to the **job**, not the run. The same job can execute multiple runs (each POST to `/v1/agent-jobs/:jobId/runs` allocates a new `attemptNumber`), and every one of those runs reuses this same job-scoped `toolCallId`. This is intentional and safe: tool-call identity and evidence grounding (`findInvalidEvidence` in `packages/agent-runtime`) are checked within the scope of a single run's own trace, never across runs — there is no global tool-call uniqueness constraint.

---

## 7. No-auth warning

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
- A live model provider path through this API (`AGENT_RUN_PROVIDER_MODE=LIVE`), still rejected outright. The live `ClaudeLlmProvider` exists and is exercised from `apps/worker`, but no API path reaches it.

The human-approval workflow — `POST`/`GET /v1/agent-runs/:runId/approval`, recording a decision only, never executing it — was future work as of Milestone 6B; it is implemented as of Milestone 6C. See §3/§4 above and `docs/13-approval-workflow.md` for the full design and implementation record.
