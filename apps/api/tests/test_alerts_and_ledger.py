from __future__ import annotations

import asyncio
import json
import logging
import socket
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.notifications.webhook import HttpxWebhookNotifier
from app.adapters.postgres.alert import PostgresAlertRepository, PostgresSettingsRepository
from app.adapters.postgres.journal import PostgresJournalRepository
from app.adapters.postgres.market import PostgresMarketRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.adapters.postgres.watchlist import PostgresWatchlistRepository
from app.api.deps import get_db, get_watchlist_warmup, get_webhook_notifier
from app.cli import scan_alerts, sync_stocks
from app.db.base import Base
from app.db.models import JournalEntry, StockMeta
from app.domain.market_math import build_market_overview
from app.domain.models import (
    IndexDailyRow,
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    StockMetaRecord,
    StockSnapshotPayload,
    StockSyncSummary,
    StoredNotificationConfig,
    TradeCalendarEntry,
    TriggeredAlertCandidate,
)
from app.main import create_app
from app.services.alerts import AlertScanService
from app.settings import settings
from tests.test_phase3_engines import _make_snapshot


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


async def _seed_market_and_snapshots(
    *,
    as_of: date,
    csi300_close: float,
    snapshots: list[StockSnapshotPayload],
) -> None:
    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        session_maker = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with session_maker() as session:
            for snap in snapshots:
                existing = await session.get(StockMeta, snap.code)
                if existing is None:
                    session.add(
                        StockMeta(
                            code=snap.code,
                            name=snap.name,
                            exchange=snap.exchange,
                            is_st=False,
                            is_active=True,
                        )
                    )
            await session.commit()

            bundle = MarketFeedBundle(
                as_of=as_of,
                data_source="akshare",
                indices=[
                    IndexQuote(code="000001", name="上证指数", price=3300.0, change_pct=0.5),
                ],
                hot_industries=[
                    IndustryFlow(name="白酒", change_pct=1.2, net_inflow=5e8, companies=20),
                ],
                stock_list=[
                    StockMetaRecord(code=snap.code, name=snap.name, exchange=snap.exchange)
                    for snap in snapshots
                ],
                trade_calendar=[TradeCalendarEntry(trade_date=as_of, is_open=True)],
                index_daily=[
                    IndexDailyRow(
                        code="000300",
                        trade_date=as_of,
                        close=csi300_close,
                        change_pct=0.4,
                    )
                ],
                macro_rates=[
                    MacroRateRow(
                        trade_date=as_of,
                        cn_10y_bond_yield=2.0,
                        market_pe_median=25.0,
                    )
                ],
            )
            overview = build_market_overview(bundle, bundle.macro_rates)
            await PostgresMarketRepository(session).save_overview(overview)

            snap_repo = PostgresStockSnapshotRepository(session)
            for snap in snapshots:
                await snap_repo.save_snapshot(snap)
    finally:
        await engine.dispose()


