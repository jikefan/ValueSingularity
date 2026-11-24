from __future__ import annotations

from datetime import UTC, date, datetime

from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.adapters.postgres.market import PostgresStockMetaRepository
from app.api.deps import get_stock_service
from app.db.models import StockMeta, StockSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.engines import build_stock_snapshot
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDetail,
    StockDividendRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockSnapshotPayload,
)
from app.main import create_app
from app.services.stock import StockService
from app.settings import settings


async def _seed_stocks(
    items: list[StockMetaRecord],
    *,
    snapshot_codes: set[str] | None = None,
) -> None:
    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        async with engine.begin() as conn:
            for item in items:
                await conn.run_sync(
                    lambda sync_conn, row=item: sync_conn.execute(
                        StockMeta.__table__.insert().values(
                            code=row.code,
                            name=row.name,
                            exchange=row.exchange,
                            industry_sw1=row.industry_sw1,
                            industry_sw2=row.industry_sw2,
                            list_date=row.list_date,
                            is_st=row.is_st,
                            is_active=row.is_active,
                        )
                    )
                )
            for code in snapshot_codes or set():
                await conn.run_sync(
                    lambda sync_conn, snap_code=code: sync_conn.execute(
                        StockSnapshot.__table__.insert().values(
                            code=snap_code,
                            as_of=date(2026, 11, 20),
                            payload={"code": snap_code},
                        )
                    )
                )
    finally:
        await engine.dispose()


async def test_stock_search_ordering_and_escaping(db_client: AsyncClient) -> None:
    await _seed_stocks(
        [
            StockMetaRecord(
                code="600519",
                name="贵州茅台",
                exchange="SH",
                industry_sw1="食品饮料",
                industry_sw2="白酒",
                list_date=date(2001, 8, 27),
            ),
            StockMetaRecord(code="600510", name="黑牡丹", exchange="SH"),
            StockMetaRecord(code="000600", name="建投能源", exchange="SZ"),
            StockMetaRecord(
                code="600518", name="ST康美", exchange="SH", is_st=True, is_active=False
            ),
            StockMetaRecord(code="000002", name="茅台生态", exchange="SZ"),
            StockMetaRecord(code="300750", name="600519概念", exchange="SZ"),
            StockMetaRecord(code="920001", name="百分_测试%股", exchange="BJ"),
        ]
    )

    # Exact code match ranks before prefix name match ("600519概念").
    exact = await db_client.get("/api/stocks/search", params={"q": "600519"})
    assert exact.status_code == 200
    assert [item["code"] for item in exact.json()] == ["600519", "300750"]

    # Prefix matches rank before substring matches; active stocks rank before inactive.
    prefix_vs_sub = await db_client.get("/api/stocks/search", params={"q": "600"})
    assert prefix_vs_sub.status_code == 200
    assert [item["code"] for item in prefix_vs_sub.json()] == [
        "300750",
        "600510",
        "600519",
        "600518",
        "000600",
    ]

    prefix_active_first = await db_client.get("/api/stocks/search", params={"q": "60051"})
    assert prefix_active_first.status_code == 200
    assert [item["code"] for item in prefix_active_first.json()] == [
        "300750",
        "600510",
        "600519",
        "600518",
    ]

    # Name prefix match ranks before name substring match; search is case-insensitive.
    name_order = await db_client.get("/api/stocks/search", params={"q": "茅台"})
    assert name_order.status_code == 200
    assert [item["code"] for item in name_order.json()] == ["000002", "600519"]

    case_insensitive = await db_client.get("/api/stocks/search", params={"q": "st"})
    assert case_insensitive.status_code == 200
    assert [item["code"] for item in case_insensitive.json()] == ["600518"]

    # Wildcard characters '%' and '_' are escaped and match only literals.
    pct_search = await db_client.get("/api/stocks/search", params={"q": "%"})
    assert pct_search.status_code == 200
    assert [item["code"] for item in pct_search.json()] == ["920001"]

    underscore_search = await db_client.get("/api/stocks/search", params={"q": "_"})
    assert underscore_search.status_code == 200
    assert [item["code"] for item in underscore_search.json()] == ["920001"]

    backslash_search = await db_client.get("/api/stocks/search", params={"q": "\\"})
    assert backslash_search.status_code == 200
    assert backslash_search.json() == []

    # Limit parameter bounds result size.
    limited = await db_client.get("/api/stocks/search", params={"q": "600", "limit": 2})
    assert limited.status_code == 200
    assert [item["code"] for item in limited.json()] == ["300750", "600510"]

    # Whitespace-only query returns empty list via trim guard.
    whitespace = await db_client.get("/api/stocks/search", params={"q": "   "})
    assert whitespace.status_code == 200
    assert whitespace.json() == []


