# opspilot-evaluation

Python/FastAPI evaluation service: authoritative deterministic scoring and
persistence for the frozen v1 evaluation contract (`EvaluationSuiteInputV1` /
`EvaluationSuiteResultV1`, see `apps/worker/src/evaluation/v1-types.ts`).
Phase 2 (OpsPilot #61) built the service standalone; Phase 3 wired it to the
TypeScript worker over HTTP (`POST /evaluations`, `GET /evaluations/{id}`),
with the worker's local TypeScript scorer retained as an explicit parity
oracle — see "TypeScript worker integration (Phase 3)" below.

## Setup

Requires [uv](https://docs.astral.sh/uv/). `uv sync` installs Python 3.13
(uv fetches it if not already present) and every dependency into `.venv/`.

```sh
cd services/evaluation
make sync
```

The service owns two logical Postgres databases, separate from the
Prisma-owned `opspilot`/`opspilot_test` at the repo root:

- `opspilot_evaluation` — local/dev
- `opspilot_evaluation_test` — tests

Against the repo's local `docker compose` Postgres (`localhost:55432`):

```sh
docker exec opspilot-postgres psql -U opspilot -d opspilot \
  -c 'CREATE DATABASE opspilot_evaluation OWNER opspilot;' \
  -c 'CREATE DATABASE opspilot_evaluation_test OWNER opspilot;'
```

Set `EVALUATION_DATABASE_URL` (accepts `postgres://` or `postgresql://`; see
`config.normalize_database_url`) — for example:

```sh
export EVALUATION_DATABASE_URL="postgresql://opspilot:opspilot_local_dev_only@localhost:55432/opspilot_evaluation"
```

Tests refuse to run destructive operations (TRUNCATE etc.) against any
database whose name is not exactly `opspilot_evaluation_test` (see
`tests/db_safety.py`). A dev DSN exported as `EVALUATION_DATABASE_URL` is
rejected before any destructive SQL, not silently used — unset it (or point
it at the test DB) before running the suite. With no env var set, tests
default to `opspilot_evaluation_test` on the same local Postgres.

## Commands

```sh
make migrate          # alembic upgrade head against EVALUATION_DATABASE_URL
                      #   (default: the local dev DB opspilot_evaluation)
make migrate-status    # alembic current
make test              # pytest
make lint               # ruff check
make typecheck          # mypy --strict
make run                 # uvicorn --reload on :8001
make check               # lint + typecheck + migrate + test, CI order
```

`make check` always migrates and tests exactly `opspilot_evaluation_test`:
both the Alembic migration and pytest run with `EVALUATION_DATABASE_URL`
pinned to the Makefile's `TEST_DATABASE_URL`, so a fresh `make check` migrates
only the test DB and never touches the dev DB. Standalone `make migrate`
still targets the dev database by default.

Equivalent plain `uv` commands (no Makefile needed):

```sh
uv run alembic upgrade head
uv run pytest -q
uv run ruff check src tests
uv run mypy
uv run uvicorn opspilot_evaluation.main:app --reload --port 8001
```

## TypeScript worker integration (Phase 3)

The worker evaluation CLI (`apps/worker/src/evaluation/run-eval.ts`) can score
the normalized v1 suite against this service instead of the in-process local
scorer. Selection is explicit and fail-closed via `EVALUATION_SCORER`; there is
**no automatic remote→local fallback** (see
`apps/worker/src/evaluation/service-unavailable.test.ts`).

Smallest reliable local flow — two terminals:

```sh
# terminal 1: run the service (dev DB, :8001)
cd services/evaluation
make migrate     # EVALUATION_DATABASE_URL defaults to the local dev DB
make run         # uvicorn --reload on :8001

# terminal 2: run the worker evaluation against the service
cd apps/worker
EVALUATION_SCORER=service \
EVALUATION_SERVICE_URL=http://127.0.0.1:8001 \
pnpm run eval
```

- `EVALUATION_SCORER=local` (the default) runs the in-process
  `LocalEvaluationScorer` — the explicit parity oracle. Use it to confirm the
  service is not masking a scorer regression:
  `pnpm --filter @opspilot/worker run eval` (no env needed).
- `EVALUATION_SCORER=service` posts the exact same normalized
  `EvaluationSuiteInputV1` to `POST /evaluations`, validates the persisted
  response strictly, and renders the same CLI semantics. `EVALUATION_SERVICE_URL`
  is required and must be an absolute http(s) URL; `EVALUATION_SERVICE_TIMEOUT_MS`
  (default 15000, bounds [1000, 600000]) is the single bounded request timeout.
- Cross-service parity is proven by
  `apps/worker/src/evaluation/cross-service-parity.test.ts` against this real
  service (it skips itself when no service is reachable), and CI runs it for
  real in the `cross-service-parity` job. Locally, with the service running
  and `EVALUATION_SERVICE_URL` exported, run
  `pnpm --filter @opspilot/worker run test:eval:cross-service` — that script
  sets `EVALUATION_SERVICE_REQUIRED=1`, so it FAILS if the service is not
  reachable rather than silently skipping.

## Notes

- This is a separate evidence stream from the root Harness Foundation
  (`pnpm agent:verify` etc.) — the Harness cannot attest Python behavior yet,
  so `make check` / CI's `evaluation-service` job are the source of truth for
  this service.
- The scorer (`scoring/scorer.py`, `scoring/metrics.py`) is a direct, tested
  port of `apps/worker/src/evaluation/evaluation-evaluator.ts` and
  `evaluation-metrics.ts`; parity against the TS-owned fixture
  (`apps/worker/src/evaluation/fixtures/ts-parity-v1.json`) is enforced by
  `tests/test_scorer_parity.py` and `tests/test_api.py`.
