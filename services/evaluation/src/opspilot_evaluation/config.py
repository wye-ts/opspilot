"""Service configuration and the single DSN-normalization helper.

Canonical env var is EVALUATION_DATABASE_URL. It may be a postgres:// or
postgresql:// DSN; normalize_database_url() is the ONE place that rewrites it
to the postgresql+asyncpg:// form SQLAlchemy's async engine requires (see
opspilot-61-phase2-python-evaluation-service-core.md "Database configuration"
— do not spread DSN-rewrite logic elsewhere).
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

_POSTGRES_SCHEME = "postgres://"
_POSTGRESQL_SCHEME = "postgresql://"
_ASYNCPG_SCHEME = "postgresql+asyncpg://"


class UnsupportedDatabaseUrlError(ValueError):
    def __init__(self) -> None:
        # Deliberately does NOT echo the offending URL: a DSN carries
        # credentials/host/database and must never surface in the exception
        # message or in any log that records it (see the "Redact unsupported
        # DB URL errors" fix). The accepted schemes are the only useful,
        # non-sensitive detail worth surfacing.
        super().__init__("Unsupported database URL scheme: expected 'postgres://' or 'postgresql://'")


def normalize_database_url(raw: str) -> str:
    """Convert a postgres:// or postgresql:// DSN to postgresql+asyncpg://."""
    if raw.startswith(_ASYNCPG_SCHEME):
        return raw
    if raw.startswith(_POSTGRESQL_SCHEME):
        return _ASYNCPG_SCHEME + raw[len(_POSTGRESQL_SCHEME) :]
    if raw.startswith(_POSTGRES_SCHEME):
        return _ASYNCPG_SCHEME + raw[len(_POSTGRES_SCHEME) :]
    raise UnsupportedDatabaseUrlError()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    evaluation_database_url: str = (
        "postgresql://opspilot:opspilot_local_dev_only@localhost:55432/opspilot_evaluation"
    )

    @property
    def async_database_url(self) -> str:
        return normalize_database_url(self.evaluation_database_url)


def get_settings() -> Settings:
    return Settings()