async def test_stock_search_prioritizes_synced_snapshots(db_client: AsyncClient) -> None:
    await _seed_stocks(
        [
            StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
            StockMetaRecord(code="600036", name="招商银行", exchange="SH"),
            StockMetaRecord(code="600030", name="银行指数", exchange="SH"),
            StockMetaRecord(code="601398", name="工商银行", exchange="SH", is_active=False),
        ],
        snapshot_codes={"600036", "601398"},
    )

    resp = await db_client.get("/api/stocks/search", params={"q": "银行"})
    assert resp.status_code == 200
    items = resp.json()
    assert [item["code"] for item in items] == ["600030", "600036", "000001", "601398"]
    assert items[1]["code"] == "600036"
    assert items[1]["snapshot_available"] is True
    assert items[2]["code"] == "000001"
    assert items[2]["snapshot_available"] is False


async def test_stock_search_validation_and_detail(db_client: AsyncClient) -> None:
    await _seed_stocks(
        [
            StockMetaRecord(
                code="600519",
                name="贵州茅台",
                exchange="SH",
                industry_sw1="食品饮料",
                industry_sw2="白酒",
                list_date=date(2001, 8, 27),
            ),
            StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
        ],
        snapshot_codes={"600519"},
    )

    assert (await db_client.get("/api/stocks/search")).status_code == 422
    assert (await db_client.get("/api/stocks/search", params={"q": ""})).status_code == 422
    assert (await db_client.get("/api/stocks/search", params={"q": "a" * 65})).status_code == 422
    assert (await db_client.get("/api/stocks/search", params={"q": "茅\x00台"})).status_code == 422
    assert (
        await db_client.get("/api/stocks/search", params={"q": "600519", "limit": 0})
    ).status_code == 422
    assert (
        await db_client.get("/api/stocks/search", params={"q": "600519", "limit": 21})
    ).status_code == 422

    detail_with_snap = await db_client.get("/api/stocks/600519")
    assert detail_with_snap.status_code == 200
    body = detail_with_snap.json()
    assert body == {
        "code": "600519",
        "name": "贵州茅台",
        "exchange": "SH",
        "industry_sw1": "食品饮料",
        "industry_sw2": "白酒",
        "list_date": "2001-08-27",
        "is_st": False,
        "is_active": True,
        "snapshot_available": True,
    }

    detail_no_snap = await db_client.get("/api/stocks/000001")
    assert detail_no_snap.status_code == 200
    assert detail_no_snap.json()["snapshot_available"] is False

    # Search includes accurate snapshot_available flag without changing ordering.
    search_resp = await db_client.get("/api/stocks/search", params={"q": "0"})
    assert search_resp.status_code == 200
    search_by_code = {item["code"]: item["snapshot_available"] for item in search_resp.json()}
    assert search_by_code == {"000001": False, "600519": True}

    assert (await db_client.get("/api/stocks/999999")).status_code == 404
    assert (await db_client.get("/api/stocks/abc")).status_code == 422
    assert (await db_client.get("/api/stocks/60051")).status_code == 422
    assert (await db_client.get("/api/stocks/６００５１９")).status_code == 422

    # Ensure repository search clamps out-of-range limit safely even outside FastAPI Query.
    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        session_maker = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with session_maker() as session:
            repo = PostgresStockMetaRepository(session)
            assert len(await repo.search("0", limit=0)) == 1
            assert len(await repo.search("0", limit=100)) == 2
    finally:
        await engine.dispose()


