.PHONY: sync test lint typecheck migrate migrate-status run check

# Installs Python 3.13 (via uv) and the service's dependencies into .venv/.
sync:
	uv sync

test:
	uv run pytest -q

lint:
	uv run ruff check src tests

typecheck:
	uv run mypy

# Standalone dev migration target: alembic upgrades whatever
# EVALUATION_DATABASE_URL points at (default: the local dev database
# `opspilot_evaluation`). `make check` overrides this with the test DSN.
migrate:
	uv run alembic upgrade head

migrate-status:
	uv run alembic current

run:
	uv run uvicorn opspilot_evaluation.main:app --reload --port 8001

# The only DSN `make check` may migrate or test against. Tests refuse to
# TRUNCATE any other database (see tests/db_safety.py), and this Makefile
# deliberately points BOTH Alembic and pytest at it so migration and tests
# can never drift apart.
TEST_DATABASE_URL ?= postgresql://opspilot:opspilot_local_dev_only@localhost:55432/opspilot_evaluation_test

# Everything CI runs, in the same order, for a fast local pre-push check.
# Both migration and pytest run with EVALUATION_DATABASE_URL pinned to
# TEST_DATABASE_URL — standalone `make migrate` still targets the dev
# database, but `make check` must migrate exactly the database pytest is
# about to truncate/test.
check: lint typecheck
	EVALUATION_DATABASE_URL="$(TEST_DATABASE_URL)" uv run alembic upgrade head
	EVALUATION_DATABASE_URL="$(TEST_DATABASE_URL)" uv run pytest -q
