from __future__ import annotations

from datetime import date

from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.adapters.postgres.market import PostgresStockMetaRepository
from app.api.deps import get_stock_service
from app.db.models import StockMeta, StockSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.models import StockDetail, StockMetaRecord
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

    assert (await db_client.get("/api/stocks/999999")).status_code == 404
    assert (await db_client.get("/api/stocks/abc")).status_code == 422
    assert (await db_client.get("/api/stocks/60051")).status_code == 422

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

    app = create_app()
    app.dependency_overrides[get_stock_service] = lambda: StockService(_BrokenStockRepo())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            search_resp = await client.get("/api/stocks/search", params={"q": "600519"})
            assert search_resp.status_code == 503
            assert "数据库不可用" in search_resp.json()["detail"]

            detail_resp = await client.get("/api/stocks/600519")
            assert detail_resp.status_code == 503
            assert "数据库不可用" in detail_resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()
