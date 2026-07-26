# OpsPilot

[![CI](https://github.com/wye-ts/opspilot/actions/workflows/ci.yml/badge.svg)](https://github.com/wye-ts/opspilot/actions/workflows/ci.yml)

AI support and incident resolution agent — see `docs/01-prd.md` for the product overview and `docs/03-technical-design.md` for the full architecture.

## Getting Started

```bash
pnpm install
```

This alone is enough to type-check and run the unit test suite — no `.env` file or running database is required:

```bash
pnpm -r run typecheck
pnpm -r run test
```

### Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml` — a `verify` job
(typecheck, unit tests, production builds, web bundle guard) and an `integration` job (both
PostgreSQL suites plus a Prisma migration drift check), in parallel. Node is pinned to `22.21.0` via
`.nvmrc` and pnpm to `11.13.1`; no provider secrets are referenced, so CI never makes a paid API call.

To run exactly what CI runs, without a database:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opspilot/web run check:bundle    # no dev origins, backend names, or test assets in apps/web/dist
```

And with PostgreSQL (see the next section for first-time setup):

```bash
pnpm db:migrate:test
pnpm test:integration:sequential                # the two suites share one database — never parallelize
pnpm db:migrate:deploy
pnpm db:migrate:drift
```

See `docs/08-cicd-deployment.md` for the full CI design.

### Deployment

A production container (`Dockerfile`, `docker/entrypoint.sh`, `render.yaml`) implements a
single-origin, deterministic FAKE-provider deployment — one Render Docker web service serving the
built React app at `/` and the NestJS API at `/v1/**`, backed by a Neon PostgreSQL database, proven
end to end by the `docker-smoke` CI job (image boundary checks, the full deterministic and approval
workflow, and a migration-failure path). **This configuration exists and is CI-verified; it has not
yet been deployed.** There is no live URL in this document, and none should be inferred — a Render
service and Neon database have not been created yet. See `docs/08-cicd-deployment.md` §12–§24 for the
full deployment design, and the Feature Complete / Portfolio Ready distinction at the top of that
document.

**Public-demo limitations, once deployed:** FAKE provider only (no real LLM calls, no provider keys
anywhere); no authentication, rate limiting, or abuse protection; Render's free tier cold-starts after
idle (documented plainly, not hidden, once a real URL exists). **The repository contains real
retrieval-augmented-generation work** (`apps/worker`, `docs/05-rag-design.md`) — evaluated
offline and unit-tested — **but the deployed browser path performs zero runbook retrieval**:
`apps/api` wires no retriever, and `runbooks/` is excluded from the production image entirely. Retrieval
should be described as repository/offline-evaluation work, never as something the public demo does.

### Local PostgreSQL (for the persistence layer)

Only needed for `packages/database`'s integration tests and the persisted demo (`demo:persisted`).

```bash
cp .env.example .env          # local-only placeholders, never real credentials
pnpm infra:up                 # start local Postgres via Docker Compose
pnpm db:test:ensure           # idempotently create the test/shadow databases
pnpm db:migrate:deploy        # apply committed migrations to the dev database
pnpm db:migrate:test          # apply committed migrations to the test database
pnpm db:generate              # generate the Prisma Client (gitignored — never assume it already exists)
```

Then:

```bash
pnpm --filter @opspilot/database run test:integration
pnpm --filter @opspilot/worker run demo:persisted
```

See `docs/11-agent-run-persistence.md` for the full persistence design, schema, and test-database lifecycle (including `db:reset:dev`/`db:reset:test`/`infra:down:reset` and the migration-authoring workflow).

### Demos and evaluation

```bash
pnpm --filter @opspilot/worker run demo        # deterministic agent demo, no DB, no live API
pnpm --filter @opspilot/worker run demo:rag    # deterministic RAG-augmented demo
pnpm --filter @opspilot/worker run eval        # 15-case deterministic evaluation harness
```

`spike:claude` and `spike:rag` require real `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY` values and make live network calls — see `apps/worker/.env.example`.

### Agent Run API (`apps/api`)

A synchronous NestJS API over the persistence layer above — eight endpoints (six domain endpoints plus `/v1/health/live` and `/v1/health/ready`), no auth, no queue, no live model calls (every run executes against a deterministic fake provider). Requires the local PostgreSQL setup above.

```bash
pnpm --filter @opspilot/api run build
pnpm --filter @opspilot/api run start     # Terminal A — blocks; http://127.0.0.1:3000
```

```bash
pnpm api:demo                             # Terminal B — POST job, POST run, GET job, GET run,
                                           # plus the TICKET-APPROVAL-DEMO approval-workflow flow
```

See `docs/12-agent-run-api.md` for the full endpoint/error/envelope reference.

An approval workflow adding `POST`/`GET /v1/agent-runs/:runId/approval` — recording a human approve/reject decision against a completed run's suggested actions, without executing them — is implemented; see `docs/13-approval-workflow.md`. The shipped deterministic demo (`pnpm --filter @opspilot/worker run demo`) always produces zero suggested actions, so nothing is ever approval-eligible there; `apps/api`'s own deterministic scenario adds one opt-in exception — a job created with `ticketId: "TICKET-APPROVAL-DEMO"` completes with one suggested action, exercising the full `PENDING` → `APPROVED`/`REJECTED` flow end to end via `pnpm api:demo`.

### Web UI (`apps/web`)

A React + Vite UI over the Agent Run API above, supporting local development and same-origin production serving through `apps/api` — describe an issue, run an investigation with one click, read the resulting trace timeline and generated report, and record an approve/reject decision, all in the browser. Requires the API running (previous section).

```bash
pnpm --filter @opspilot/web run dev       # Terminal C — blocks; http://127.0.0.1:5173
```

There is no editable Ticket ID field — an ordinary investigation generates one internally (`DEMO-<uuid>`), shown only as read-only metadata after the fact. To exercise the full approval demo: check **Approval workflow demo** before clicking **Run Investigation** to route the exact ticket ID `TICKET-APPROVAL-DEMO`; the report shows the one `DRAFT_CUSTOMER_REPLY` suggested action described above, and the Run Context Panel beside it (an "Action required" banner also appears above the report on completion) shows `PENDING` with a decision form. Enter a reviewer name (and, optionally, a note) and click **Approve** or **Reject** to record a terminal decision — the panel becomes a read-only record of the reviewer, note, and decision time, with no edit or revoke control. An ordinary (unchecked) investigation always shows `NOT_ELIGIBLE`, since it never produces a suggested action.

Browser requests are relative `/v1/...` paths only, proxied by Vite to the API — no CORS configuration was needed or added. See `docs/14-web-ui.md` for the full design record.
