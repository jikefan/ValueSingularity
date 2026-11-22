from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.memory.market import MemoryMarketRepository, default_market_overview
from app.adapters.postgres.market import PostgresMarketRepository
from app.api.deps import get_db, get_market_service
from app.db.base import Base
from app.db.models import MarketSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.models import MarketOverview
from app.main import create_app
from app.services.market import MarketService
from app.settings import settings


async def _make_override_client(service: object) -> AsyncIterator[AsyncClient]:
    app = create_app()
    app.dependency_overrides[get_market_service] = lambda: service
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


async def test_overview_matches_contract() -> None:
    service = MarketService(MemoryMarketRepository())
    async for test_client in _make_override_client(service):
        response = await test_client.get("/api/market/overview")
        assert response.status_code == 200

        body = response.json()
        assert body["schema_version"] == 1
        assert date.fromisoformat(body["as_of"]) == date(2026, 11, 18)
        assert body["data_source"] == "memory"
        assert body["indices"], "指数列表不能为空"
        assert body["hot_industries"], "行业资金流不能为空"
        assert 0 <= body["temperature"]["score"] <= 100
        assert body["temperature"]["level"] in {"cold", "cool", "neutral", "warm", "hot"}
        assert datetime.fromisoformat(body["generated_at"])
        assert {"code", "name", "price", "change_pct"} <= body["indices"][0].keys()


async def test_overview_is_ordered_by_inflow() -> None:
    service = MarketService(MemoryMarketRepository())
    async for test_client in _make_override_client(service):
        response = await test_client.get("/api/market/overview")
        assert response.status_code == 200
        flows = response.json()["hot_industries"]
        inflows = [flow["net_inflow"] for flow in flows]
        assert inflows == sorted(inflows, reverse=True)


async def test_overview_returns_503_when_snapshot_missing() -> None:
    service = MarketService(MemoryMarketRepository(allow_missing=True))
    async for test_client in _make_override_client(service):
        response = await test_client.get("/api/market/overview")
        assert response.status_code == 503
        assert "市场快照尚未生成" in response.json()["detail"]


async def test_overview_returns_503_when_db_unavailable() -> None:
    class _BrokenMarketRepo:
        async def overview(self) -> MarketOverview:
            raise DatabaseUnavailableError("OperationalError")

        async def save_overview(self, snapshot: MarketOverview) -> None:
            raise DatabaseUnavailableError("OperationalError")

    service = MarketService(_BrokenMarketRepo())
    async for test_client in _make_override_client(service):
        response = await test_client.get("/api/market/overview")
        assert response.status_code == 503
        assert "数据库不可用" in response.json()["detail"]


async def test_overview_empty_pg_returns_503(db_client: AsyncClient) -> None:
    response = await db_client.get("/api/market/overview")
    assert response.status_code == 503
    assert "市场快照尚未生成" in response.json()["detail"]


async def test_overview_pg_snapshot_roundtrip_and_update() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/api/market/overview")).status_code == 503

            day1 = default_market_overview().model_copy(
                update={
                    "as_of": date(2026, 11, 19),
                    "data_source": "akshare",
                    "generated_at": datetime(2026, 11, 19, 9, 35, tzinfo=UTC),
                }
            )
            async with testing_session() as session:
                await PostgresMarketRepository(session).save_overview(day1)

            resp1 = await client.get("/api/market/overview")
            assert resp1.status_code == 200
            body1 = resp1.json()
            assert body1["as_of"] == "2026-11-19"
            assert body1["data_source"] == "akshare"

            day2 = day1.model_copy(
                update={
                    "as_of": date(2026, 11, 20),
                    "data_source": "akshare:index-em",
                    "generated_at": datetime(2026, 11, 20, 9, 35, tzinfo=UTC),
                }
            )
            async with testing_session() as session:
                await PostgresMarketRepository(session).save_overview(day2)
                row_count = await session.scalar(select(func.count()).select_from(MarketSnapshot))
                assert row_count == 1

            resp2 = await client.get("/api/market/overview")
            assert resp2.status_code == 200
            body2 = resp2.json()
            assert body2["as_of"] == "2026-11-20"
            assert body2["data_source"] == "akshare:index-em"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
