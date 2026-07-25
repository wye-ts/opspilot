# OpsPilot

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

A local-only, synchronous NestJS API over the persistence layer above — four endpoints, no auth, no queue, no live model calls (every run executes against a deterministic fake provider). Requires the local PostgreSQL setup above.

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