async def test_journal_time_capsule_capture_and_decision_ledger(db_client: AsyncClient) -> None:
    snap_entry_a = _make_snapshot(
        code="600519",
        name="贵州茅台",
        as_of=date(2026, 10, 1),
        close=1400.0,
        pe_ttm=20.0,
        pe_percentile_10y=25.0,
        ct_red_count=0,
        total_score=84,
    )
    snap_entry_b = _make_snapshot(
        code="000858",
        name="五粮液",
        as_of=date(2026, 10, 1),
        close=150.0,
        pe_ttm=18.0,
        pe_percentile_10y=35.0,
        ct_red_count=0,
        total_score=78,
    )
    await _seed_market_and_snapshots(
        as_of=date(2026, 10, 1),
        csi300_close=4000.0,
        snapshots=[snap_entry_a, snap_entry_b],
    )

    headers_a = await _auth_headers(db_client, "ledger-a@example.com", "Ledger A")
    headers_b = await _auth_headers(db_client, "ledger-b@example.com", "Ledger B")

    buy_resp = await db_client.post(
        "/api/journal",
        headers=headers_a,
        json={
            "code": "600519",
            "action": "buy",
            "reason": "估值进入历史低位",
            "falsify_condition": "排雷红灯或估值突破 25x",
            "falsify_rules": [{"metric": "pe_ttm", "op": "gt", "value": 25.0}],
            "emotion": "冷静",
        },
    )
    assert buy_resp.status_code == 201
    buy_body = buy_resp.json()
    assert buy_body["name"] == "贵州茅台"
    assert buy_body["price"] == 1400.0
    assert buy_body["benchmark_code"] == "000300"
    assert buy_body["benchmark_price"] == 4000.0
    assert buy_body["snapshot"]["close"] == 1400.0
    assert buy_body["snapshot"]["pe_ttm"] == 20.0
    assert buy_body["snapshot"]["total_score"] == 84
    assert buy_body["snapshot"]["benchmark_price"] == 4000.0

    pass_resp = await db_client.post(
        "/api/journal",
        headers=headers_a,
        json={
            "code": "000858",
            "action": "pass",
            "reason": "渠道库存仍高",
            "falsify_condition": "批价企稳",
            "emotion": "谨慎",
        },
    )
    assert pass_resp.status_code == 201
    assert pass_resp.json()["price"] == 150.0
    assert pass_resp.json()["benchmark_price"] == 4000.0

    explicit_resp = await db_client.post(
        "/api/journal",
        headers=headers_b,
        json={
            "code": "600519",
            "name": "自定义名称",
            "action": "buy",
            "reason": "手工录入成交价",
            "falsify_condition": "跌破成本",
            "price": 1388.88,
            "benchmark_price": 3950.0,
        },
    )
    assert explicit_resp.status_code == 201
    explicit_body = explicit_resp.json()
    assert explicit_body["name"] == "自定义名称"
    assert explicit_body["price"] == 1388.88
    assert explicit_body["benchmark_price"] == 3950.0
    assert explicit_body["snapshot"]["close"] == 1400.0
    assert explicit_body["snapshot"]["benchmark_price"] == 3950.0
    assert (
        await db_client.delete(f"/api/journal/{explicit_body['id']}", headers=headers_b)
    ).status_code == 204

    snap_now_a = _make_snapshot(
        code="600519",
        name="贵州茅台",
        as_of=date(2026, 11, 20),
        close=1680.0,
        pe_ttm=26.5,
        pe_percentile_10y=60.0,
        ct_red_count=1,
        total_score=76,
    )
    snap_now_b = _make_snapshot(
        code="000858",
        name="五粮液",
        as_of=date(2026, 11, 20),
        close=120.0,
        pe_ttm=14.0,
        pe_percentile_10y=15.0,
        ct_red_count=0,
        total_score=80,
    )
    await _seed_market_and_snapshots(
        as_of=date(2026, 11, 20),
        csi300_close=4400.0,
        snapshots=[snap_now_a, snap_now_b],
    )

    ledger_resp = await db_client.get("/api/journal/ledger", headers=headers_a)
    assert ledger_resp.status_code == 200
    ledger = ledger_resp.json()
    assert ledger["total_entries"] == 2
    assert ledger["comparable_count"] == 2
    assert ledger["win_count"] == 2
    assert ledger["win_rate_pct"] == 100.0
    assert ledger["pass_count"] == 1
    assert ledger["pass_avoided_loss_count"] == 1
    assert ledger["current_benchmark_code"] == "000300"
    assert ledger["current_benchmark_price"] == 4400.0
    assert ledger["benchmark_as_of"] == "2026-11-20"

    by_code = {item["code"]: item for item in ledger["items"]}
    assert by_code["600519"]["stock_return_pct"] == 20.0
    assert by_code["600519"]["benchmark_return_pct"] == 10.0
    assert by_code["600519"]["excess_return_pct"] == 10.0
    assert by_code["600519"]["entry_pe_ttm"] == 20.0
    assert by_code["600519"]["current_pe_ttm"] == 26.5
    assert by_code["600519"]["entry_score"] == 84
    assert by_code["600519"]["current_score"] == 76
    assert by_code["600519"]["falsify_triggered"] is True
    assert len(by_code["600519"]["falsify_triggers"]) == 2

    assert by_code["000858"]["stock_return_pct"] == -20.0
    assert by_code["000858"]["excess_return_pct"] == -30.0
    assert by_code["000858"]["falsify_triggered"] is False

    ledger_b = await db_client.get("/api/journal/ledger", headers=headers_b)
    assert ledger_b.status_code == 200
    assert ledger_b.json()["total_entries"] == 0
    assert ledger_b.json()["items"] == []

    assert (await db_client.get("/api/journal/ledger")).status_code == 401


async def test_legacy_partial_journal_snapshot_deserializes_cleanly(
    db_client: AsyncClient,
) -> None:
    headers = await _auth_headers(db_client, "legacy-snap@example.com", "Legacy")
    me_resp = await db_client.get("/api/auth/me", headers=headers)
    user_id = UUID(me_resp.json()["id"])

    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(
                lambda sync_conn: sync_conn.execute(
                    JournalEntry.__table__.insert().values(
                        user_id=user_id,
                        code="600519",
                        action="buy",
                        reason="历史测试",
                        falsify_condition="无",
                        snapshot={"close": 1234.5},
                    )
                )
            )
        session_maker = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with session_maker() as session:
            items = await PostgresJournalRepository(session).list(user_id)
            assert len(items) == 1
            assert items[0].snapshot is not None
            assert items[0].snapshot.close == 1234.5
            assert items[0].snapshot.pe_ttm is None
            assert items[0].snapshot.benchmark_code == "000300"
    finally:
        await engine.dispose()


