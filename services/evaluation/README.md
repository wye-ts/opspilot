# opspilot-evaluation

Python/FastAPI evaluation service: authoritative deterministic scoring and
persistence for the **active v2 evaluation contract** (`EvaluationSuiteInputV2` /
`EvaluationSuiteResultV2`, see `apps/worker/src/evaluation/v2-types.ts`).
Phase 2 (OpsPilot #61) built the service standalone; Phase 3 wired it to the
TypeScript worker over HTTP (`POST /evaluations`, `GET /evaluations/{id}`);
Phase 4 made it the default authoritative scorer, and OpsPilot #59 Checkpoint
A/B advanced the contract to v2 (three-state checks, Milestone-11 observation
facts) and Checkpoint B added the nine #59 metric ratios — see
"TypeScript worker integration (Phases 3–4, #59)" below.

**Contract version 2 only.** The live router accepts `contractVersion: 2` at
`POST /evaluations`; a v1 body returns 422. The frozen v1 contract is **not**
accepted by the live router and is not a runtime compatibility path — it
survives solely as the offline historical oracle (see "Frozen v1 offline
oracle" below).

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

## TypeScript worker integration (Phases 3–4, #59)

The worker evaluation CLI (`apps/worker/src/evaluation/run-eval.ts`) scores
the normalized **v2** suite against this service by default. Selection is
explicit and fail-closed via `EVALUATION_SCORER`; there is **no automatic
fallback in either direction** between the service and the local oracle (see
`apps/worker/src/evaluation/service-unavailable.test.ts`).

As of Phase 4 (OpsPilot #61 default cutover), this Python service is the
**default, authoritative scorer** — `EVALUATION_SCORER` unset/empty resolves
to `service`, exactly like an explicit `EVALUATION_SCORER=service`, including
the same fail-closed requirement that `EVALUATION_SERVICE_URL` be set to an
absolute http(s) URL. There is no loopback URL default; the CLI fails clearly
with a configuration error if the URL is missing, rather than silently
running the local oracle instead.

Smallest reliable local flow — two terminals:

```sh
# terminal 1: run the service (dev DB, :8001)
cd services/evaluation
make migrate     # EVALUATION_DATABASE_URL defaults to the local dev DB
make run         # uvicorn --reload on :8001

# terminal 2: run the worker evaluation (default: service scorer)
cd apps/worker
EVALUATION_SERVICE_URL=http://127.0.0.1:8001 pnpm run eval
```

- **Default / `EVALUATION_SCORER=service`** posts the exact same normalized
  `EvaluationSuiteInputV2` to `POST /evaluations`, validates the persisted
  response strictly, and renders the same CLI semantics.
  `EVALUATION_SERVICE_URL` is required and must be an absolute http(s) URL;
  `EVALUATION_SERVICE_TIMEOUT_MS` (default 15000, bounds [1000, 600000]) is
  the single bounded request timeout. If the service is unreachable, times
  out, or returns a malformed/semantically inconsistent response, the CLI
  fails (non-zero exit) with no local fallback and no fabricated PASS.
- **`EVALUATION_SCORER=local`** runs the in-process `LocalEvaluationScorer` —
  the v2 parity oracle that mirrors the Python scorer function-for-function
  for explicit offline parity. Works without the Python service running at
  all: `EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval`. Use
  it to confirm the service is not masking a scorer regression.
- Cross-service parity is proven by
  `apps/worker/src/evaluation/cross-service-parity.test.ts` against this real
  service (it skips itself when no service is reachable), and CI runs it for
  real in the `cross-service-parity` job. Locally, with the service running
  and `EVALUATION_SERVICE_URL` exported, run
  `pnpm --filter @opspilot/worker run test:eval:cross-service` — that script
  sets `EVALUATION_SERVICE_REQUIRED=1`, so it FAILS if the service is not
  reachable rather than silently skipping.

## POST `/evaluations` v2 behavior

- Accepts `contractVersion: 2` only; a v1 body returns 422. `datasetId` is
  `opspilot-deterministic-v2` for the main suite.
- Scores the whole suite in memory, then persists run / per-case results /
  three-state checks / all fifteen metric rows in one transaction
  (`api.py`'s `_persist_evaluation`).
- Enforces the **exactly-nine** #59 metric completeness invariant: every case
  must emit exactly one PASS/FAIL/NOT_APPLICABLE outcome for each of the nine
  metric checks (`root-cause-discipline`, `evidence-support`,
  `unknown-telemetry-handling`, `diagnostic-justification`,
  `confidence-calibration`, `action-grounding`, `approval-gate`,
  `bounds-respected`, `deterministic-recovery`). The TS client re-validates
  this on every POST response (`MALFORMED_RESPONSE` otherwise).
- Check outcomes are three-state, persisted as `evaluation_checks.status`
  (`'PASS' | 'FAIL' | 'NOT_APPLICABLE'`) with the `reason_code` carried on
  FAIL/NOT_APPLICABLE. **`evaluation_checks.status` is the single source of
  truth**; the v1 `passed` boolean is gone (see the migration below).
  `evaluation_case_results.passed` (the per-case verdict) is a separate,
  genuinely distinct fact and remains.

## GET persisted-run compatibility

`GET /evaluations/{id}` serves persisted v2 runs. It retains **pre-B v2 GET
compatibility** for rows persisted during Checkpoint A:

```text
pre-B v2 row (all six original metric rows, none of the nine new rows)
  → GET succeeds
  → the nine new ratios are synthesized as 0/0 (zero-evaluated)
  → no PASS/FAIL/N/A check rows are invented
  → no write/backfill to the stored row

current B v2 row (all fifteen metric rows)
  → GET behaves normally

partial new-metric row (a subset of the nine new rows)
  → FAILS CLOSED with the service's internal-data error policy
  → never silently defaulted one metric at a time
```

A persisted `contract_version` other than 2 is refused with a stable
`CONTRACT_VERSION_UNSUPPORTED` error rather than served through a blind cast.

## Frozen v1 offline oracle

The v1 contract was relocated into an explicit legacy namespace and unwired
from every runtime path (OpsPilot #59 Checkpoint A):

- Python: `src/opspilot_evaluation/legacy_v1/` — `schemas_v1.py`,
  `scorer_v1.py`, `metrics_v1.py`, `reason_codes_v1.py`. The legacy v1 metric
  shape is a genuinely frozen six-metric structure owned by `legacy_v1`; it
  does **not** re-export the active schema, so the nine #59 metric fields
  never leak into v1 output. `tests/test_scorer_parity_v1.py` scores the same
  TS-owned frozen fixture (`apps/worker/src/evaluation/fixtures/ts-parity-v1.json`)
  offline and diffs strict historical structure equality.
- The live FastAPI router remains **v2-only**: nothing in `legacy_v1/` is
  imported by the router, and a v1 body is rejected at the POST boundary.

## The migration and its intentionally lossy downgrade

Alembic revision `04098efaef34` (`three_state_check_status`) migrates
`evaluation_checks` from the v1 two-state boolean to the v2 three-state
`status` domain:

```text
upgrade()   non-lossy for v1 data: passed → PASS/FAIL (NOT_APPLICABLE did
            not exist in v1); status made NOT NULL; v2 domain and
            status/reason_code constraints replace the old boolean invariant;
            passed dropped.

downgrade() intentionally LOSSY: v2 NOT_APPLICABLE check rows are DELETED
            (they have no v1 boolean counterpart), every remaining non-FAIL
            status maps back to passed = TRUE, and the v2 constraints are
            swapped back for the historical v1 invariant.
```

The downgrade is documented in the revision docstring as lossy rather than
pretending to be a clean inverse. `make check` runs the repository's standard
evaluator checks plus a fresh `alembic upgrade head` against the test database
— upgrade-head verification only; it does not itself run a downgrade. The
OpsPilot #59 checkpoint closure verification additionally ran the explicit
`alembic downgrade -1 → upgrade head` round-trip manually and deterministically
against the test database, exercising the migration's intentionally lossy
downgrade and confirming it upgrades back to head.

## Notes

- This is a separate evidence stream from the root Harness Foundation
  (`pnpm agent:verify` etc.) — the Harness cannot attest Python behavior yet,
  so `make check` / CI's `evaluation-service` job are the source of truth for
  this service.
- The authoritative scorer (`scoring/scorer.py`, `scoring/metrics.py`,
  `scoring/reason_codes.py`) is a direct, tested port of
  `apps/worker/src/evaluation/evaluation-evaluator.ts` and
  `evaluation-metrics.ts`, mirrored function-for-function in the TS local
  oracle (`LocalEvaluationScorer`). **Python is authoritative; the TS local
  scorer is the explicit deterministic parity oracle.** Parity against the
  TS-owned v2 fixture
  (`apps/worker/src/evaluation/fixtures/ts-parity-v2.json`) is enforced by
  `tests/test_scorer_parity.py` and `tests/test_api.py`, and the shared
  negative-vector fixture
  (`apps/worker/src/evaluation/fixtures/negative-vectors-v2.json`) proves
  cross-language agreement on every retained #59 FAIL reason code via
  `tests/test_negative_vectors.py`.
- The negative evaluator vectors are synthetic scorer inputs (not producible
  by the orchestrator) that assert the **exact** expected #59 failure set per
  shape; both consumers require the failure subset to match exactly and
  forbid unexpected #59 metric failures.
