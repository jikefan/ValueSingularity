from __future__ import annotations

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.models import StockMeta
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


async def _seed_stock_meta(code: str, name: str, exchange: str = "SH") -> None:
    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(
                lambda sync_conn: sync_conn.execute(
                    StockMeta.__table__.insert().values(
                        code=code,
                        name=name,
                        exchange=exchange,
                        is_st=False,
                        is_active=True,
                    )
                )
            )
    finally:
        await engine.dispose()


async def test_journal_and_events_require_auth(db_client: AsyncClient) -> None:
    assert (await db_client.get("/api/journal")).status_code == 401
    assert (
        await db_client.post(
            "/api/journal",
            json={
                "code": "600519",
                "action": "buy",
                "reason": "长期护城河",
                "falsify_condition": "ROE 跌破 15%",
            },
        )
    ).status_code == 401
    assert (await db_client.delete("/api/journal/1")).status_code == 401

    assert (await db_client.get("/api/events")).status_code == 401
    assert (
        await db_client.post("/api/events", json={"type": "stock_view", "code": "600519"})
    ).status_code == 401


async def test_journal_and_events_validation_boundaries(db_client: AsyncClient) -> None:
    headers = await _auth_headers(db_client, "journal-bounds@example.com", "Bounds")

    invalid_journal_payloads: list[dict[str, object]] = [
        {
            "code": "600519",
            "action": "buy",
            "reason": "",
            "falsify_condition": "ROE 跌破 15%",
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "   ",
            "falsify_condition": "ROE 跌破 15%",
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "",
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "   ",
        },
        {
            "code": "600519",
            "action": "hold",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
        },
        {
            "code": "60051",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "price": 1e12,
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "price": 0.0001,
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "benchmark_price": 1e12,
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "max_drawdown": 100.1,
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "falsify_rules": [{"metric": "   ", "op": "lt", "value": 15.0}],
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "falsify_rules": [{"metric": "roe", "op": "neq", "value": 15.0}],
        },
        {
            "code": "600519",
            "action": "buy",
            "reason": "逻辑清晰",
            "falsify_condition": "ROE 跌破 15%",
            "falsify_rules": [{"metric": "roe", "op": "lt", "value": 15.0, "periods": 0}],
        },
    ]
    for payload in invalid_journal_payloads:
        resp = await db_client.post("/api/journal", headers=headers, json=payload)
        assert resp.status_code == 422, f"Expected 422 for {payload}, got {resp.status_code}"

    invalid_event_payloads: list[dict[str, object]] = [
        {"type": ""},
        {"type": "   "},
        {"type": "view", "code": "12345"},
    ]
    for payload in invalid_event_payloads:
        resp = await db_client.post("/api/events", headers=headers, json=payload)
        assert resp.status_code == 422, f"Expected 422 for {payload}, got {resp.status_code}"

    trimmed = await db_client.post(
        "/api/journal",
        headers=headers,
        json={
            "code": "600519",
            "name": "   ",
            "action": "pass",
            "reason": "  估值偏高，先观察  ",
            "falsify_condition": "  动态 PE 回落至 22 倍以下  ",
            "emotion": "  ",
            "price": 1450.5,
        },
    )
    assert trimmed.status_code == 201
    trimmed_body = trimmed.json()
    assert trimmed_body["name"] is None
    assert trimmed_body["emotion"] is None
    assert trimmed_body["reason"] == "估值偏高，先观察"
    assert trimmed_body["falsify_condition"] == "动态 PE 回落至 22 倍以下"
    assert trimmed_body["benchmark_code"] == "000300"


