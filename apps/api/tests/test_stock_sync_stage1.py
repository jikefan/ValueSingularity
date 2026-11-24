"""Stage 1 tests: columnar Parquet slice upsert, single-flight sync, warmup, and priority CLI."""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.akshare.market_feed import fetch_priority_index_codes
from app.adapters.duckdb import parquet_io
from app.adapters.duckdb.stock_store import DuckDBStockFactStore
from app.adapters.postgres.market import PostgresMarketRepository, PostgresStockMetaRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.api import deps
from app.api.deps import (
    get_db,
    get_stock_snapshot_coordinator,
    get_watchlist_warmup,
)
from app.cli import sync_stocks
from app.db.base import Base
from app.db.models import StockSnapshot, User, WatchlistItem
from app.db.session import DatabaseUnavailableError
from app.domain.errors import StockFactUnavailableError, StockNotFoundError
from app.domain.market_math import build_market_overview
from app.domain.models import (
    IndexDailyRow,
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockSnapshotPayload,
    TradeCalendarEntry,
)
from app.main import create_app
from app.services.stock_sync import StockSnapshotCoordinator
from app.settings import settings
from tests.test_stock_snapshot import _sample_bundle


def _sample_market_overview(as_of: date = date(2026, 11, 20)) -> Any:
    bundle = MarketFeedBundle(
        as_of=as_of,
        data_source="akshare",
        indices=[IndexQuote(code="000001", name="上证指数", price=3300.0, change_pct=0.5)],
        hot_industries=[
            IndustryFlow(name="食品饮料", change_pct=1.2, net_inflow=5e8, companies=40)
        ],
        stock_list=[],
        trade_calendar=[TradeCalendarEntry(trade_date=as_of, is_open=True)],
        index_daily=[IndexDailyRow(code="000001", trade_date=as_of, close=3300.0, change_pct=0.5)],
        macro_rates=[
            MacroRateRow(
                trade_date=as_of,
                cn_10y_bond_yield=1.8,
                market_pe_median=22.0,
            )
        ],
    )
    return build_market_overview(
        bundle,
        bundle.macro_rates,
        generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
    )


