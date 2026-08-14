from __future__ import annotations

import os

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from opspilot_evaluation.db.session import get_sessionmaker
from opspilot_evaluation.main import create_app
from tests.db_safety import TEST_DATABASE_DSN, assert_safe_test_database

# Resolve the effective test DB URL and fail closed before any destructive SQL
# can run. pydantic-settings reads the env var at Settings() construction time
# (get_settings() is called fresh per use, never at import), so setting it here
# at module level — before any test or fixture constructs Settings — is
# sufficient without any import-order trickery. A caller-exported dev DSN is
# rejected rather than silently preserved (no setdefault): tests must never
# truncate the development database.
_effective_test_url = os.environ.get("EVALUATION_DATABASE_URL", TEST_DATABASE_DSN)
assert_safe_test_database(_effective_test_url)
os.environ["EVALUATION_DATABASE_URL"] = _effective_test_url

TABLES = (
    "evaluation_checks",
    "evaluation_metrics",
    "evaluation_case_results",
    "evaluation_runs",
)


@pytest_asyncio.fixture(autouse=True)
async def _truncate_tables():
    # Fail closed immediately before the destructive TRUNCATE, resolving the
    # effective URL here rather than trusting the module-level default (a
    # later env mutation or a mismatched sessionmaker would otherwise let a
    # non-test database through).
    assert_safe_test_database(os.environ.get("EVALUATION_DATABASE_URL", TEST_DATABASE_DSN))
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        await session.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        await session.commit()
    yield


@pytest_asyncio.fixture
async def client():
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
