# opspilot-evaluation

Phase 2 (OpsPilot #61) Python/FastAPI evaluation service: authoritative
deterministic scoring and persistence for the frozen v1 evaluation contract
(`EvaluationSuiteInputV1` / `EvaluationSuiteResultV1`, see
`apps/worker/src/evaluation/v1-types.ts`). Standalone from the TypeScript
worker/API — no HTTP integration between them yet (that is Phase 3).

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
