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

A local-only, synchronous NestJS API over the persistence layer above — six endpoints, no auth, no queue, no live model calls (every run executes against a deterministic fake provider). Requires the local PostgreSQL setup above.

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

A local-only React + Vite UI over the Agent Run API above — describe an issue, run an investigation with one click, read the resulting trace timeline and generated report, and record an approve/reject decision, all in the browser. Requires the API running (previous section).

```bash
pnpm --filter @opspilot/web run dev       # Terminal C — blocks; http://127.0.0.1:5173
```

There is no editable Ticket ID field — an ordinary investigation generates one internally (`DEMO-<uuid>`), shown only as read-only metadata after the fact. To exercise the full approval demo: check **Approval workflow demo** before clicking **Run Investigation** to route the exact ticket ID `TICKET-APPROVAL-DEMO`; the report shows the one `DRAFT_CUSTOMER_REPLY` suggested action described above, and the approval panel below it shows `PENDING` with a decision form. Enter a reviewer name (and, optionally, a note) and click **Approve** or **Reject** to record a terminal decision — the panel becomes a read-only record of the reviewer, note, and decision time, with no edit or revoke control. An ordinary (unchecked) investigation always shows `NOT_ELIGIBLE`, since it never produces a suggested action.

Browser requests are relative `/v1/...` paths only, proxied by Vite to the API — no CORS configuration was needed or added. See `docs/14-web-ui.md` for the full design record.
