from __future__ import annotations

from httpx import AsyncClient


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


async def test_health_db(db_client: AsyncClient) -> None:
    response = await db_client.get("/api/health/db")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