async def test_alert_preferences_ssrf_and_masking(db_client: AsyncClient) -> None:
    assert (await db_client.get("/api/alerts/preferences")).status_code == 401
    assert (await db_client.get("/api/alerts")).status_code == 401
    assert (await db_client.post("/api/alerts/scan")).status_code == 401

    headers = await _auth_headers(db_client, "prefs@example.com", "Prefs")
    default_resp = await db_client.get("/api/alerts/preferences", headers=headers)
    assert default_resp.status_code == 200
    assert default_resp.json() == {
        "in_app_enabled": True,
        "webhook_enabled": False,
        "channel_type": "feishu",
        "webhook_url_configured": False,
        "webhook_url_masked": None,
    }

    bad_enable = await db_client.put(
        "/api/alerts/preferences",
        headers=headers,
        json={"in_app_enabled": True, "webhook_enabled": True, "channel_type": "feishu"},
    )
    assert bad_enable.status_code == 422

    bad_clear_while_enabled = await db_client.put(
        "/api/alerts/preferences",
        headers=headers,
        json={
            "in_app_enabled": True,
            "webhook_enabled": True,
            "channel_type": "feishu",
            "webhook_url": "",
        },
    )
    assert bad_clear_while_enabled.status_code == 422

    for ssrf_url in (
        "http://127.0.0.1/hook",
        "http://169.254.169.254/latest/meta-data/",
        "https://10.0.0.1/hook",
        "https://localhost/hook",
        "https://foo.localhost\u3002/hook",
        "https://sub\uff0elocalhost/hook",
        "https://xn--aaaa.example.com/hook",
        "ftp://open.feishu.cn/hook",
    ):
        resp = await db_client.put(
            "/api/alerts/preferences",
            headers=headers,
            json={
                "in_app_enabled": True,
                "webhook_enabled": True,
                "channel_type": "feishu",
                "webhook_url": ssrf_url,
            },
        )
        assert resp.status_code == 422

    saved_resp = await db_client.put(
        "/api/alerts/preferences",
        headers=headers,
        json={
            "in_app_enabled": True,
            "webhook_enabled": True,
            "channel_type": "feishu",
            "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token-1234",
        },
    )
    assert saved_resp.status_code == 200
    saved_body = saved_resp.json()
    assert saved_body["webhook_enabled"] is True
    assert saved_body["webhook_url_configured"] is True
    assert saved_body["webhook_url_masked"] == "https://open.feishu.cn/****1234"
    assert "secret-token" not in json.dumps(saved_body)

    keep_url_resp = await db_client.put(
        "/api/alerts/preferences",
        headers=headers,
        json={
            "in_app_enabled": False,
            "webhook_enabled": True,
            "channel_type": "wecom",
            "webhook_url": None,
        },
    )
    assert keep_url_resp.status_code == 200
    assert keep_url_resp.json()["webhook_url_configured"] is True
    assert keep_url_resp.json()["channel_type"] == "wecom"
    assert keep_url_resp.json()["webhook_url_masked"] == "https://open.feishu.cn/****1234"

    clear_resp = await db_client.put(
        "/api/alerts/preferences",
        headers=headers,
        json={
            "in_app_enabled": True,
            "webhook_enabled": False,
            "channel_type": "feishu",
            "webhook_url": "",
        },
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["webhook_url_configured"] is False
    assert clear_resp.json()["webhook_url_masked"] is None


async def test_alert_scan_idempotency_webhook_and_tenant_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port)))
        ],
    )

    sent_payloads: list[dict[str, Any]] = []
    webhook_should_fail = False

    def handler(request: httpx.Request) -> httpx.Response:
        sent_payloads.append(json.loads(request.content.decode("utf-8")))
        if webhook_should_fail:
            return httpx.Response(500, json={"error": "upstream failed"})
        return httpx.Response(200, json={"code": 0})

    notifier = HttpxWebhookNotifier(transport=httpx.MockTransport(handler))

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

        async def _noop_warmup(_code: str) -> None:
            return None

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_watchlist_warmup] = lambda: _noop_warmup
        app.dependency_overrides[get_webhook_notifier] = lambda: notifier

        snap_wl = _make_snapshot(
            code="600519",
            name="贵州茅台",
            as_of=date(2026, 11, 20),
            close=1400.0,
            pe_percentile_10y=18.0,
            dividend_yield_pct=4.2,
            ct_red_count=0,
        )
        snap_hold = _make_snapshot(
            code="000333",
            name="美的集团",
            as_of=date(2026, 11, 20),
            close=68.0,
            ct_red_count=1,
            roe_series=[(2024, 12.0), (2025, 11.0)],
        )
        await _seed_market_and_snapshots(
            as_of=date(2026, 11, 20),
            csi300_close=4050.0,
            snapshots=[snap_wl, snap_hold],
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers_a = await _auth_headers(client, "scan-a@example.com", "Scan A")
            headers_b = await _auth_headers(client, "scan-b@example.com", "Scan B")

            assert (
                await client.put(
                    "/api/alerts/preferences",
                    headers=headers_a,
                    json={
                        "in_app_enabled": True,
                        "webhook_enabled": True,
                        "channel_type": "feishu",
                        "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/abc1234",
                    },
                )
            ).status_code == 200

            assert (
                await client.put(
                    "/api/watchlist",
                    headers=headers_a,
                    json={
                        "code": "600519",
                        "name": "贵州茅台",
                        "target_price": 1450.0,
                        "target_pe_percentile": 20.0,
                        "alert_enabled": True,
                    },
                )
            ).status_code == 200

            assert (
                await client.post(
                    "/api/journal",
                    headers=headers_a,
                    json={
                        "code": "000333",
                        "action": "buy",
                        "reason": "家电龙头",
                        "falsify_condition": "ROE 连续 2 年低于 15%",
                        "falsify_rules": [
                            {"metric": "roe", "op": "lt", "value": 15.0, "periods": 2}
                        ],
                    },
                )
            ).status_code == 201

            first_scan = await client.post("/api/alerts/scan", headers=headers_a)
            assert first_scan.status_code == 200
            summary1 = first_scan.json()
            assert summary1["as_of"] == "2026-11-20"
            assert summary1["matched_count"] == 2
            assert summary1["newly_triggered_count"] == 2
            assert summary1["webhook_sent_count"] == 2
            assert summary1["webhook_failed_count"] == 0
            assert len(summary1["deliveries"]) == 2
            assert all(d["status"] == "sent" for d in summary1["deliveries"])
            assert all(d["channel"] == "feishu" for d in summary1["deliveries"])
            assert len(sent_payloads) == 1
            assert sent_payloads[0]["msg_type"] == "text"

            second_scan = await client.post("/api/alerts/scan", headers=headers_a)
            assert second_scan.status_code == 200
            summary2 = second_scan.json()
            assert summary2["matched_count"] == 2
            assert summary2["newly_triggered_count"] == 0
            assert summary2["deliveries"] == []
            assert len(sent_payloads) == 1

            events_a = (await client.get("/api/events", headers=headers_a)).json()
            alert_events = [e for e in events_a if e["type"] == "alert_triggered"]
            assert len(alert_events) == 2

            alerts_a = (await client.get("/api/alerts", headers=headers_a)).json()
            assert len(alerts_a) == 2
            assert (await client.get("/api/alerts", headers=headers_b)).json() == []

            webhook_should_fail = True
            assert (
                await client.put(
                    "/api/alerts/preferences",
                    headers=headers_b,
                    json={
                        "in_app_enabled": True,
                        "webhook_enabled": True,
                        "channel_type": "wecom",
                        "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fail9999",
                    },
                )
            ).status_code == 200
            assert (
                await client.put(
                    "/api/watchlist",
                    headers=headers_b,
                    json={
                        "code": "600519",
                        "name": "贵州茅台",
                        "target_price": 1450.0,
                        "alert_enabled": True,
                    },
                )
            ).status_code == 200

            fail_scan = await client.post("/api/alerts/scan", headers=headers_b)
            assert fail_scan.status_code == 200
            fail_body = fail_scan.json()
            assert fail_body["newly_triggered_count"] == 1
            assert fail_body["webhook_sent_count"] == 0
            assert fail_body["webhook_failed_count"] == 1
            assert fail_body["deliveries"][0]["status"] == "webhook_failed"
            assert fail_body["deliveries"][0]["channel"] == "wecom"
            assert sent_payloads[-1]["msgtype"] == "text"
            assert "ValueSingularity" in sent_payloads[-1]["text"]["content"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_webhook_notifier_blocks_dns_rebinding(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200)

    notifier = HttpxWebhookNotifier(transport=httpx.MockTransport(handler))
    config = StoredNotificationConfig(
        in_app_enabled=True,
        webhook_enabled=True,
        channel_type="custom",
        webhook_url="https://rebind.example.com/webhook/secret",
    )
    candidate = TriggeredAlertCandidate(
        user_id=UUID("00000000-0000-0000-0000-000000000001"),
        source_type="watchlist_sentinel",
        code="600519",
        stock_name="贵州茅台",
        trigger_date=date(2026, 11, 20),
        rule_signature="wl:1234567890ab",
        matched_conditions=["现价 1400 <= 目标价 1450"],
        detail="贵州茅台(600519) 命中自选击球区",
        current_price=1400.0,
    )

    for private_ip in ("127.0.0.1", "169.254.169.254", "::1", "10.0.0.8"):
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda _h, port, *_a, ip=private_ip, **_kw: [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, int(port)))
            ],
        )
        ok = await notifier.send_alerts(config, [candidate])
        assert ok is False
    assert calls == 0


