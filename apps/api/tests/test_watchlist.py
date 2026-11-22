from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deps import get_db
from app.db.base import Base
from app.main import create_app
from app.settings import settings


async def _auth_headers(client: AsyncClient, email: str, display_name: str) -> dict[str, str]:
    response = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "strong-password-123",
            "display_name": display_name,
        },
    )
    assert response.status_code == 201
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_watchlist_requires_auth(db_client: AsyncClient) -> None:
    assert (await db_client.get("/api/watchlist")).status_code == 401
    assert (
        await db_client.put(
            "/api/watchlist",
            json={"code": "600519", "name": "贵州茅台"},
        )
    ).status_code == 401
    assert (await db_client.delete("/api/watchlist/600519")).status_code == 401


async def test_watchlist_crud_with_sentinel(db_client: AsyncClient) -> None:
    headers = await _auth_headers(db_client, "sentinel@example.com", "Sentinel")
    assert (await db_client.get("/api/watchlist", headers=headers)).json() == []

    created = await db_client.put(
        "/api/watchlist",
        headers=headers,
        json={
            "code": "600519",
            "name": "贵州茅台",
            "industry": "白酒",
            "note": "长期跟踪",
            "target_price": 1450.5,
            "target_pe_percentile": 25.0,
            "target_dividend_yield": 3.8,
            "alert_enabled": True,
        },
    )
    assert created.status_code == 200
    body = created.json()
    assert body["code"] == "600519"
    assert body["name"] == "贵州茅台"
    assert body["industry"] == "白酒"
    assert body["note"] == "长期跟踪"
    assert body["target_price"] == 1450.5
    assert body["target_pe_percentile"] == 25.0
    assert body["target_dividend_yield"] == 3.8
    assert body["alert_enabled"] is True
    assert body["added_at"]
    assert body["updated_at"]

    assert len((await db_client.get("/api/watchlist", headers=headers)).json()) == 1

    updated = await db_client.put(
        "/api/watchlist",
        headers=headers,
        json={
            "code": "600519",
            "name": "贵州茅台",
            "industry": "白酒",
            "note": "等回调",
            "target_price": 1450.5,
            "target_pe_percentile": 25.0,
            "target_dividend_yield": 3.8,
            "alert_enabled": True,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["note"] == "等回调"
    assert updated.json()["updated_at"]
    assert len((await db_client.get("/api/watchlist", headers=headers)).json()) == 1, (
        "upsert 不应产生重复行"
    )

    assert (await db_client.delete("/api/watchlist/600519", headers=headers)).status_code == 204
    assert (await db_client.delete("/api/watchlist/600519", headers=headers)).status_code == 404
    assert (await db_client.get("/api/watchlist", headers=headers)).json() == []


async def test_watchlist_rejects_bad_code(db_client: AsyncClient) -> None:
    headers = await _auth_headers(db_client, "badcode@example.com", "BadCode")
    response = await db_client.put(
        "/api/watchlist",
        headers=headers,
        json={"code": "60051", "name": "贵州茅台"},
    )
    assert response.status_code == 422


async def test_watchlist_tenant_isolation(db_client: AsyncClient) -> None:
    headers_a = await _auth_headers(db_client, "user_a@example.com", "User A")
    headers_b = await _auth_headers(db_client, "user_b@example.com", "User B")

    created_a = await db_client.put(
        "/api/watchlist",
        headers=headers_a,
        json={"code": "600519", "name": "贵州茅台", "note": "A的茅台"},
    )
    assert created_a.status_code == 200

    assert (await db_client.get("/api/watchlist", headers=headers_b)).json() == []
    assert (await db_client.delete("/api/watchlist/600519", headers=headers_b)).status_code == 404

    created_b = await db_client.put(
        "/api/watchlist",
        headers=headers_b,
        json={"code": "600519", "name": "贵州茅台", "note": "B的茅台"},
    )
    assert created_b.status_code == 200

    items_a = (await db_client.get("/api/watchlist", headers=headers_a)).json()
    items_b = (await db_client.get("/api/watchlist", headers=headers_b)).json()
    assert len(items_a) == 1 and items_a[0]["note"] == "A的茅台"
    assert len(items_b) == 1 and items_b[0]["note"] == "B的茅台"


async def test_watchlist_validation_boundaries(db_client: AsyncClient) -> None:
    headers = await _auth_headers(db_client, "bounds@example.com", "Bounds")

    invalid_payloads: list[dict[str, object]] = [
        {"code": "600519", "name": "   "},
        {"code": "600519", "name": ""},
        {"code": "600519", "name": "名" * 65},
        {"code": "600519", "name": "贵州茅台", "industry": "行" * 65},
        {"code": "600519", "name": "贵州茅台", "target_price": 1e9},
        {"code": "600519", "name": "贵州茅台", "target_price": 0.0001},
        {"code": "600519", "name": "贵州茅台", "target_pe_percentile": -0.1},
        {"code": "600519", "name": "贵州茅台", "target_pe_percentile": 100.1},
        {"code": "600519", "name": "贵州茅台", "target_dividend_yield": -0.1},
        {"code": "600519", "name": "贵州茅台", "target_dividend_yield": 100.1},
    ]
    for payload in invalid_payloads:
        resp = await db_client.put("/api/watchlist", headers=headers, json=payload)
        assert resp.status_code == 422, f"Expected 422 for {payload}, got {resp.status_code}"

    max_valid = await db_client.put(
        "/api/watchlist",
        headers=headers,
        json={
            "code": "600519",
            "name": "  贵州茅台  ",
            "industry": "   ",
            "target_price": 999_999_999.999,
            "target_pe_percentile": 100,
            "target_dividend_yield": 0,
        },
    )
    assert max_valid.status_code == 200
    max_body = max_valid.json()
    assert max_body["name"] == "贵州茅台"
    assert max_body["industry"] is None
    assert max_body["target_price"] == 999_999_999.999

    min_valid = await db_client.put(
        "/api/watchlist",
        headers=headers,
        json={"code": "600519", "name": "贵州茅台", "target_price": 0.001},
    )
    assert min_valid.status_code == 200
    assert min_valid.json()["target_price"] == 0.001


async def test_watchlist_concurrent_first_time_upsert() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    concurrency = 6
    engine = create_async_engine(settings.test_database_url, pool_size=concurrency, max_overflow=0)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with AsyncExitStack() as stack:
            warm_sessions = [
                await stack.enter_async_context(testing_session()) for _ in range(concurrency)
            ]
            await asyncio.gather(*(session.execute(text("SELECT 1")) for session in warm_sessions))

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await _auth_headers(client, "concurrent-wl@example.com", "Concurrent")

        async def put_item(idx: int) -> Response:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as req_client:
                return await req_client.put(
                    "/api/watchlist",
                    headers=headers,
                    json={
                        "code": "600519",
                        "name": "贵州茅台",
                        "note": f"并发-{idx}",
                        "target_price": 1400 + idx,
                        "alert_enabled": True,
                    },
                )

        responses = await asyncio.gather(*(put_item(i) for i in range(concurrency)))
        assert all(resp.status_code == 200 for resp in responses)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            listed = await client.get("/api/watchlist", headers=headers)
            assert listed.status_code == 200
            items = listed.json()
            assert len(items) == 1
            assert items[0]["code"] == "600519"
            assert items[0]["note"] in {f"并发-{i}" for i in range(concurrency)}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_health_db(db_client: AsyncClient) -> None:
    response = await db_client.get("/api/health/db")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
