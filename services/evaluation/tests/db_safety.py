"""Fail-closed guard for destructive test database operations.

The autouse truncation fixture in conftest.py resolves the effective
EVALUATION_DATABASE_URL and refuses to TRUNCATE (or otherwise reset) any
database whose name is not exactly TEST_DATABASE_NAME. This module is the
single place that decision is made, so a misconfiguration surfaces loudly
and consistently.

The raised error never echoes the URL, DSN, host, credentials, or path — only
the accepted test database name — so a developer pointing tests at a dev or
staging database gets a clear signal without leaking connection secrets.
"""

from __future__ import annotations

from urllib.parse import urlsplit

# Canonical database name tests are allowed to TRUNCATE/reset. The default
# local DSN (conftest.py) and CI (the evaluation-service job) both point here;
# any other database name is refused before destructive SQL runs.
TEST_DATABASE_NAME = "opspilot_evaluation_test"

# The local default test DSN, used when EVALUATION_DATABASE_URL is not set.
# Mirrors the Makefile's TEST_DATABASE_URL so `make check` and pytest agree
# on the same database.
TEST_DATABASE_DSN = (
    "postgresql://opspilot:opspilot_local_dev_only@localhost:55432/opspilot_evaluation_test"
)


def _database_name(url: str) -> str:
    """The database name (last path segment) of a DSN, ignoring any query."""
    return urlsplit(url).path.lstrip("/")


def assert_safe_test_database(url: str) -> None:
    """Refuse destructive operations unless `url` names the test database.

    Raises ValueError with a message that contains only the accepted test
    database name — never the URL, its host, credentials, or path.
    """
    if _database_name(url) != TEST_DATABASE_NAME:
        raise ValueError(
            f"Refusing destructive test operation: the database must be exactly '{TEST_DATABASE_NAME}'."
        )
