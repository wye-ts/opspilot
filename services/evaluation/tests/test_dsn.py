import pytest

from opspilot_evaluation.config import UnsupportedDatabaseUrlError, normalize_database_url


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "postgres://user:pass@host:5432/db",
            "postgresql+asyncpg://user:pass@host:5432/db",
        ),
        (
            "postgresql://user:pass@host:5432/db",
            "postgresql+asyncpg://user:pass@host:5432/db",
        ),
        (
            "postgresql+asyncpg://user:pass@host:5432/db",
            "postgresql+asyncpg://user:pass@host:5432/db",
        ),
    ],
)
def test_normalize_database_url(raw: str, expected: str) -> None:
    assert normalize_database_url(raw) == expected


def test_normalize_database_url_rejects_unsupported_scheme() -> None:
    with pytest.raises(UnsupportedDatabaseUrlError):
        normalize_database_url("mysql://user:pass@host:3306/db")


def test_unsupported_scheme_error_never_leaks_dsn() -> None:
    # Fix (MAJOR): the raw DSN — credentials, host, database, query — must
    # never surface in UnsupportedDatabaseUrlError's message.
    with pytest.raises(UnsupportedDatabaseUrlError) as excinfo:
        normalize_database_url("mysql://alice:supersecret@db.internal/evaluations?token=sentinel")
    message = str(excinfo.value)
    for leaked in ("alice", "supersecret", "db.internal", "evaluations", "sentinel", "mysql://"):
        assert leaked not in message
