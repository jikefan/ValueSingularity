"""Integration and unit tests for Phase 2 stock store, feed, sync service, and API routes."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import date, datetime
from pathlib import Path

import akshare as ak
import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.akshare.stock_feed import (
    AkshareStockFactFeed,
    parse_annual_reports,
    parse_daily_bars,
    parse_dividends,
    parse_repurchases,
)
from app.adapters.duckdb.stock_store import DuckDBStockFactStore
from app.adapters.postgres.market import PostgresStockMetaRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.api.deps import get_db, get_stock_service
from app.cli import sync_stocks
from app.db.base import Base
from app.db.models import StockSnapshot, User, WatchlistItem
from app.db.session import DatabaseUnavailableError
from app.domain.engines import build_stock_snapshot
from app.domain.errors import StockFactUnavailableError
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDetail,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
    StockSnapshotPayload,
)
from app.main import create_app
from app.services.stock import StockService
from app.services.stock_sync import StockSyncService
from app.settings import settings


def _sample_bundle(code: str = "600519", as_of: date = date(2026, 11, 20)) -> StockFactBundle:
    bars = [
        StockDailyBar(
            code=code,
            trade_date=date(2025, 11, 20),
            open=1400.0,
            high=1415.0,
            low=1390.0,
            close=1410.0,
            volume=1_000_000.0,
            amount=1.41e9,
            total_mv_yuan=17_600e8,
            pe_ttm=21.0,
            pb=6.2,
            pcf=25.0,
        ),
        StockDailyBar(
            code=code,
            trade_date=as_of,
            open=1470.0,
            high=1490.0,
            low=1460.0,
            close=1485.0,
            volume=1_200_000.0,
            amount=1.78e9,
            total_mv_yuan=18_570e8,
            pe_ttm=22.6,
            pb=6.85,
            pcf=30.2,
        ),
    ]
    reports = [
        StockAnnualReport(
            code=code,
            report_year=y,
            report_date=date(y, 12, 31),
            audit_opinion="标准无保留意见",
            revenue_yuan=1200e8 + (y - 2020) * 100e8,
            operate_cost_yuan=100e8,
            net_profit_yuan=600e8 + (y - 2020) * 50e8,
            deduct_net_profit_yuan=590e8 + (y - 2020) * 50e8,
            research_expense_yuan=2e8,
            total_assets_yuan=2800e8,
            total_equity_yuan=2300e8,
            parent_equity_yuan=2200e8,
            monetary_funds_yuan=600e8,
            cip_yuan=25e8,
            fixed_asset_yuan=220e8,
            accounts_receivable_yuan=0.1e8,
            note_accounts_rece_yuan=0.1e8,
            inventory_yuan=550e8,
            goodwill_yuan=0.0,
            ocf_yuan=650e8 + (y - 2020) * 40e8,
            capex_yuan=30e8,
        )
        for y in range(2020, 2026)
    ]
    return StockFactBundle(
        code=code,
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[
            StockDividendRecord(
                code=code,
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=280.0,
                total_shares=12.5e8,
                dividend_cash_total_yuan=350e8,
                dividend_yield_pct=2.3,
            )
        ],
        repurchases=[
            StockRepurchaseRecord(
                code=code,
                event_date=date(2025, 10, 15),
                year=2025,
                start_date=date(2025, 3, 1),
                progress="完成实施",
                repurchased_amount_yuan=30e8,
                repurchased_shares=2_000_000.0,
            )
        ],
        pledge=StockPledgeSnapshot(code=code, trade_date=as_of, pledge_ratio_pct=0.0),
        equity_financings=[
            StockEquityFinancingRecord(
                code=code,
                year=2023,
                event_date=date(2023, 12, 31),
                source="cash_flow",
                financing_type="现金流量表-吸收投资(母公司口径)",
                amount_yuan=5e8,
            )
        ],
    )


async def test_akshare_stock_feed_alignment_caching_and_edge_cases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sina_calls = 0

    def fake_sina(**_kwargs: object) -> pd.DataFrame:
        nonlocal sina_calls
        sina_calls += 1
        if sina_calls == 1:
            raise RuntimeError("sina transient block")
        return pd.DataFrame(
            {
                "date": [date(2026, 11, 19), date(2026, 11, 20)],
                "open": [1440.0, 1450.0],
                "high": [1465.0, 1490.0],
                "low": [1430.0, 1425.0],
                "close": [1460.0, 1485.75],
                "volume": [4_000_000.0, 6_000_000.0],
                "amount": [6e9, 9e9],
                "outstanding_share": [12.5e8, 12.5e8],
                "turnover": [0.0032, 0.0048],
            }
        )

    def fake_tx(**_kwargs: object) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "date": [date(2026, 11, 19), date(2026, 11, 20)],
                "open": [20.0, 21.0],
                "close": [21.0, 22.0],
                "high": [21.5, 22.5],
                "low": [19.8, 20.5],
                "volume": [100_000.0, 120_000.0],
                "turnover": [0.01, 0.012],
                "amount": [2e6, 2.5e6],
            }
        )

    def fake_baidu(
        symbol: str = "600519", indicator: str = "总市值", **_kwargs: object
    ) -> pd.DataFrame:
        # Include non-trading weekend dates 2026-11-21/22 that must be excluded by alignment.
        values = {
            "总市值": [18000.0, 18573.09, 18573.09],
            "市盈率(TTM)": [22.1, 22.61, 22.61],
            "市净率": [6.7, 6.85, 6.85],
            "市现率": [29.8, 30.19, 30.19],
        }[indicator]
        return pd.DataFrame(
            {
                "date": [date(2026, 11, 19), date(2026, 11, 20), date(2026, 11, 21)],
                "value": values,
            }
        )

    def fake_bs(symbol: str = "SH600519") -> pd.DataFrame:
        rows = [
            {
                "REPORT_DATE": f"{y}-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "UPDATE_DATE": f"{y + 1}-04-15 00:00:00",
                "MONETARYFUNDS": 500e8,
                "TOTAL_ASSETS": 2500e8,
                "TOTAL_PARENT_EQUITY": 2000e8,
                "TOTAL_EQUITY": 2100e8,
                "OPINION_TYPE": "标准无保留意见",
            }
            for y in range(2012, 2026)
        ]
        # Duplicate 2025 with newer UPDATE_DATE and quarterly row that must be filtered out.
        rows.append(
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "UPDATE_DATE": "2026-10-31 00:00:00",
                "MONETARYFUNDS": 516e8,
                "TOTAL_ASSETS": 3038e8,
                "TOTAL_PARENT_EQUITY": 2446e8,
                "TOTAL_EQUITY": 2539e8,
                "OPINION_TYPE": "标准无保留意见",
            }
        )
        rows.append(
            {
                "REPORT_DATE": "2026-09-30 00:00:00",
                "REPORT_TYPE": "三季报",
                "UPDATE_DATE": "2026-10-31 00:00:00",
                "MONETARYFUNDS": 999e8,
                "TOTAL_ASSETS": 9999e8,
            }
        )
        return pd.DataFrame(rows)

    def fake_ps(symbol: str = "SH600519") -> pd.DataFrame:
        return pd.DataFrame(
            [
                {
                    "REPORT_DATE": f"{y}-12-31 00:00:00",
                    "REPORT_TYPE": "年报",
                    "UPDATE_DATE": f"{y + 1}-04-15 00:00:00",
                    "OPERATE_INCOME": 1688e8,
                    "OPERATE_COST": 148e8,
                    "PARENT_NETPROFIT": 823e8,
                    "DEDUCT_PARENT_NETPROFIT": 822e8,
                    "OPINION_TYPE": "标准无保留意见",
                }
                for y in range(2012, 2026)
            ]
        )

    def fake_cf(symbol: str = "SH600519") -> pd.DataFrame:
        return pd.DataFrame(
            [
                {
                    "REPORT_DATE": f"{y}-12-31 00:00:00",
                    "REPORT_TYPE": "年报",
                    "UPDATE_DATE": f"{y + 1}-04-15 00:00:00",
                    "NETCASH_OPERATE": 615e8,
                    "CONSTRUCT_LONG_ASSET": 31e8,
                    "ACCEPT_INVEST_CASH": 10e8 if y == 2024 else 0.0,
                    "SUBSIDIARY_ACCEPT_INVEST": 3e8 if y == 2024 else 0.0,
                    "OPINION_TYPE": "标准无保留意见",
                }
                for y in range(2012, 2026)
            ]
        )

    def fake_fhps(symbol: str = "600519") -> pd.DataFrame:
        return pd.DataFrame(
            [
                {
                    "报告期": date(2025, 12, 31),
                    "现金分红-现金分红比例": 280.0,
                    "总股本": 1_250_000_000.0,
                    "方案进度": "实施分配",
                    "除权除息日": date(2026, 6, 26),
                    "最新公告日期": date(2026, 6, 22),
                    "现金分红-股息率": 0.0231,
                },
                {
                    "报告期": date(2026, 6, 30),
                    "现金分红-现金分红比例": 100.0,
                    "总股本": 1_250_000_000.0,
                    "方案进度": "预披露",
                    "除权除息日": pd.NaT,
                    "最新公告日期": date(2026, 4, 17),
                    "现金分红-股息率": float("nan"),
                },
            ]
        )

    repurchase_calls = 0

    def fake_repurchase() -> pd.DataFrame:
        nonlocal repurchase_calls
        repurchase_calls += 1
        return pd.DataFrame(
            [
                {
                    "股票代码": "600519",
                    "实施进度": "完成实施",
                    "已回购金额": 3_000_000_000.0,
                    "已回购股份数量": 2_000_000.0,
                    "回购起始时间": date(2025, 3, 1),
                    "最新公告日期": date(2025, 10, 15),
                },
                {
                    "股票代码": "600519",
                    "实施进度": "董事会预案",
                    "已回购金额": 5_000_000_000.0,
                    "已回购股份数量": 0.0,
                    "回购起始时间": date(2026, 1, 5),
                    "最新公告日期": date(2026, 1, 5),
                },
            ]
        )

    pledge_calls = 0

    def fake_pledge(date: str = "20261120") -> pd.DataFrame:
        nonlocal pledge_calls
        pledge_calls += 1
        if date == "20261120":
            # Simulate holiday/unpublished latest Friday -> must walk back 1 week to 20261113.
            raise KeyError("empty date")
        return pd.DataFrame(
            [
                {
                    "股票代码": "000333",
                    "交易日期": pd.Timestamp("2026-11-13").date(),
                    "质押比例": 5.4,
                    "质押股数": 1000.0,
                    "质押市值": 70000.0,
                }
            ]
        )

    def fake_add_stock(symbol: str = "600519") -> pd.DataFrame:
        if symbol == "600519":
            raise TypeError("exceptions must derive from BaseException")
        return pd.DataFrame(
            [
                {
                    "公告日期": date(2024, 9, 10),
                    "发行方式": "定向增发",
                    "实际公司募集资金总额": "22,661.31万元",
                }
            ]
        )

    monkeypatch.setattr(ak, "stock_zh_a_hist_sina", fake_sina)
    monkeypatch.setattr(ak, "stock_zh_a_hist_tx", fake_tx)
    monkeypatch.setattr(ak, "stock_zh_valuation_baidu", fake_baidu)
    monkeypatch.setattr(ak, "stock_balance_sheet_by_report_em", fake_bs)
    monkeypatch.setattr(ak, "stock_profit_sheet_by_report_em", fake_ps)
    monkeypatch.setattr(ak, "stock_cash_flow_sheet_by_report_em", fake_cf)
    monkeypatch.setattr(ak, "stock_fhps_detail_em", fake_fhps)
    monkeypatch.setattr(ak, "stock_repurchase_em", fake_repurchase)
    monkeypatch.setattr(ak, "stock_gpzy_pledge_ratio_em", fake_pledge)
    monkeypatch.setattr(ak, "stock_add_stock", fake_add_stock)

    feed = AkshareStockFactFeed(timeout_seconds=5.0, max_attempts=1, retry_wait_seconds=0.0)

    # First stock triggers Sina failure -> TX fallback + caches global repurchase & pledge tables.
    bundle_tx = await feed.fetch_stock_bundle("000333", as_of=date(2026, 11, 20))
    assert bundle_tx.data_source == "akshare:tx"
    assert [b.trade_date for b in bundle_tx.daily_bars] == [date(2026, 11, 19), date(2026, 11, 20)]
    assert bundle_tx.pledge is not None and bundle_tx.pledge.pledge_ratio_pct == 5.4
    assert any(
        f.source == "add_stock" and f.amount_yuan == pytest.approx(226_613_100.0)
        for f in bundle_tx.equity_financings
    )

    # Second stock uses Sina, reuses cached repurchase & pledge tables, gets explicit 0.0% pledge.
    bundle_sina = await feed.fetch_stock_bundle("600519", as_of=date(2026, 11, 20))
    assert bundle_sina.data_source == "akshare"
    assert len(bundle_sina.daily_bars) == 2
    assert bundle_sina.daily_bars[-1].total_mv_yuan == pytest.approx(18_573.09e8)
    assert len(bundle_sina.annual_reports) == 12
    assert bundle_sina.annual_reports[-1].monetary_funds_yuan == pytest.approx(516e8)
    assert len(bundle_sina.dividends) == 1
    assert bundle_sina.dividends[0].dividend_cash_total_yuan == pytest.approx(3.5e10)
    assert len(bundle_sina.repurchases) == 1
    assert bundle_sina.pledge is not None
    assert bundle_sina.pledge.pledge_ratio_pct == 0.0
    assert bundle_sina.pledge.trade_date == date(2026, 11, 13)
    assert any(
        f.source == "cash_flow" and f.amount_yuan == pytest.approx(7e8)
        for f in bundle_sina.equity_financings
    )

    assert repurchase_calls == 1
    assert pledge_calls == 2


async def test_duckdb_stock_fact_store_roundtrip_and_concurrency(tmp_path: Path) -> None:
    store = DuckDBStockFactStore(tmp_path)
    bundle_600519 = _sample_bundle("600519", date(2026, 11, 20))
    bundle_000333 = _sample_bundle("000333", date(2026, 11, 20))

    await asyncio.gather(
        store.write_stock_facts(bundle_600519),
        store.write_stock_facts(bundle_000333),
    )

    bars_2026 = tmp_path / "bars/daily/year=2026/data.parquet"
    annual_2025 = tmp_path / "fundamentals/annual/report_year=2025/data.parquet"
    div_rep_all = tmp_path / "fundamentals/dividends_repurchase/all.parquet"
    pledge_fin_all = tmp_path / "fundamentals/pledge_financing/all.parquet"
    for p in (bars_2026, annual_2025, div_rep_all, pledge_fin_all):
        assert p.exists()
        assert (p.stat().st_mode & 0o777) & 0o444 == 0o444

    # Upsert overlapping day/year to ensure idempotency.
    updated_bar = bundle_600519.daily_bars[-1].model_copy(update={"close": 1492.0})
    await store.write_stock_facts(bundle_600519.model_copy(update={"daily_bars": [updated_bar]}))

    loaded = await store.load_stock_facts("600519")
    assert loaded is not None
    assert [b.trade_date for b in loaded.daily_bars] == [date(2025, 11, 20), date(2026, 11, 20)]
    assert loaded.daily_bars[-1].close == pytest.approx(1492.0)
    assert len(loaded.annual_reports) == 6
    assert len(loaded.dividends) == 1
    assert len(loaded.repurchases) == 1
    assert loaded.pledge is not None and loaded.pledge.pledge_ratio_pct == 0.0
    assert len(loaded.equity_financings) == 1

    # Verify as_of filtering omits 2026 bars.
    loaded_2025 = await store.load_stock_facts("600519", as_of=date(2025, 12, 31))
    assert loaded_2025 is not None
    assert [b.trade_date for b in loaded_2025.daily_bars] == [date(2025, 11, 20)]

    assert await store.load_stock_facts("999999") is None

    # Confirm DuckDB hive_partitioning reads generated Parquet partitions directly.
    con = duckdb.connect(":memory:")
    try:
        cnt = con.execute(
            "SELECT count(*) FROM read_parquet(?, hive_partitioning=true) WHERE code = ?",
            [str(tmp_path / "bars/daily/*/*.parquet"), "600519"],
        ).fetchone()
        assert cnt == (2,)
        assert pq.read_table(bars_2026).num_rows == 2
    finally:
        con.close()


async def test_stock_sync_service_preserves_prior_snapshot_on_feed_failure(tmp_path: Path) -> None:
    meta = StockMetaRecord(code="600519", name="贵州茅台", exchange="SH", industry_sw1="食品饮料")
    sample = _sample_bundle("600519", date(2026, 11, 20))

    class _StubFeed:
        def __init__(self) -> None:
            self.fail = False

        async def fetch_stock_bundle(
            self, code: str, *, as_of: date | None = None
        ) -> StockFactBundle:
            if self.fail:
                raise StockFactUnavailableError(code, "akshare", "upstream down")
            return sample

    class _MemMetaRepo:
        async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
            return 0

        async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
            return []

        async def get_detail(self, code: str) -> StockDetail | None:
            return None

        async def get_name(self, code: str) -> str | None:
            return meta.name if code == meta.code else None

        async def list_by_codes(self, codes: Sequence[str]) -> list[StockMetaRecord]:
            return [meta] if meta.code in codes else []

        async def list_watched_codes(self, *, limit: int | None = None) -> list[str]:
            return []

        async def list_active_codes(self, *, limit: int | None = None) -> list[str]:
            return [meta.code]

    class _MemSnapshotRepo:
        def __init__(self) -> None:
            self.rows: dict[str, StockSnapshotPayload] = {}

        async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
            return self.rows.get(code)

        async def get_snapshots_for_compare(
            self, codes: Sequence[str]
        ) -> dict[str, StockSnapshotPayload]:
            return {c: self.rows[c] for c in codes if c in self.rows}

        async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
            self.rows[snapshot.code] = snapshot

    feed = _StubFeed()
    store = DuckDBStockFactStore(tmp_path)
    snap_repo = _MemSnapshotRepo()
    service = StockSyncService(
        feed=feed,
        fact_store=store,
        stock_meta_repo=_MemMetaRepo(),
        snapshot_repo=snap_repo,
    )

    summary = await service.sync_stock("600519")
    assert summary.code == "600519"
    assert summary.daily_bars_count == 2
    assert summary.annual_reports_count == 6
    first_snap = await snap_repo.get_snapshot("600519")
    assert first_snap is not None

    feed.fail = True
    with pytest.raises(StockFactUnavailableError):
        await service.sync_stock("600519", as_of=date(2026, 11, 21))
    assert await snap_repo.get_snapshot("600519") == first_snap


async def test_pg_stock_snapshot_upsert_and_api_routes(tmp_path: Path) -> None:
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

        meta_600519 = StockMetaRecord(
            code="600519", name="贵州茅台", exchange="SH", industry_sw1="食品饮料"
        )
        meta_000333 = StockMetaRecord(
            code="000333", name="美的集团", exchange="SZ", industry_sw1="家用电器"
        )
        meta_000001 = StockMetaRecord(
            code="000001", name="平安银行", exchange="SZ", industry_sw1="银行"
        )

        async with testing_session() as session:
            meta_repo = PostgresStockMetaRepository(session)
            await meta_repo.upsert_many([meta_600519, meta_000333, meta_000001])

            user = User(
                email="watch@example.com",
                password_hash="hashed",
                display_name="WatchTester",
                plan_tier="free",
            )
            session.add(user)
            await session.flush()
            session.add(WatchlistItem(user_id=user.id, code="600519", name="贵州茅台"))
            await session.commit()

            assert await meta_repo.list_watched_codes() == ["600519"]
            assert await meta_repo.list_active_codes(limit=2) == ["000001", "000333"]

        bundle_600519 = _sample_bundle("600519", date(2026, 11, 20))

        class _StaticFeed:
            async def fetch_stock_bundle(
                self, code: str, *, as_of: date | None = None
            ) -> StockFactBundle:
                return bundle_600519

        # Sync 600519 twice (idempotent PG upsert) and leave 000333 without snapshot.
        for _ in range(2):
            async with testing_session() as session:
                sync_service = StockSyncService(
                    feed=_StaticFeed(),
                    fact_store=DuckDBStockFactStore(tmp_path),
                    stock_meta_repo=PostgresStockMetaRepository(session),
                    snapshot_repo=PostgresStockSnapshotRepository(session),
                )
                await sync_service.sync_stock("600519")

        # Stale older as_of must not overwrite newer snapshot.
        older_snap = build_stock_snapshot(meta_600519, _sample_bundle("600519", date(2026, 11, 18)))
        async with testing_session() as session:
            snap_repo = PostgresStockSnapshotRepository(session)
            await snap_repo.save_snapshot(older_snap)
            count = await session.scalar(select(func.count()).select_from(StockSnapshot))
            assert count == 1
            current = await snap_repo.get_snapshot("600519")
            assert current is not None and current.as_of == date(2026, 11, 20)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            snap_ok = await client.get("/api/stocks/600519/snapshot")
            assert snap_ok.status_code == 200
            body = snap_ok.json()
            assert body["code"] == "600519"
            assert body["as_of"] == "2026-11-20"
            assert body["financial_ct"]["overall_status"] in {"green", "yellow", "red", "na"}
            assert len(body["financial_ct"]["checks"]) == 7
            assert body["peer_metrics"]["code"] == "600519"

            # Known stock without snapshot -> 404; unknown stock -> 404; invalid code -> 422.
            assert (await client.get("/api/stocks/000333/snapshot")).status_code == 404
            assert (await client.get("/api/stocks/999999/snapshot")).status_code == 404
            assert (await client.get("/api/stocks/abc/snapshot")).status_code == 422

            # Compare preserves requested order and reports snapshot_available per item.
            cmp_ok = await client.get("/api/stocks/compare", params={"codes": "000333,600519"})
            assert cmp_ok.status_code == 200
            cmp_body = cmp_ok.json()
            assert [item["code"] for item in cmp_body] == ["000333", "600519"]
            assert cmp_body[0]["snapshot_available"] is False
            assert cmp_body[0]["metrics"] is None
            assert cmp_body[1]["snapshot_available"] is True
            assert cmp_body[1]["snapshot_as_of"] == "2026-11-20"
            assert cmp_body[1]["metrics"]["total_score"] == body["radar"]["total_score"]

            # Unknown code in compare -> 404.
            assert (
                await client.get("/api/stocks/compare", params={"codes": "600519,999999"})
            ).status_code == 404

            # Strict 422 edge cases on /api/stocks/compare.
            assert (await client.get("/api/stocks/compare")).status_code == 422
            for bad_codes in (
                "",
                "   ",
                "600519,",
                ",600519",
                "600519,,000333",
                "600519,abc",
                "600519,60051",
                "６００５１９",
                "600519,\x00000333",
                "600519,600519",
                "600519,000333,000001,300750,688981,000002",
            ):
                resp = await client.get("/api/stocks/compare", params={"codes": bad_codes})
                assert resp.status_code == 422, f"Expected 422 for codes={bad_codes!r}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_snapshot_and_compare_return_503_when_db_unavailable() -> None:
    class _BrokenMetaRepo:
        async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
            raise DatabaseUnavailableError("OperationalError")

        async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
            raise DatabaseUnavailableError("OperationalError")

        async def get_detail(self, code: str) -> StockDetail | None:
            raise DatabaseUnavailableError("OperationalError")

        async def get_name(self, code: str) -> str | None:
            raise DatabaseUnavailableError("OperationalError")

        async def list_by_codes(self, codes: Sequence[str]) -> list[StockMetaRecord]:
            raise DatabaseUnavailableError("OperationalError")

        async def list_watched_codes(self, *, limit: int | None = None) -> list[str]:
            raise DatabaseUnavailableError("OperationalError")

        async def list_active_codes(self, *, limit: int | None = None) -> list[str]:
            raise DatabaseUnavailableError("OperationalError")

    class _BrokenSnapshotRepo:
        async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
            raise DatabaseUnavailableError("OperationalError")

        async def get_snapshots_for_compare(
            self, codes: Sequence[str]
        ) -> dict[str, StockSnapshotPayload]:
            raise DatabaseUnavailableError("OperationalError")

        async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
            raise DatabaseUnavailableError("OperationalError")

    app = create_app()
    app.dependency_overrides[get_stock_service] = lambda: StockService(
        _BrokenMetaRepo(), _BrokenSnapshotRepo()
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/api/stocks/600519/snapshot")).status_code == 503
            assert (
                await client.get("/api/stocks/compare", params={"codes": "600519"})
            ).status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_sync_stocks_cli_argument_validation() -> None:
    assert sync_stocks._parse_codes(["600519,000333", "000001"]) == ["600519", "000333", "000001"]
    assert sync_stocks.main(["--codes", "bad"]) == 2
    assert sync_stocks.main(["--limit", "0"]) == 2
    assert sync_stocks.main(["--date", "2026-99-99"]) == 2


async def test_akshare_stock_feed_merges_10y_1y_baidu_backward_without_lookahead(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bars_df = pd.DataFrame(
        {
            "date": [
                date(2026, 11, 2),
                date(2026, 11, 13),
                date(2026, 11, 18),
                date(2026, 11, 19),
                date(2026, 11, 20),
                date(2026, 12, 5),
            ],
            "open": [1400.0, 1420.0, 1445.0, 1455.0, 1475.0, 1500.0],
            "high": [1410.0, 1430.0, 1455.0, 1465.0, 1490.0, 1510.0],
            "low": [1395.0, 1415.0, 1435.0, 1445.0, 1470.0, 1495.0],
            "close": [1405.0, 1425.0, 1450.0, 1460.0, 1485.0, 1505.0],
            "outstanding_share": [1.25e9, 1.25e9, 1.25e9, 1.25e9, 1.25e9, 1.25e9],
        }
    )
    # 2026-11-02 is before earliest Baidu sample (no look-ahead to 2026-11-12);
    # 2026-11-13 maps backward to 2026-11-12 (lag=1 <= 10);
    # 2026-12-05 is 15 days after 2026-11-20 (> 10d max lag -> None, triggers close*share fallback).
    mv_df = pd.DataFrame(
        {
            "date": [date(2026, 11, 12), date(2026, 11, 17), date(2026, 11, 22)],
            "value": [17800.0, 18100.0, 19999.0],
        }
    )
    pe_df = pd.DataFrame(
        {
            "date": [date(2026, 11, 12), date(2026, 11, 17), date(2026, 11, 22)],
            "value": [21.5, 22.0, 29.0],
        }
    )
    parsed = parse_daily_bars(bars_df, "600519", mv_df=mv_df, pe_df=pe_df)
    by_dt = {bar.trade_date: bar for bar in parsed}

    assert by_dt[date(2026, 11, 2)].pe_ttm is None
    assert by_dt[date(2026, 11, 2)].total_mv_yuan == pytest.approx(1405.0 * 1.25e9)
    assert by_dt[date(2026, 11, 13)].pe_ttm == pytest.approx(21.5)
    assert by_dt[date(2026, 11, 13)].total_mv_yuan == pytest.approx(17800.0e8)
    assert by_dt[date(2026, 11, 20)].pe_ttm == pytest.approx(22.0)
    assert by_dt[date(2026, 11, 20)].total_mv_yuan == pytest.approx(18100.0e8)
    assert by_dt[date(2026, 12, 5)].pe_ttm is None
    assert by_dt[date(2026, 12, 5)].total_mv_yuan == pytest.approx(1505.0 * 1.25e9)

    seen_periods: set[tuple[str, str]] = set()

    def fake_sina(**_kwargs: object) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "date": [date(2026, 11, 18), date(2026, 11, 19), date(2026, 11, 20)],
                "open": [1445.0, 1455.0, 1475.0],
                "high": [1455.0, 1465.0, 1490.0],
                "low": [1435.0, 1445.0, 1470.0],
                "close": [1450.0, 1460.0, 1485.0],
                "outstanding_share": [1.25e9, 1.25e9, 1.25e9],
            }
        )

    def fake_baidu(
        symbol: str = "600519", indicator: str = "总市值", period: str = "近十年"
    ) -> pd.DataFrame:
        seen_periods.add((indicator, period))
        if indicator == "市净率" and period == "近十年":
            raise RuntimeError("10y PB temporarily unavailable")
        if indicator == "市现率" and period == "近一年":
            raise RuntimeError("1y PCF temporarily unavailable")

        if period == "近十年":
            vals = {
                "总市值": [18100.0, 19999.0],
                "市盈率(TTM)": [21.9, 28.0],
                "市现率": [29.5, 35.0],
            }
            return pd.DataFrame(
                {"date": [date(2026, 11, 17), date(2026, 11, 22)], "value": vals[indicator]}
            )

        vals_1y = {
            "总市值": [18125.0, 18250.0, 18573.09],
            "市盈率(TTM)": [22.1, 22.3, 22.61],
            "市净率": [6.7, 6.78, 6.85],
        }
        return pd.DataFrame(
            {
                "date": [date(2026, 11, 17), date(2026, 11, 19), date(2026, 11, 20)],
                "value": vals_1y[indicator],
            }
        )

    monkeypatch.setattr(ak, "stock_zh_a_hist_sina", fake_sina)
    monkeypatch.setattr(ak, "stock_zh_valuation_baidu", fake_baidu)
    monkeypatch.setattr(ak, "stock_balance_sheet_by_report_em", lambda **_kwargs: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_profit_sheet_by_report_em", lambda **_kwargs: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_cash_flow_sheet_by_report_em", lambda **_kwargs: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_fhps_detail_em", lambda **_kwargs: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_repurchase_em", lambda: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_gpzy_pledge_ratio_em", lambda **_kwargs: pd.DataFrame())
    monkeypatch.setattr(ak, "stock_add_stock", lambda **_kwargs: pd.DataFrame())

    feed = AkshareStockFactFeed(timeout_seconds=5.0, max_attempts=1, retry_wait_seconds=0.0)
    bundle = await feed.fetch_stock_bundle("600519", as_of=date(2026, 11, 20))

    assert seen_periods == {
        (ind, p)
        for ind in ("总市值", "市盈率(TTM)", "市净率", "市现率")
        for p in ("近十年", "近一年")
    }
    bars_map = {bar.trade_date: bar for bar in bundle.daily_bars}
    assert bars_map[date(2026, 11, 18)].total_mv_yuan == pytest.approx(18125.0e8)
    assert bars_map[date(2026, 11, 18)].pe_ttm == pytest.approx(22.1)
    assert bars_map[date(2026, 11, 18)].pb == pytest.approx(6.7)
    assert bars_map[date(2026, 11, 18)].pcf == pytest.approx(29.5)
    assert bars_map[date(2026, 11, 20)].total_mv_yuan == pytest.approx(18573.09e8)
    assert bars_map[date(2026, 11, 20)].pe_ttm == pytest.approx(22.61)
    assert bars_map[date(2026, 11, 20)].pb == pytest.approx(6.85)
    assert bars_map[date(2026, 11, 20)].pcf == pytest.approx(29.5)


async def test_pledge_cache_isolated_across_as_of_dates_and_cancelled_error_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pledge_dates_seen: list[str] = []

    def fake_pledge(date: str = "20261120") -> pd.DataFrame:
        pledge_dates_seen.append(date)
        parsed_dt = datetime.strptime(date, "%Y%m%d").date()
        ratio = 1.5 if parsed_dt.year == 2026 else 9.9
        return pd.DataFrame(
            [
                {
                    "股票代码": "600519",
                    "交易日期": parsed_dt,
                    "质押比例": ratio,
                }
            ]
        )

    def fake_add_stock_cancel(symbol: str = "600519") -> pd.DataFrame:
        raise asyncio.CancelledError("task cancelled")

    monkeypatch.setattr(ak, "stock_gpzy_pledge_ratio_em", fake_pledge)
    monkeypatch.setattr(ak, "stock_add_stock", fake_add_stock_cancel)

    feed = AkshareStockFactFeed(timeout_seconds=5.0, max_attempts=1, retry_wait_seconds=0.0)
    pledge_2026 = await feed._get_pledge_for_code("600519", anchor_date=date(2026, 11, 20))
    pledge_2025 = await feed._get_pledge_for_code("600519", anchor_date=date(2025, 11, 21))
    # Suspended Monday maps to prior Friday (2026-11-13), avoiding 2026-11-20 cache bleed.
    pledge_suspended = await feed._get_pledge_for_code("600519", anchor_date=date(2026, 11, 16))

    assert pledge_2026 is not None and pledge_2026.trade_date == date(2026, 11, 20)
    assert pledge_2026.pledge_ratio_pct == pytest.approx(1.5)
    assert pledge_2025 is not None and pledge_2025.trade_date == date(2025, 11, 21)
    assert pledge_2025.pledge_ratio_pct == pytest.approx(9.9)
    assert pledge_suspended is not None and pledge_suspended.trade_date == date(2026, 11, 13)
    assert pledge_dates_seen == ["20261120", "20251121", "20261113"]

    with pytest.raises(asyncio.CancelledError):
        await feed._fetch_add_stock("600519", as_of=date(2026, 11, 20))

    # Repurchase cache refreshes across calendar dates (SHANGHAI_TZ) and filters by as_of.
    import app.adapters.akshare.stock_feed as stock_feed_mod

    current_day = date(2026, 11, 20)
    rep_calls = 0

    class _FakeDateTime:
        @staticmethod
        def now(_tz: object = None) -> datetime:
            return datetime(current_day.year, current_day.month, current_day.day, 10, 0)

    def fake_rep_table() -> pd.DataFrame:
        nonlocal rep_calls
        rep_calls += 1
        return pd.DataFrame(
            [
                {
                    "股票代码": "600519",
                    "实施进度": "完成实施",
                    "已回购金额": 1e8 if rep_calls == 1 else 2e8,
                    "回购起始时间": date(2026, 1, 10),
                    "最新公告日期": current_day,
                }
            ]
        )

    monkeypatch.setattr(stock_feed_mod, "datetime", _FakeDateTime)
    monkeypatch.setattr(ak, "stock_repurchase_em", fake_rep_table)

    day1_recs = await feed._get_repurchases_for_code("600519", as_of=date(2026, 11, 20))
    assert len(day1_recs) == 1 and day1_recs[0].repurchased_amount_yuan == pytest.approx(1e8)
    # Same day reuses cache.
    day1_again = await feed._get_repurchases_for_code("600519", as_of=date(2026, 11, 20))
    assert len(day1_again) == 1 and rep_calls == 1

    # Next calendar day invalidates cache; earlier as_of filters out newer record.
    current_day = date(2026, 11, 21)
    assert await feed._get_repurchases_for_code("600519", as_of=date(2026, 11, 20)) == []
    day2_recs = await feed._get_repurchases_for_code("600519", as_of=date(2026, 11, 21))
    assert rep_calls == 2
    assert len(day2_recs) == 1 and day2_recs[0].repurchased_amount_yuan == pytest.approx(2e8)


def test_parse_repurchases_preserves_distinct_plans_sharing_start_date() -> None:
    df = pd.DataFrame(
        [
            {
                "股票代码": "688008",
                "实施进度": "完成实施",
                "已回购金额": 3.2e8,
                "已回购股份数量": 5_000_000.0,
                "回购起始时间": date(2024, 2, 1),
                "最新公告日期": date(2024, 5, 10),
            },
            {
                "股票代码": "688008",
                "实施进度": "完成实施",
                "已回购金额": 6.5e8,
                "已回购股份数量": 9_000_000.0,
                "回购起始时间": date(2024, 2, 1),
                "最新公告日期": date(2024, 11, 20),
            },
            # Duplicate (start_date, event_date) with lower amount must NOT overwrite higher amount.
            {
                "股票代码": "688008",
                "实施进度": "实施中",
                "已回购金额": 1.0e8,
                "已回购股份数量": 1_500_000.0,
                "回购起始时间": date(2024, 2, 1),
                "最新公告日期": date(2024, 11, 20),
            },
        ]
    )
    parsed = parse_repurchases(df)
    assert "688008" in parsed
    records = parsed["688008"]
    assert len(records) == 2
    assert [(r.start_date, r.event_date, r.repurchased_amount_yuan) for r in records] == [
        (date(2024, 2, 1), date(2024, 5, 10), 3.2e8),
        (date(2024, 2, 1), date(2024, 11, 20), 6.5e8),
    ]


async def test_duckdb_store_resync_prunes_removed_rows_and_reads_legacy_div_rep_schema(
    tmp_path: Path,
) -> None:
    store = DuckDBStockFactStore(tmp_path)
    bundle_688008 = _sample_bundle("688008", date(2026, 11, 13)).model_copy(
        update={
            "repurchases": [
                StockRepurchaseRecord(
                    code="688008",
                    event_date=date(2024, 5, 10),
                    year=2024,
                    start_date=date(2024, 2, 1),
                    progress="完成实施",
                    repurchased_amount_yuan=3.2e8,
                ),
                StockRepurchaseRecord(
                    code="688008",
                    event_date=date(2024, 11, 20),
                    year=2024,
                    start_date=date(2024, 2, 1),
                    progress="完成实施",
                    repurchased_amount_yuan=6.5e8,
                ),
            ],
            "pledge": StockPledgeSnapshot(
                code="688008", trade_date=date(2026, 11, 13), pledge_ratio_pct=1.2
            ),
            "equity_financings": [
                StockEquityFinancingRecord(
                    code="688008",
                    year=2024,
                    event_date=date(2024, 6, 1),
                    source="add_stock",
                    financing_type="定增",
                    amount_yuan=10e8,
                )
            ],
        }
    )
    bundle_600519 = _sample_bundle("600519", date(2026, 11, 20))
    await store.write_stock_facts(bundle_688008)
    await store.write_stock_facts(bundle_600519)

    loaded_both = await store.load_stock_facts("688008")
    assert loaded_both is not None
    assert len(loaded_both.repurchases) == 2

    # Re-sync 688008 with empty dividends, repurchases, and equity_financings + new pledge date.
    resynced_688008 = bundle_688008.model_copy(
        update={
            "as_of": date(2026, 11, 20),
            "dividends": [],
            "repurchases": [],
            "equity_financings": [],
            "pledge": StockPledgeSnapshot(
                code="688008", trade_date=date(2026, 11, 20), pledge_ratio_pct=0.8
            ),
        }
    )
    await store.write_stock_facts(resynced_688008)

    reloaded_688008 = await store.load_stock_facts("688008")
    assert reloaded_688008 is not None
    assert reloaded_688008.dividends == []
    assert reloaded_688008.repurchases == []
    assert reloaded_688008.equity_financings == []
    # Latest pledge is 2026-11-20, while historical 2026-11-13 pledge remains queryable by as_of.
    assert reloaded_688008.pledge is not None
    assert reloaded_688008.pledge.trade_date == date(2026, 11, 20)
    reloaded_hist = await store.load_stock_facts("688008", as_of=date(2026, 11, 13))
    assert reloaded_hist is not None and reloaded_hist.pledge is not None
    assert reloaded_hist.pledge.trade_date == date(2026, 11, 13)

    # Other stock's dividends/repurchases/financings must remain untouched.
    reloaded_600519 = await store.load_stock_facts("600519")
    assert reloaded_600519 is not None
    assert len(reloaded_600519.dividends) == 1
    assert len(reloaded_600519.repurchases) == 1
    assert len(reloaded_600519.equity_financings) == 1

    # Backward compatibility: legacy div_rep parquet missing `secondary_date` column loads cleanly.
    legacy_dir = tmp_path / "legacy_schema"
    legacy_path = legacy_dir / "fundamentals" / "dividends_repurchase" / "all.parquet"
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
            }
        ],
        schema=legacy_schema,
    )
    pq.write_table(legacy_table, legacy_path)
    legacy_store = DuckDBStockFactStore(legacy_dir)
    loaded_legacy = await legacy_store.load_stock_facts("600519")
    assert loaded_legacy is not None
    assert len(loaded_legacy.repurchases) == 1
    assert loaded_legacy.repurchases[0].event_date == date(2025, 10, 15)


async def test_notice_date_lookahead_excluded_in_feed_and_store(tmp_path: Path) -> None:
    bs_df = pd.DataFrame(
        [
            {
                "REPORT_DATE": "2024-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "NOTICE_DATE": "2025-04-03 00:00:00",
                "UPDATE_DATE": "2025-04-03 00:00:00",
                "TOTAL_ASSETS": 2500e8,
            },
            # Future restatement published 2026-04 must be ignored at as_of=2026-03-01.
            {
                "REPORT_DATE": "2024-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "NOTICE_DATE": "2025-04-03 00:00:00",
                "UPDATE_DATE": "2026-04-17 00:00:00",
                "TOTAL_ASSETS": 2999e8,
            },
            # Disclosed 2026-04-17: must be excluded when as_of=2026-03-01.
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "NOTICE_DATE": "2026-04-17 00:00:00",
                "UPDATE_DATE": "2026-04-17 00:00:00",
                "TOTAL_ASSETS": 3100e8,
            },
        ]
    )
    reports_mar = parse_annual_reports(
        "600519",
        balance_df=bs_df,
        profit_df=pd.DataFrame(),
        cash_flow_df=pd.DataFrame(),
        as_of=date(2026, 3, 1),
    )
    assert [r.report_year for r in reports_mar] == [2024]
    assert reports_mar[0].total_assets_yuan == pytest.approx(2500e8)

    div_df = pd.DataFrame(
        [
            {
                "报告期": date(2024, 12, 31),
                "现金分红-现金分红比例": 200.0,
                "总股本": 1_250_000_000.0,
                "方案进度": "实施分配",
                "最新公告日期": date(2025, 6, 20),
            },
            {
                "报告期": date(2025, 12, 31),
                "现金分红-现金分红比例": 280.0,
                "总股本": 1_250_000_000.0,
                "方案进度": "实施分配",
                "最新公告日期": date(2026, 6, 22),
            },
        ]
    )
    divs_mar = parse_dividends(div_df, "600519", as_of=date(2026, 3, 1))
    assert [d.report_year for d in divs_mar] == [2024]

    # Store-level point-in-time guard when loading an already-synced bundle with a historical as_of.
    store = DuckDBStockFactStore(tmp_path)
    full_bundle = _sample_bundle("600519", date(2026, 11, 20)).model_copy(
        update={
            "annual_reports": [
                StockAnnualReport(
                    code="600519",
                    report_year=2024,
                    report_date=date(2024, 12, 31),
                    notice_date=date(2025, 4, 3),
                    revenue_yuan=1500e8,
                ),
                StockAnnualReport(
                    code="600519",
                    report_year=2025,
                    report_date=date(2025, 12, 31),
                    notice_date=date(2026, 4, 17),
                    revenue_yuan=1700e8,
                ),
            ],
            "dividends": [
                StockDividendRecord(
                    code="600519",
                    report_date=date(2024, 12, 31),
                    report_year=2024,
                    notice_date=date(2025, 6, 20),
                    plan_progress="实施分配",
                    cash_per_10_shares=200.0,
                    total_shares=12.5e8,
                    dividend_cash_total_yuan=250e8,
                ),
                StockDividendRecord(
                    code="600519",
                    report_date=date(2025, 12, 31),
                    report_year=2025,
                    notice_date=date(2026, 6, 22),
                    plan_progress="实施分配",
                    cash_per_10_shares=280.0,
                    total_shares=12.5e8,
                    dividend_cash_total_yuan=350e8,
                ),
            ],
        }
    )
    await store.write_stock_facts(full_bundle)
    loaded_mar = await store.load_stock_facts("600519", as_of=date(2026, 3, 1))
    assert loaded_mar is not None
    assert [r.report_year for r in loaded_mar.annual_reports] == [2024]
    assert [d.report_year for d in loaded_mar.dividends] == [2024]
    assert loaded_mar.repurchases == [
        r for r in full_bundle.repurchases if r.event_date <= date(2026, 3, 1)
    ]
