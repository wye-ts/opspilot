"""Fix (BLOCKER): tests must fail closed before truncating any database other
than the test database. Covers the accepted test DSN, the rejected dev DSN,
and the guarantee that the rejection message never leaks DSN material.
"""

from __future__ import annotations

import pytest

from tests.db_safety import TEST_DATABASE_NAME, assert_safe_test_database


def test_accepts_the_test_database_dsn() -> None:
    # Local default shape, CI shape (postgres://), and a query-string variant
    # must all resolve to the canonical test database name.
    assert_safe_test_database("postgresql://user:pass@host:5432/opspilot_evaluation_test")
    assert_safe_test_database("postgres://user:pass@host:5432/opspilot_evaluation_test")
    assert_safe_test_database(
        "postgresql://user:pass@host:5432/opspilot_evaluation_test?sslmode=require"
    )


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://user:pass@host:5432/opspilot_evaluation",
        "postgres://user:pass@host:5432/opspilot_evaluation",
        "postgresql://user:pass@host:5432/opspilot",
        "postgresql://user:pass@host:5432/opspilot_evaluation_test_extra",
    ],
)
def test_rejects_any_non_test_database(url: str) -> None:
    with pytest.raises(ValueError, match=TEST_DATABASE_NAME):
        assert_safe_test_database(url)


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://alice:supersecret@db.internal/opspilot_evaluation?token=sentinel",
        "mysql://alice:supersecret@db.internal/evaluations?token=sentinel",
    ],
)
def test_error_message_never_leaks_dsn_components(url: str) -> None:
    with pytest.raises(ValueError) as excinfo:
        assert_safe_test_database(url)
    message = str(excinfo.value)
    for leaked in ("alice", "supersecret", "db.internal", "sentinel", "mysql://", "postgresql://"):
        assert leaked not in message