async def test_stocks_return_503_when_db_unavailable() -> None:
    class _BrokenStockRepo:
        async def upsert_many(self, items: object) -> int:
            raise DatabaseUnavailableError("OperationalError")

        async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
            raise DatabaseUnavailableError("OperationalError")

        async def get_detail(self, code: str) -> StockDetail | None:
            raise DatabaseUnavailableError("OperationalError")

        async def get_name(self, code: str) -> str | None:
            raise DatabaseUnavailableError("OperationalError")

    class _BrokenSnapshotRepo:
        async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
            raise DatabaseUnavailableError("OperationalError")

        async def get_snapshots_for_compare(self, codes: object) -> dict[str, StockSnapshotPayload]:
            raise DatabaseUnavailableError("OperationalError")

        async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
            raise DatabaseUnavailableError("OperationalError")

        async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
            raise DatabaseUnavailableError("OperationalError")

    app = create_app()
    app.dependency_overrides[get_stock_service] = lambda: StockService(
        _BrokenStockRepo(), _BrokenSnapshotRepo()
    )
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            search_resp = await client.get("/api/stocks/search", params={"q": "600519"})
            assert search_resp.status_code == 503
            assert "数据库不可用" in search_resp.json()["detail"]

            detail_resp = await client.get("/api/stocks/600519")
            assert detail_resp.status_code == 503
            assert "数据库不可用" in detail_resp.json()["detail"]

            screener_resp = await client.get("/api/stocks/screener")
            assert screener_resp.status_code == 503
            assert "数据库不可用" in screener_resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()


