from __future__ import annotations

from httpx import AsyncClient


async def test_watchlist_crud(db_client: AsyncClient) -> None:
    assert (await db_client.get("/api/watchlist")).json() == []

    created = await db_client.put(
        "/api/watchlist",
        json={"code": "600519", "name": "贵州茅台", "industry": "白酒", "note": "长期跟踪"},
    )
    assert created.status_code == 200
    body = created.json()
    assert body["code"] == "600519"
    assert body["name"] == "贵州茅台"
    assert body["added_at"]

    assert len((await db_client.get("/api/watchlist")).json()) == 1

    updated = await db_client.put(
        "/api/watchlist",
        json={"code": "600519", "name": "贵州茅台", "industry": "白酒", "note": "等回调"},
    )
    assert updated.json()["note"] == "等回调"
    assert len((await db_client.get("/api/watchlist")).json()) == 1, "upsert 不应产生重复行"

    assert (await db_client.delete("/api/watchlist/600519")).status_code == 204
    assert (await db_client.delete("/api/watchlist/600519")).status_code == 404
    assert (await db_client.get("/api/watchlist")).json() == []


async def test_watchlist_rejects_bad_code(db_client: AsyncClient) -> None:
    response = await db_client.put("/api/watchlist", json={"code": "60051", "name": "贵州茅台"})
    assert response.status_code == 422


async def test_health_db(db_client: AsyncClient) -> None:
    response = await db_client.get("/api/health/db")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