async def test_columnar_slice_upsert_and_batch_write_with_legacy_div_rep(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Seed legacy dividends_repurchase/all.parquet missing secondary_date for 600519 and 000333.
    legacy_path = tmp_path / "fundamentals" / "dividends_repurchase" / "all.parquet"
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_schema = pa.schema(
        [
            ("record_type", pa.string()),
            ("code", pa.string()),
            ("primary_date", pa.date32()),
            ("notice_date", pa.date32()),
            ("year", pa.int32()),
            ("progress", pa.string()),
            ("cash_per_10_shares", pa.float64()),
            ("total_shares", pa.float64()),
            ("amount_yuan", pa.float64()),
            ("repurchased_shares", pa.float64()),
            ("dividend_yield_pct", pa.float64()),
        ]
    )
    legacy_table = pa.Table.from_pylist(
        [
            {
                "record_type": "repurchase",
                "code": "600519",
                "primary_date": date(2025, 3, 1),
                "notice_date": date(2025, 10, 15),
                "year": 2025,
                "progress": "完成实施",
                "cash_per_10_shares": None,
                "total_shares": None,
                "amount_yuan": 30e8,
                "repurchased_shares": 2_000_000.0,
                "dividend_yield_pct": None,
            },
            {
                "record_type": "dividend",
                "code": "000333",
                "primary_date": date(2024, 12, 31),
                "notice_date": date(2025, 5, 10),
                "year": 2024,
                "progress": "实施分配",
                "cash_per_10_shares": 15.0,
                "total_shares": 70e8,
                "amount_yuan": 105e8,
                "repurchased_shares": None,
                "dividend_yield_pct": 3.0,
            },
        ],
        schema=legacy_schema,
    )
    pq.write_table(legacy_table, legacy_path)

    write_counts: Counter[Path] = Counter()
    real_atomic_write = parquet_io.atomic_write_parquet

    def counting_atomic_write(target: Path, table: pa.Table) -> None:
        write_counts[target] += 1
        real_atomic_write(target, table)

    monkeypatch.setattr(parquet_io, "atomic_write_parquet", counting_atomic_write)

    store = DuckDBStockFactStore(tmp_path)
    await store.write_stocks_facts_batch([])
    assert write_counts == Counter()

    bundle_000333 = _sample_bundle("000333", date(2026, 11, 20))
    bundle_600036_old = _sample_bundle("600036", date(2026, 11, 13)).model_copy(
        update={
            "pledge": StockPledgeSnapshot(
                code="600036", trade_date=date(2026, 11, 13), pledge_ratio_pct=1.1
            ),
            "equity_financings": [
                StockEquityFinancingRecord(
                    code="600036",
                    year=2024,
                    event_date=date(2024, 6, 1),
                    source="add_stock",
                    financing_type="定增",
                    amount_yuan=5e8,
                )
            ],
        }
    )
    bundle_600036_new = _sample_bundle("600036", date(2026, 11, 20)).model_copy(
        update={
            "pledge": StockPledgeSnapshot(
                code="600036", trade_date=date(2026, 11, 20), pledge_ratio_pct=0.7
            ),
            "equity_financings": [],
        }
    )

    await store.write_stocks_facts_batch([bundle_000333, bundle_600036_old, bundle_600036_new])

    # Each shared partition was rewritten exactly once across the 3-bundle batch.
    assert write_counts[tmp_path / "bars/daily/year=2026/data.parquet"] == 1
    assert write_counts[tmp_path / "fundamentals/annual/report_year=2025/data.parquet"] == 1
    assert write_counts[legacy_path] == 1
    assert write_counts[tmp_path / "fundamentals/pledge_financing/all.parquet"] == 1

    # Unrelated legacy 600519 row stayed intact in Arrow and still loads with fallback event_date.
    loaded_600519 = await store.load_stock_facts("600519")
    assert loaded_600519 is not None
    assert len(loaded_600519.repurchases) == 1
    assert loaded_600519.repurchases[0].event_date == date(2025, 10, 15)

    # 000333 old 2024 dividend from legacy file was pruned and replaced by bundle_000333.
    loaded_000333 = await store.load_stock_facts("000333")
    assert loaded_000333 is not None
    assert [d.report_year for d in loaded_000333.dividends] == [2025]
    assert len(loaded_000333.repurchases) == 1

    # 600036 keeps both historical pledge dates while newer empty equity_financings replaces older.
    loaded_600036 = await store.load_stock_facts("600036")
    assert loaded_600036 is not None
    assert loaded_600036.equity_financings == []
    assert loaded_600036.pledge is not None
    assert loaded_600036.pledge.trade_date == date(2026, 11, 20)
    loaded_600036_hist = await store.load_stock_facts("600036", as_of=date(2026, 11, 13))
    assert loaded_600036_hist is not None and loaded_600036_hist.pledge is not None
    assert loaded_600036_hist.pledge.trade_date == date(2026, 11, 13)


async def test_stock_snapshot_coordinator_single_flight_shield_and_cleanup() -> None:
    meta_600519 = StockMetaRecord(code="600519", name="贵州茅台", exchange="SH")
    snap_600519 = StockSnapshotPayload.model_validate(
        {
            **{
                "code": "600519",
                "name": "贵州茅台",
                "exchange": "SH",
                "as_of": date(2026, 11, 20),
                "generated_at": datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
            },
            **_make_minimal_snapshot_fields(meta_600519),
        }
    )

    calls: list[tuple[str, bool]] = []
    active = 0
    max_active = 0
    gate = asyncio.Event()

    class _StubRunner:
        def __init__(self) -> None:
            self.should_fail = False

        async def load_or_sync_snapshot(
            self, code: str, *, force: bool = False
        ) -> StockSnapshotPayload:
            nonlocal active, max_active
            calls.append((code, force))
            active += 1
            max_active = max(max_active, active)
            try:
                await gate.wait()
                if self.should_fail:
                    raise StockFactUnavailableError(code, "akshare", "upstream timeout")
                return snap_600519.model_copy(update={"code": code})
            finally:
                active -= 1

    runner = _StubRunner()
    coordinator = StockSnapshotCoordinator(runner, max_concurrency=2)

    async def _release_soon() -> None:
        await asyncio.sleep(0.02)
        gate.set()

    # Two concurrent calls share one task; cancelling one waiter preserves peer waiter.
    t_waiter1 = asyncio.create_task(coordinator.ensure_snapshot("600519", force=False))
    t_waiter2 = asyncio.create_task(coordinator.ensure_snapshot("600519", force=False))
    await asyncio.sleep(0.005)
    t_waiter1.cancel()
    gate.set()

    res1, res2 = await asyncio.gather(t_waiter1, t_waiter2, return_exceptions=True)
    assert isinstance(res1, asyncio.CancelledError)
    assert isinstance(res2, StockSnapshotPayload) and res2.code == "600519"
    assert calls == [("600519", False)]
    assert coordinator._inflight == {}

    # All waiters cancel while failing task is in-flight: no unretrieved exception, _inflight clears
    calls.clear()
    gate.clear()
    runner.should_fail = True
    t_fail_waiter = asyncio.create_task(coordinator.ensure_snapshot("000333", force=True))
    await asyncio.sleep(0.005)
    t_fail_waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t_fail_waiter
    gate.set()
    await asyncio.sleep(0.02)
    assert calls == [("000333", True)]
    assert coordinator._inflight == {}

    # Semaphore bounds concurrent execution across distinct keys to max_concurrency=2.
    calls.clear()
    runner.should_fail = False
    gate.clear()
    releaser = asyncio.create_task(_release_soon())
    results = await asyncio.gather(
        coordinator.ensure_snapshot("000001", force=False),
        coordinator.ensure_snapshot("000002", force=False),
        coordinator.ensure_snapshot("000333", force=False),
        coordinator.ensure_snapshot("600036", force=False),
        coordinator.ensure_snapshot("600036", force=True),
    )
    await releaser
    assert len(results) == 5
    assert max_active <= 2
    assert len(calls) == 5
    assert coordinator._inflight == {}


def _make_minimal_snapshot_fields(meta: StockMetaRecord) -> dict[str, Any]:
    from app.domain.engines import build_stock_snapshot

    built = build_stock_snapshot(meta, _sample_bundle(meta.code, date(2026, 11, 20)))
    return built.model_dump(exclude={"code", "name", "exchange", "as_of", "generated_at"})


async def test_sync_route_and_snapshot_route_end_to_end_pg(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    deps.get_stock_snapshot_coordinator.cache_clear()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        async with testing_session() as session:
            meta_repo = PostgresStockMetaRepository(session)
            await meta_repo.upsert_many(
                [
                    StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
                    StockMetaRecord(code="000333", name="美的集团", exchange="SZ"),
                ]
            )

        feed_calls: list[str] = []
        fail_codes: set[str] = {"000333"}
        feed_gate = asyncio.Event()

        class _StubFeed:
            async def fetch_stock_bundle(
                self, code: str, *, as_of: date | None = None
            ) -> StockFactBundle:
                feed_calls.append(code)
                await feed_gate.wait()
                if code in fail_codes:
                    raise StockFactUnavailableError(code, "akshare", "feed unavailable")
                return _sample_bundle(code, date(2026, 11, 20)).model_copy(
                    update={"profile_industry_sw1": "食品饮料"}
                )

        store = DuckDBStockFactStore(tmp_path)
        monkeypatch.setattr(deps, "AsyncSessionLocal", testing_session)
        monkeypatch.setattr(deps, "get_stock_fact_feed", lambda: _StubFeed())
        monkeypatch.setattr(deps, "get_stock_fact_store", lambda: store)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # GET snapshot remains 404 when absent.
            assert (await client.get("/api/stocks/600519/snapshot")).status_code == 404
            assert (await client.post("/api/stocks/abc/sync")).status_code == 422

            # Concurrent POST /sync shares single feed fetch.
            async def _release_feed() -> None:
                await asyncio.sleep(0.02)
                feed_gate.set()

            release_task = asyncio.create_task(_release_feed())
            resp1, resp2 = await asyncio.gather(
                client.post("/api/stocks/600519/sync"),
                client.post("/api/stocks/600519/sync"),
            )
            await release_task
            assert resp1.status_code == 200
            assert resp2.status_code == 200
            assert resp1.json()["code"] == "600519"
            assert resp1.json()["industry_sw1"] == "食品饮料"
            assert feed_calls == ["600519"]

            # GET snapshot now returns 200.
            assert (await client.get("/api/stocks/600519/snapshot")).status_code == 200

            # force=False hits PG cache without invoking feed.
            cached_resp = await client.post("/api/stocks/600519/sync")
            assert cached_resp.status_code == 200
            assert feed_calls == ["600519"]

            # force=True bypasses PG cache and re-fetches.
            forced_resp = await client.post("/api/stocks/600519/sync", params={"force": "true"})
            assert forced_resp.status_code == 200
            assert feed_calls == ["600519", "600519"]

            # Unknown code returns 404 without hitting feed.
            missing_resp = await client.post("/api/stocks/999999/sync")
            assert missing_resp.status_code == 404
            assert feed_calls == ["600519", "600519"]

            # Feed failure returns 503 with Chinese error and preserves absence in GET /snapshot.
            fail_resp = await client.post("/api/stocks/000333/sync")
            assert fail_resp.status_code == 503
            assert "个股数据同步暂不可用" in fail_resp.json()["detail"]
            assert (await client.get("/api/stocks/000333/snapshot")).status_code == 404

        # DatabaseUnavailableError maps to 503.
        class _BrokenRunner:
            async def load_or_sync_snapshot(
                self, code: str, *, force: bool = False
            ) -> StockSnapshotPayload:
                raise DatabaseUnavailableError("OperationalError")

        app.dependency_overrides[get_stock_snapshot_coordinator] = lambda: StockSnapshotCoordinator(
            _BrokenRunner()
        )
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            db_err_resp = await client.post("/api/stocks/600519/sync")
            assert db_err_resp.status_code == 503
            assert "数据库不可用" in db_err_resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()
        deps.get_stock_snapshot_coordinator.cache_clear()
        await engine.dispose()


async def test_missing_snapshot_query_priority_index_fetch_and_cli(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Argument validation on new flags.
    assert sync_stocks.main(["--refresh-stale"]) == 2
    assert sync_stocks.main(["--batch-size", "0"]) == 2
    assert sync_stocks.main(["--delay", "nan"]) == 2
    assert sync_stocks.main(["--codes", "600519", "--missing"]) == 2
    assert sync_stocks.main(["--watchlist", "--missing"]) == 2

    # 2. Index constituent helper: parses clean 6-digit codes and handles upstream errors cleanly.
    def fake_csindex(symbol: str) -> pd.DataFrame:
        if symbol == "000300":
            return pd.DataFrame({"成分券代码": ["688008", "300750", "bad", "688008"]})
        raise RuntimeError("csi500 down")

    monkeypatch.setattr(ak, "index_stock_cons_csindex", fake_csindex)
    hs300, csi500 = await fetch_priority_index_codes(timeout_seconds=2.0)
    assert hs300 == ["688008", "300750"]
    assert csi500 == []

    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        metas = [
            StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
            StockMetaRecord(code="000333", name="美的集团", exchange="SZ"),
            StockMetaRecord(code="300750", name="宁德时代", exchange="SZ"),
            StockMetaRecord(code="600036", name="招商银行", exchange="SH"),
            StockMetaRecord(code="600518", name="ST康美", exchange="SH", is_active=False),
            StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
            StockMetaRecord(code="688008", name="澜起科技", exchange="SH"),
        ]
        meta_by_code = {m.code: m for m in metas}
        from app.domain.engines import build_stock_snapshot

        async with testing_session() as session:
            meta_repo = PostgresStockMetaRepository(session)
            await meta_repo.upsert_many(metas, deactivate_missing=False)

            user = User(
                email="prio@example.com",
                password_hash="hashed",
                display_name="Priority",
                plan_tier="free",
            )
            session.add(user)
            await session.flush()
            session.add(WatchlistItem(user_id=user.id, code="300750", name="宁德时代"))
            await session.commit()

            snap_repo = PostgresStockSnapshotRepository(session)
            await snap_repo.save_snapshot(
                build_stock_snapshot(
                    meta_by_code["600519"], _sample_bundle("600519", date(2026, 11, 20))
                )
            )
            await snap_repo.save_snapshot(
                build_stock_snapshot(
                    meta_by_code["000333"], _sample_bundle("000333", date(2026, 11, 18))
                )
            )

            assert await meta_repo.list_codes_missing_snapshot() == [
                "000001",
                "300750",
                "600036",
                "688008",
            ]
            assert await meta_repo.list_codes_missing_snapshot(limit=2) == ["000001", "300750"]
            assert await meta_repo.list_codes_missing_snapshot(min_as_of=date(2026, 11, 20)) == [
                "000001",
                "000333",
                "300750",
                "600036",
                "688008",
            ]

        # Test _run_sync fallback when market_snapshot is absent + refresh_stale=True.
        fetched_order: list[str] = []
        sleep_calls: list[float] = []
        batch_sizes_seen: list[int] = []

        class _CliFeed:
            def __init__(self, **_kwargs: object) -> None:
                pass

            async def fetch_stock_bundle(
                self, code: str, *, as_of: date | None = None
            ) -> StockFactBundle:
                fetched_order.append(code)
                return _sample_bundle(code, as_of or date(2026, 11, 20))

        class _SpyStore(DuckDBStockFactStore):
            async def write_stocks_facts_batch(self, bundles: Sequence[StockFactBundle]) -> None:
                batch_sizes_seen.append(len(bundles))
                await super().write_stocks_facts_batch(bundles)

        async def noop_dispose() -> None:
            return None

        async def spy_sleep(seconds: float) -> None:
            sleep_calls.append(seconds)

        async def fake_priority_codes(
            *, timeout_seconds: float = 15.0
        ) -> tuple[list[str], list[str]]:
            return ["688008", "300750"], ["600036"]

        monkeypatch.setattr(sync_stocks, "AsyncSessionLocal", testing_session)
        monkeypatch.setattr(sync_stocks, "dispose_db", noop_dispose)
        monkeypatch.setattr(sync_stocks, "AkshareStockFactFeed", _CliFeed)
        monkeypatch.setattr(sync_stocks, "DuckDBStockFactStore", lambda _dir: _SpyStore(tmp_path))
        monkeypatch.setattr(sync_stocks, "fetch_priority_index_codes", fake_priority_codes)
        monkeypatch.setattr(asyncio, "sleep", spy_sleep)

        # Without market_snapshot, --refresh-stale falls back cleanly to missing-only targets.
        fallback_targets, _, _ = await sync_stocks._run_sync(
            codes=[],
            use_watchlist=False,
            limit=1,
            as_of=None,
            missing_only=True,
            refresh_stale=True,
            priority=True,
        )
        assert fallback_targets == ["300750"]
        fetched_order.clear()
        batch_sizes_seen.clear()

        # Reset 300750 snapshot and seed market_snapshot (2026-11-20) so 000333 becomes stale.
        async with testing_session() as session:
            await session.execute(delete(StockSnapshot).where(StockSnapshot.code == "300750"))
            await session.commit()
            await PostgresMarketRepository(session).save_overview(
                _sample_market_overview(date(2026, 11, 20))
            )

        target_codes, summaries, _ = await sync_stocks._run_sync(
            codes=[],
            use_watchlist=False,
            limit=4,
            as_of=None,
            missing_only=True,
            refresh_stale=True,
            priority=True,
            delay_seconds=0.05,
            batch_size=2,
        )

        # Priority order: watchlisted(300750) -> HS300(688008) -> CSI500(600036) -> remaining.
        assert target_codes == ["300750", "688008", "600036", "000001"]
        assert fetched_order == ["300750", "688008", "600036", "000001"]
        assert len(summaries) == 4
        assert sleep_calls == [0.05, 0.05, 0.05]
        assert batch_sizes_seen == [2, 2]

        # Remaining stale stock is now 000333 only.
        async with testing_session() as session:
            remaining = await PostgresStockMetaRepository(session).list_codes_missing_snapshot(
                min_as_of=date(2026, 11, 20)
            )
            assert remaining == ["000333"]
    finally:
        await engine.dispose()


async def test_watchlist_routes_trigger_warmup_and_production_warmup_is_non_blocking(
    caplog: pytest.LogCaptureFixture,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    warmed_codes: list[str] = []
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        async def spy_warmup(code: str) -> None:
            warmed_codes.append(code)

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_watchlist_warmup] = lambda: spy_warmup

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "warmup@example.com",
                    "password": "strong-password-123",
                    "display_name": "Warmup",
                },
            )
            assert reg.status_code == 201
            headers = {"Authorization": f"Bearer {reg.json()['access_token']}"}

            assert (
                await client.put(
                    "/api/watchlist",
                    headers=headers,
                    json={"code": "600519", "name": "贵州茅台"},
                )
            ).status_code == 200
            assert (
                await client.post(
                    "/api/watchlist",
                    headers=headers,
                    json={"code": "000333", "name": "美的集团"},
                )
            ).status_code == 200
            assert (
                await client.put(
                    "/api/watchlist",
                    headers=headers,
                    json={"code": "bad", "name": "无效"},
                )
            ).status_code == 422
            assert warmed_codes == ["600519", "000333"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

    # Verify real production get_watchlist_warmup fires background task and swallows errors safely.
    seen_runner_calls: list[str] = []
    done_event = asyncio.Event()

    class _WarmupRunner:
        async def load_or_sync_snapshot(
            self, code: str, *, force: bool = False
        ) -> StockSnapshotPayload:
            seen_runner_calls.append(code)
            if code == "000333":
                done_event.set()
                raise StockNotFoundError(code)
            done_event.set()
            meta = StockMetaRecord(code=code, name="贵州茅台", exchange="SH")
            return StockSnapshotPayload.model_validate(
                {
                    "code": code,
                    "name": "贵州茅台",
                    "exchange": "SH",
                    "as_of": date(2026, 11, 20),
                    "generated_at": datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
                    **_make_minimal_snapshot_fields(meta),
                }
            )

    coordinator = StockSnapshotCoordinator(_WarmupRunner())
    warmup_fn = get_watchlist_warmup(coordinator)

    with caplog.at_level("WARNING", logger="vs.api.deps"):
        await warmup_fn("600519")
        await asyncio.wait_for(done_event.wait(), timeout=1.0)
        done_event.clear()

        await warmup_fn("000333")
        await asyncio.wait_for(done_event.wait(), timeout=1.0)
        await asyncio.sleep(0.02)

    assert seen_runner_calls == ["600519", "000333"]
    assert "自选股后台预热快照失败 (000333)" in caplog.text
    assert not deps._WARMUP_TASKS