async def test_stock_screener_api_resilience_filtering_and_sorting(
    db_client: AsyncClient,
) -> None:
    as_of = date(2026, 11, 20)

    def _build_snap(
        meta: StockMetaRecord,
        *,
        pe_history: list[float],
        latest_pe: float | None,
        profit: float,
        div_total: float,
        short_loan: float = 0.0,
        monetary_funds: float = 40e8,
        total_mv: float = 1000e8,
    ) -> StockSnapshotPayload:
        bars = [
            StockDailyBar(
                code=meta.code,
                trade_date=date(2021 + idx, 11, 20) if idx < len(pe_history) else as_of,
                open=20.0,
                high=20.0,
                low=20.0,
                close=20.0,
                total_mv_yuan=total_mv,
                pe_ttm=pe_val,
                pb=1.2,
            )
            for idx, pe_val in enumerate(
                [*pe_history, latest_pe] if latest_pe is not None else pe_history
            )
        ]
        reports = [
            StockAnnualReport(
                code=meta.code,
                report_year=y,
                report_date=date(y, 12, 31),
                audit_opinion="标准无保留意见",
                revenue_yuan=100e8,
                operate_cost_yuan=None if meta.industry_sw1 == "银行" else 40e8,
                net_profit_yuan=profit,
                deduct_net_profit_yuan=profit,
                total_assets_yuan=200e8,
                total_equity_yuan=100e8,
                parent_equity_yuan=100e8,
                monetary_funds_yuan=monetary_funds,
                short_loan_yuan=short_loan,
                long_loan_yuan=0.0,
                cip_yuan=0.0,
                fixed_asset_yuan=20e8,
                accounts_receivable_yuan=5e8,
                inventory_yuan=5e8,
                goodwill_yuan=0.0,
                ocf_yuan=-200e8 if meta.industry_sw1 == "银行" else profit * 1.1,
                capex_yuan=2e8,
            )
            for y in range(2021, 2026)
        ]
        dividends = (
            [
                StockDividendRecord(
                    code=meta.code,
                    report_date=date(2025, 12, 31),
                    report_year=2025,
                    plan_progress="实施分配",
                    cash_per_10_shares=5.0,
                    total_shares=10e8,
                    dividend_cash_total_yuan=div_total,
                )
            ]
            if div_total > 0
            else []
        )
        bundle = StockFactBundle(
            code=meta.code,
            as_of=as_of,
            data_source="akshare",
            daily_bars=bars,
            annual_reports=reports,
            dividends=dividends,
            repurchases=[],
            pledge=StockPledgeSnapshot(code=meta.code, trade_date=as_of, pledge_ratio_pct=1.0),
            equity_financings=[],
        )
        return build_stock_snapshot(
            meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
        )

    meta_600519 = StockMetaRecord(
        code="600519", name="贵州茅台", exchange="SH", industry_sw1="食品饮料"
    )
    meta_600036 = StockMetaRecord(
        code="600036", name="招商银行", exchange="SH", industry_sw1="银行"
    )
    meta_000999 = StockMetaRecord(
        code="000999", name="高债样本", exchange="SZ", industry_sw1="医药生物"
    )
    await _seed_stocks([meta_600519, meta_600036, meta_000999])

    snaps = [
        _build_snap(
            meta_600519,
            pe_history=[25.0, 30.0, 35.0, 40.0],
            latest_pe=20.0,
            profit=30e8,
            div_total=40e8,
        ),
        _build_snap(
            meta_600036,
            pe_history=[6.0, 7.0, 8.0, 9.0],
            latest_pe=5.5,
            profit=20e8,
            div_total=55e8,
            short_loan=120e8,
            monetary_funds=80e8,
        ),
        _build_snap(
            meta_000999,
            pe_history=[],
            latest_pe=None,
            profit=10e8,
            div_total=0.0,
            short_loan=120e8,
            monetary_funds=80e8,
        ),
    ]

    assert settings.test_database_url is not None
    engine = create_async_engine(settings.test_database_url)
    try:
        async with engine.begin() as conn:
            for snap in snaps:
                snap_payload = snap.model_dump(mode="json")
                snap_code = snap.code
                await conn.run_sync(
                    lambda sync_conn, payload=snap_payload, code=snap_code: sync_conn.execute(
                        StockSnapshot.__table__.insert().values(
                            code=code,
                            as_of=as_of,
                            payload=payload,
                        )
                    )
                )
            # Insert an incomplete stub payload that list_all_snapshots must gracefully skip.
            await conn.run_sync(
                lambda sync_conn: sync_conn.execute(
                    StockSnapshot.__table__.insert().values(
                        code="999999",
                        as_of=as_of,
                        payload={"code": "999999"},
                    )
                )
            )
    finally:
        await engine.dispose()

    base_resp = await db_client.get("/api/stocks/screener")
    assert base_resp.status_code == 200
    body = base_resp.json()
    assert body["total_synced"] == 3
    assert body["filtered_count"] == 3
    assert body["industries"] == ["医药生物", "银行", "食品饮料"]
    items_by_code = {item["code"]: item for item in body["items"]}
    assert items_by_code["600036"]["is_financial"] is True
    assert items_by_code["600036"]["ct_red_count"] == 0
    assert items_by_code["000999"]["ct_red_count"] >= 1

    filtered = await db_client.get(
        "/api/stocks/screener",
        params={"zero_red_only": True, "min_dividend_yield": 5.0},
    )
    assert filtered.status_code == 200
    assert [item["code"] for item in filtered.json()["items"]] == ["600036"]

    pe_asc = await db_client.get(
        "/api/stocks/screener",
        params={"sort_by": "pe_ttm", "sort_dir": "asc"},
    )
    assert pe_asc.status_code == 200
    assert [item["code"] for item in pe_asc.json()["items"]] == ["600036", "600519", "000999"]

    pe_desc = await db_client.get(
        "/api/stocks/screener",
        params={"sort_by": "pe_ttm", "sort_dir": "desc"},
    )
    assert pe_desc.status_code == 200
    assert [item["code"] for item in pe_desc.json()["items"]] == ["600519", "600036", "000999"]

    # Query parameter validation boundaries.
    assert (
        await db_client.get("/api/stocks/screener", params={"max_pe_percentile": 101})
    ).status_code == 422
    assert (
        await db_client.get("/api/stocks/screener", params={"max_pe_percentile": -1})
    ).status_code == 422
    assert (await db_client.get("/api/stocks/screener", params={"limit": 0})).status_code == 422
    assert (await db_client.get("/api/stocks/screener", params={"limit": 201})).status_code == 422
    assert (await db_client.get("/api/stocks/screener", params={"q": "x" * 65})).status_code == 422
    assert (
        await db_client.get("/api/stocks/screener", params={"q": "茅\x00台"})
    ).status_code == 422
    assert (
        await db_client.get("/api/stocks/screener", params={"industry": "银\x00行"})
    ).status_code == 422
    assert (
        await db_client.get("/api/stocks/screener", params={"sort_by": "unknown"})
    ).status_code == 422