async def test_concurrent_alert_scans_claim_dedup_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port)))
        ],
    )
    webhook_calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal webhook_calls
        webhook_calls += 1
        return httpx.Response(200)

    notifier = HttpxWebhookNotifier(transport=httpx.MockTransport(handler))
    concurrency = 4
    engine = create_async_engine(settings.test_database_url, pool_size=concurrency + 2)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        async def _noop_warmup(_code: str) -> None:
            return None

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_watchlist_warmup] = lambda: _noop_warmup
        app.dependency_overrides[get_webhook_notifier] = lambda: notifier

        snap = _make_snapshot(code="600519", close=1400.0, as_of=date(2026, 11, 20))
        await _seed_market_and_snapshots(
            as_of=date(2026, 11, 20),
            csi300_close=4000.0,
            snapshots=[snap],
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await _auth_headers(client, "concurrent-scan@example.com", "Concurrent")
            await client.put(
                "/api/alerts/preferences",
                headers=headers,
                json={
                    "in_app_enabled": True,
                    "webhook_enabled": True,
                    "channel_type": "custom",
                    "webhook_url": "https://hooks.example.com/custom-1234",
                },
            )
            await client.put(
                "/api/watchlist",
                headers=headers,
                json={
                    "code": "600519",
                    "name": "贵州茅台",
                    "target_price": 1500.0,
                    "alert_enabled": True,
                },
            )

        async def run_scan() -> dict[str, Any]:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as req_client:
                resp = await req_client.post("/api/alerts/scan", headers=headers)
                assert resp.status_code == 200
                return dict(resp.json())

        results = await asyncio.gather(*(run_scan() for _ in range(concurrency)))
        assert sum(r["newly_triggered_count"] for r in results) == 1
        assert webhook_calls == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_scan_alerts_cli_argument_validation() -> None:
    assert scan_alerts.main(["--user-id", "not-a-uuid"]) == 2


async def test_scan_alerts_cli_and_sync_stocks_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

        async def _noop_warmup(_code: str) -> None:
            return None

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_watchlist_warmup] = lambda: _noop_warmup

        snap = _make_snapshot(code="600519", close=1400.0, as_of=date(2026, 11, 20))
        await _seed_market_and_snapshots(
            as_of=date(2026, 11, 20),
            csi300_close=4000.0,
            snapshots=[snap],
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await _auth_headers(client, "cli-scan@example.com", "CLI")
            me = (await client.get("/api/auth/me", headers=headers)).json()
            user_id = UUID(me["id"])
            await client.put(
                "/api/watchlist",
                headers=headers,
                json={
                    "code": "600519",
                    "name": "贵州茅台",
                    "target_price": 1500.0,
                    "alert_enabled": True,
                },
            )

        async with testing_session() as session:
            summary = await scan_alerts.run_alert_scan(session)
            assert summary.users_scanned == 1
            assert summary.newly_triggered_count == 1

            row_count = await session.scalar(
                text("SELECT count(*) FROM alert_deliveries WHERE user_id = :uid"),
                {"uid": user_id},
            )
            assert row_count == 1

        async def fake_sync_many(
            _self: object,
            codes: object,
            **_kwargs: object,
        ) -> list[StockSyncSummary]:
            return [
                StockSyncSummary(
                    code=code,
                    as_of=date(2026, 11, 20),
                    data_source="stub",
                    daily_bars_count=2,
                    annual_reports_count=5,
                    ct_red_count=0,
                    ct_yellow_count=0,
                    implied_fcf_cagr_pct=5.0,
                )
                for code in list(codes)  # type: ignore[arg-type]
            ]

        async def noop_dispose() -> None:
            return None

        monkeypatch.setattr(sync_stocks, "AsyncSessionLocal", testing_session)
        monkeypatch.setattr(sync_stocks, "dispose_db", noop_dispose)
        monkeypatch.setattr(sync_stocks.StockSyncService, "sync_many", fake_sync_many)

        target_codes, sync_summaries, alert_summary = await sync_stocks._run_sync(
            codes=["600519"],
            use_watchlist=False,
            limit=1,
            as_of=date(2026, 11, 20),
            scan_alerts=True,
        )
        assert target_codes == ["600519"]
        assert len(sync_summaries) == 1
        assert alert_summary is not None
        assert alert_summary.users_scanned == 1
        assert alert_summary.matched_count == 1
        assert alert_summary.newly_triggered_count == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_webhook_notifier_pins_ip_ignores_proxies_and_silences_secret_logs(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9999")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:9999")

    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING

    captured_requests: list[httpx.Request] = []
    client_flags: list[tuple[bool, bool]] = []
    orig_async_client = httpx.AsyncClient

    class SpyAsyncClient(orig_async_client):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            client_flags.append(
                (bool(kwargs.get("trust_env")), bool(kwargs.get("follow_redirects")))
            )

    async def fake_handle_async_request(
        _self: httpx.AsyncHTTPTransport, request: httpx.Request
    ) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, request=request, json={"ok": True})

    monkeypatch.setattr(httpx, "AsyncClient", SpyAsyncClient)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_handle_async_request)

    notifier = HttpxWebhookNotifier()
    candidate = TriggeredAlertCandidate(
        user_id=UUID("00000000-0000-0000-0000-000000000002"),
        source_type="watchlist_sentinel",
        code="600519",
        stock_name="贵州茅台",
        trigger_date=date(2026, 11, 20),
        rule_signature="wl:pinned123456",
        matched_conditions=["现价 1400 <= 目标价 1450"],
        detail="贵州茅台(600519) 命中自选击球区",
        current_price=1400.0,
    )

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port)))
        ],
    )
    with caplog.at_level(logging.INFO):
        ok_v4 = await notifier.send_alerts(
            StoredNotificationConfig(
                in_app_enabled=True,
                webhook_enabled=True,
                channel_type="custom",
                webhook_url="https://open.feishu.cn/open-apis/bot/v2/hook/top-secret-token?k=super-secret",
            ),
            [candidate],
        )

    assert ok_v4 is True
    assert client_flags[-1] == (False, False)
    assert len(captured_requests) == 1
    req_v4 = captured_requests[0]
    assert req_v4.url.host == "93.184.216.34"
    assert req_v4.url.query == b"k=super-secret"
    assert req_v4.headers["Host"] == "open.feishu.cn"
    assert req_v4.extensions.get("sni_hostname") == "open.feishu.cn"
    assert "top-secret-token" not in caplog.text
    assert "super-secret" not in caplog.text

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:4860:4860::8888", int(port), 0, 0))
        ],
    )
    ok_v6 = await notifier.send_alerts(
        StoredNotificationConfig(
            in_app_enabled=True,
            webhook_enabled=True,
            channel_type="custom",
            webhook_url="https://open.feishu.cn:8443/hook/secret",
        ),
        [candidate],
    )
    assert ok_v6 is True
    req_v6 = captured_requests[-1]
    assert str(req_v6.url).startswith("https://[2001:4860:4860::8888]:8443/hook/secret")
    assert req_v6.headers["Host"] == "open.feishu.cn:8443"
    assert req_v6.extensions.get("sni_hostname") == "open.feishu.cn"

    # Mixed public + private DNS records must fail closed without sending.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port))),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", int(port))),
        ],
    )
    assert (
        await notifier.send_alerts(
            StoredNotificationConfig(
                in_app_enabled=True,
                webhook_enabled=True,
                channel_type="custom",
                webhook_url="https://open.feishu.cn/hook/secret",
            ),
            [candidate],
        )
        is False
    )
    assert len(captured_requests) == 2

    async def raise_invalid_url(
        _self: httpx.AsyncHTTPTransport, _request: httpx.Request
    ) -> httpx.Response:
        raise httpx.InvalidURL("bad target")

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port)))
        ],
    )
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", raise_invalid_url)
    assert (
        await notifier.send_alerts(
            StoredNotificationConfig(
                in_app_enabled=True,
                webhook_enabled=True,
                channel_type="custom",
                webhook_url="https://open.feishu.cn/hook/secret",
            ),
            [candidate],
        )
        is False
    )


