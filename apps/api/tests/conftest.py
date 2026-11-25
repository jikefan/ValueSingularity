from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.email.smtp import UnconfiguredEmailSender
from app.adapters.postgres import snapshot as snapshot_adapter
from app.api.deps import get_db, get_email_sender, get_watchlist_warmup
from app.db.base import Base
from app.main import create_app
from app.settings import settings


def _clear_snapshot_cache_state() -> None:
    snapshot_adapter._SUMMARY_CACHE.clear()
    snapshot_adapter._SUMMARY_EPOCHS.clear()
    for loop_tasks in list(snapshot_adapter._SUMMARY_REFRESH_TASKS.values()):
        for task in list(loop_tasks.values()):
            if not task.done():
                task.cancel()
        loop_tasks.clear()
    snapshot_adapter._SUMMARY_REFRESH_TASKS.clear()


@pytest.fixture(autouse=True)
def _isolate_email_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep tests isolated from host SMTP config and cross-test snapshot cache state."""
    monkeypatch.setattr(settings, "smtp_host", None)
    monkeypatch.setattr(settings, "smtp_username", None)
    monkeypatch.setattr(settings, "smtp_password", None)
    monkeypatch.setattr(settings, "smtp_from_email", None)
    monkeypatch.setattr(settings, "auth_require_email_verification", None)
    monkeypatch.setattr(settings, "snapshot_summary_cache_ttl_seconds", 0.0)
    _clear_snapshot_cache_state()
    yield
    _clear_snapshot_cache_state()


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """No database: routes used here must not touch it."""
    async with AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    ) as test_client:
        yield test_client


@pytest.fixture
async def db_client() -> AsyncIterator[AsyncClient]:
    """Real PostgreSQL client. Skipped when VS_TEST_DATABASE_URL is unset."""
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    app = create_app()

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        async with testing_session() as session:
            yield session

    async def _noop_warmup(_code: str) -> None:
        return None

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_email_sender] = UnconfiguredEmailSender
    app.dependency_overrides[get_watchlist_warmup] = lambda: _noop_warmup
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