async def test_journal_crud_all_actions_and_audit_events(db_client: AsyncClient) -> None:
    await _seed_stock_meta("600519", "贵州茅台", "SH")
    headers = await _auth_headers(db_client, "journal-crud@example.com", "Trader")

    actions = ["buy", "add", "trim", "sell", "pass"]
    created_ids: list[int] = []
    for idx, action in enumerate(actions):
        payload: dict[str, object] = {
            "code": "600519" if idx < 4 else "000001",
            "action": action,
            "reason": f"决策原因-{action}",
            "falsify_condition": f"否证红线-{action}",
            "falsify_rules": [
                {"metric": " roe ", "op": "lt", "value": 15.0, "periods": 2},
            ],
            "max_drawdown": 20.5,
            "emotion": "冷静",
            "price": 1400.125 + idx,
            "benchmark_code": "000300",
            "benchmark_price": 3980.5,
        }
        if idx == 4:
            payload["name"] = "平安银行"

        resp = await db_client.post("/api/journal", headers=headers, json=payload)
        assert resp.status_code == 201
        entry = resp.json()
        created_ids.append(entry["id"])
        assert entry["action"] == action
        assert entry["falsify_rules"] == [
            {"metric": "roe", "op": "lt", "value": 15.0, "periods": 2}
        ]
        assert entry["max_drawdown"] == 20.5
        assert entry["price"] == 1400.125 + idx
        assert entry["benchmark_code"] == "000300"
        assert entry["benchmark_price"] == 3980.5
        if idx < 4:
            assert entry["name"] == "贵州茅台"
        else:
            assert entry["name"] == "平安银行"

    all_entries = await db_client.get("/api/journal", headers=headers)
    assert all_entries.status_code == 200
    all_items = all_entries.json()
    assert [item["id"] for item in all_items] == list(reversed(created_ids))

    filtered = await db_client.get("/api/journal", headers=headers, params={"code": "600519"})
    assert filtered.status_code == 200
    assert len(filtered.json()) == 4
    assert all(item["code"] == "600519" for item in filtered.json())

    # Journal creation automatically logs journal_created events.
    events_resp = await db_client.get("/api/events", headers=headers)
    assert events_resp.status_code == 200
    events = events_resp.json()
    assert len(events) == 5
    assert [e["meta"]["action"] for e in events] == list(reversed(actions))
    assert all(e["type"] == "journal_created" for e in events)

    # Explicit non-empty name is preserved instead of overwritten by stock_meta.
    explicit = await db_client.post(
        "/api/journal",
        headers=headers,
        json={
            "code": "600519",
            "name": "茅台自定义别名",
            "action": "pass",
            "reason": "估值跟踪",
            "falsify_condition": "业绩增速低于 10%",
        },
    )
    assert explicit.status_code == 201
    assert explicit.json()["name"] == "茅台自定义别名"

    custom_event = await db_client.post(
        "/api/events",
        headers=headers,
        json={"type": "  stock_view ", "code": "600519", "meta": {"tab": "journal", "ok": True}},
    )
    assert custom_event.status_code == 201
    custom_body = custom_event.json()
    assert custom_body["type"] == "stock_view"
    assert custom_body["code"] == "600519"
    assert custom_body["meta"] == {"tab": "journal", "ok": True}

    delete_resp = await db_client.delete(f"/api/journal/{created_ids[0]}", headers=headers)
    assert delete_resp.status_code == 204
    assert (
        await db_client.delete(f"/api/journal/{created_ids[0]}", headers=headers)
    ).status_code == 404


async def test_journal_and_events_tenant_isolation(db_client: AsyncClient) -> None:
    headers_a = await _auth_headers(db_client, "journal_a@example.com", "User A")
    headers_b = await _auth_headers(db_client, "journal_b@example.com", "User B")

    created_a = await db_client.post(
        "/api/journal",
        headers=headers_a,
        json={
            "code": "600519",
            "name": "贵州茅台",
            "action": "buy",
            "reason": "A的买入理由",
            "falsify_condition": "A的否证条件",
        },
    )
    assert created_a.status_code == 201
    entry_a_id = created_a.json()["id"]

    event_a = await db_client.post(
        "/api/events",
        headers=headers_a,
        json={"type": "search_click", "code": "600519"},
    )
    assert event_a.status_code == 201

    # User B cannot read User A's journal or events, nor delete User A's entry.
    assert (await db_client.get("/api/journal", headers=headers_b)).json() == []
    assert (await db_client.get("/api/events", headers=headers_b)).json() == []
    assert (
        await db_client.delete(f"/api/journal/{entry_a_id}", headers=headers_b)
    ).status_code == 404

    # User A's entry and events remain intact.
    items_a = (await db_client.get("/api/journal", headers=headers_a)).json()
    events_a = (await db_client.get("/api/events", headers=headers_a)).json()
    assert len(items_a) == 1 and items_a[0]["id"] == entry_a_id
    assert len(events_a) == 2