async def test_alert_scan_service_gates_crash_recovery_over_200_holdings_and_tenant_isolation() -> (
    None
):
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

        async def _noop_warmup(_code: str) -> None:
            return None

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_watchlist_warmup] = lambda: _noop_warmup

        snap_600519 = _make_snapshot(
            code="600519",
            name="贵州茅台",
            as_of=date(2026, 11, 20),
            close=1400.0,
            pe_ttm=28.0,
        )
        snap_000858 = _make_snapshot(
            code="000858",
            name="五粮液",
            as_of=date(2026, 11, 20),
            close=110.0,
            pe_ttm=14.0,
        )
        await _seed_market_and_snapshots(
            as_of=date(2026, 11, 20),
            csi300_close=4050.0,
            snapshots=[snap_600519, snap_000858],
        )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers_a = await _auth_headers(client, "rel-a@example.com", "Rel A")
            headers_b = await _auth_headers(client, "rel-b@example.com", "Rel B")
            headers_c = await _auth_headers(client, "rel-c@example.com", "Rel C")
            user_a = UUID((await client.get("/api/auth/me", headers=headers_a)).json()["id"])
            user_b = UUID((await client.get("/api/auth/me", headers=headers_b)).json()["id"])
            user_c = UUID((await client.get("/api/auth/me", headers=headers_c)).json()["id"])

            await client.put(
                "/api/watchlist",
                headers=headers_a,
                json={
                    "code": "600519",
                    "name": "贵州茅台",
                    "target_price": 1500.0,
                    "alert_enabled": True,
                },
            )
            await client.put(
                "/api/watchlist",
                headers=headers_b,
                json={
                    "code": "600519",
                    "name": "贵州茅台",
                    "target_price": 1500.0,
                    "alert_enabled": True,
                },
            )

        # 1. Config gate: in_app_enabled=False and missing webhook_url skips persistence cleanly.
        async with testing_session() as session:
            settings_repo = PostgresSettingsRepository(session)
            await settings_repo.save_notification_config(
                user_a,
                StoredNotificationConfig(
                    in_app_enabled=False,
                    webhook_enabled=True,
                    channel_type="feishu",
                    webhook_url=None,
                ),
            )
            svc_a = AlertScanService(
                watchlist_repo=PostgresWatchlistRepository(session),
                journal_repo=PostgresJournalRepository(session),
                snapshot_repo=PostgresStockSnapshotRepository(session),
                settings_repo=settings_repo,
                alert_repo=PostgresAlertRepository(session),
            )
            skipped_summary = await svc_a.scan_user(user_a)
            assert skipped_summary.matched_count == 1
            assert skipped_summary.newly_triggered_count == 0
            assert skipped_summary.deliveries == []
            row_count_a = await session.scalar(
                text("SELECT count(*) FROM alert_deliveries WHERE user_id = :uid"),
                {"uid": user_a},
            )
            assert row_count_a == 0

        # 2. Notifier crash marks rows webhook_failed instead of leaving them pending.
        class CrashingNotifier:
            async def send_alerts(
                self,
                _config: StoredNotificationConfig,
                _stock_alerts: list[TriggeredAlertCandidate] | Any,
            ) -> bool:
                raise RuntimeError("unexpected transport crash")

        async with testing_session() as session:
            settings_repo = PostgresSettingsRepository(session)
            await settings_repo.save_notification_config(
                user_a,
                StoredNotificationConfig(
                    in_app_enabled=True,
                    webhook_enabled=True,
                    channel_type="feishu",
                    webhook_url="https://open.feishu.cn/open-apis/bot/v2/hook/crash-1234",
                ),
            )
            svc_crash = AlertScanService(
                watchlist_repo=PostgresWatchlistRepository(session),
                journal_repo=PostgresJournalRepository(session),
                snapshot_repo=PostgresStockSnapshotRepository(session),
                settings_repo=settings_repo,
                alert_repo=PostgresAlertRepository(session),
                webhook_notifier=CrashingNotifier(),
            )
            crash_summary = await svc_crash.scan_user(user_a)
            assert crash_summary.newly_triggered_count == 1
            assert crash_summary.webhook_failed_count == 1
            assert crash_summary.deliveries[0].status == "webhook_failed"
            db_status = await session.scalar(
                text("SELECT status FROM alert_deliveries WHERE user_id = :uid"),
                {"uid": user_a},
            )
            assert db_status == "webhook_failed"

        # 3. CancelledError must propagate cleanly and not be swallowed.
        class CancellingNotifier:
            async def send_alerts(
                self,
                _config: StoredNotificationConfig,
                _stock_alerts: Any,
            ) -> bool:
                raise asyncio.CancelledError

        async with testing_session() as session:
            await session.execute(
                text("DELETE FROM alert_deliveries WHERE user_id = :uid"), {"uid": user_a}
            )
            await session.commit()
            svc_cancel = AlertScanService(
                watchlist_repo=PostgresWatchlistRepository(session),
                journal_repo=PostgresJournalRepository(session),
                snapshot_repo=PostgresStockSnapshotRepository(session),
                settings_repo=PostgresSettingsRepository(session),
                alert_repo=PostgresAlertRepository(session),
                webhook_notifier=CancellingNotifier(),
            )
            with pytest.raises(asyncio.CancelledError):
                await svc_cancel.scan_user(user_a)

        # 4. scan_all_users isolates per-user failures so healthy tenants still get scanned.
        async with testing_session() as session:
            await session.execute(
                text("DELETE FROM alert_deliveries WHERE user_id = :uid"), {"uid": user_a}
            )
            await session.commit()
            real_watchlist = PostgresWatchlistRepository(session)

            class FaultyWatchlistRepo:
                async def list(self, user_id: UUID) -> Any:
                    if user_id == user_a:
                        raise RuntimeError("tenant A corrupt state")
                    return await real_watchlist.list(user_id)

            svc_isolated = AlertScanService(
                watchlist_repo=FaultyWatchlistRepo(),  # type: ignore[arg-type]
                journal_repo=PostgresJournalRepository(session),
                snapshot_repo=PostgresStockSnapshotRepository(session),
                settings_repo=PostgresSettingsRepository(session),
                alert_repo=PostgresAlertRepository(session),
            )
            isolated_summary = await svc_isolated.scan_all_users()
            assert isolated_summary.users_scanned == 1
            assert isolated_summary.newly_triggered_count == 1
            assert isolated_summary.deliveries[0].code == "600519"
            b_count = await session.scalar(
                text("SELECT count(*) FROM alert_deliveries WHERE user_id = :uid"),
                {"uid": user_b},
            )
            assert b_count == 1

        # 5. >200 journal entries still evaluates active holdings older than the 200-row UI cap.
        async with testing_session() as session:
            base_time = datetime(2026, 1, 1, tzinfo=UTC)
            rows_to_insert: list[dict[str, Any]] = [
                {
                    "user_id": user_c,
                    "code": "600519",
                    "name": "贵州茅台",
                    "action": "buy",
                    "reason": "早期买入持仓",
                    "falsify_condition": "PE > 25",
                    "falsify_rules": [
                        {"metric": "pe_ttm", "op": "gt", "value": 25.0, "periods": 1}
                    ],
                    "created_at": base_time,
                }
            ]
            for idx in range(210):
                rows_to_insert.append(
                    {
                        "user_id": user_c,
                        "code": "000858",
                        "name": "五粮液",
                        "action": "pass",
                        "reason": f"观察记录-{idx}",
                        "falsify_condition": "观察条件",
                        "falsify_rules": None,
                        "created_at": base_time + timedelta(minutes=idx + 1),
                    }
                )
            await session.execute(JournalEntry.__table__.insert(), rows_to_insert)
            await session.commit()

            svc_c = AlertScanService(
                watchlist_repo=PostgresWatchlistRepository(session),
                journal_repo=PostgresJournalRepository(session),
                snapshot_repo=PostgresStockSnapshotRepository(session),
                settings_repo=PostgresSettingsRepository(session),
                alert_repo=PostgresAlertRepository(session),
            )
            over200_summary = await svc_c.scan_user(user_c)
            assert over200_summary.newly_triggered_count == 1
            assert over200_summary.deliveries[0].source_type == "journal_falsify"
            assert over200_summary.deliveries[0].code == "600519"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_journal_time_capsule_records_benchmark_as_of_separately(
    db_client: AsyncClient,
) -> None:
    snap_stock = _make_snapshot(
        code="600519",
        name="贵州茅台",
        as_of=date(2026, 10, 1),
        close=1400.0,
    )
    await _seed_market_and_snapshots(
        as_of=date(2026, 10, 2),
        csi300_close=4010.0,
        snapshots=[snap_stock],
    )
    headers = await _auth_headers(db_client, "capsule-date@example.com", "Capsule Date")

    auto_resp = await db_client.post(
        "/api/journal",
        headers=headers,
        json={
            "code": "600519",
            "action": "buy",
            "reason": "自动填充基准点位测试",
            "falsify_condition": "基本面恶化",
        },
    )
    assert auto_resp.status_code == 201
    auto_capsule = auto_resp.json()["snapshot"]
    assert auto_capsule["as_of"] == "2026-10-01"
    assert auto_capsule["benchmark_price"] == 4010.0
    assert auto_capsule["benchmark_as_of"] == "2026-10-02"

    manual_resp = await db_client.post(
        "/api/journal",
        headers=headers,
        json={
            "code": "600519",
            "action": "add",
            "reason": "手工基准点位测试",
            "falsify_condition": "基本面恶化",
            "benchmark_price": 3950.0,
        },
    )
    assert manual_resp.status_code == 201
    manual_capsule = manual_resp.json()["snapshot"]
    assert manual_capsule["benchmark_price"] == 3950.0
    assert manual_capsule["benchmark_as_of"] is None
