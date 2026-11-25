"""Tests for Stage 3 cross-asset telemetry, live value discovery board, and screener filters."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime, timedelta

import akshare as ak
import pandas as pd
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.akshare.market_feed import (
    AkshareMarketFeed,
    build_cross_asset_snapshot,
    parse_cross_asset_bonds,
)
from app.adapters.memory.market import MemoryMarketRepository, default_market_overview
from app.adapters.postgres.market import PostgresMarketRepository, PostgresStockMetaRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.api.deps import get_db, get_market_service
from app.db.base import Base
from app.db.session import DatabaseUnavailableError
from app.domain.engines import build_market_discovery_board, build_stock_snapshot
from app.domain.models import (
    CrossAssetMacroSnapshot,
    IndexQuote,
    IndustryFlow,
    MarketOverview,
    MarketTemperature,
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockSnapshotPayload,
    StyleRegimeIndex,
    TemperatureLevel,
)
from app.main import create_app
from app.services.market import MarketService
from app.settings import settings


def _make_bond_series(
    *,
    as_of: date = date(2026, 11, 20),
    us_2y_latest: float = 4.10,
    us_2y_20d_ago: float = 4.40,
    us_10y_latest: float = 4.25,
    us_10y_20d_ago: float = 4.35,
    cn_10y_latest: float = 1.58,
    include_beijing_nan_us_row: bool = True,
) -> pd.DataFrame:
    # Build 25 trading days of US bond history ending on as_of - 1 (Beijing closes before US close).
    rows: list[dict[str, object]] = []
    us_end = as_of - timedelta(days=1) if include_beijing_nan_us_row else as_of
    for i in range(25):
        d = us_end - timedelta(days=24 - i)
        # Index 4 corresponds to 20 trading steps before index 24.
        t = max(0.0, min(1.0, (i - 4) / 20.0))
        u2 = us_2y_20d_ago + (us_2y_latest - us_2y_20d_ago) * t
        u10 = us_10y_20d_ago + (us_10y_latest - us_10y_20d_ago) * t
        rows.append(
            {
                "日期": d,
                "中国国债收益率10年": cn_10y_latest + (24 - i) * 0.005,
                "美国国债收益率2年": u2,
                "美国国债收益率10年": u10,
                "美国国债收益率10年-2年": u10 - u2,
            }
        )
    if include_beijing_nan_us_row:
        rows.append(
            {
                "日期": as_of,
                "中国国债收益率10年": cn_10y_latest,
                "美国国债收益率2年": float("nan"),
                "美国国债收益率10年": float("nan"),
                "美国国债收益率10年-2年": float("nan"),
            }
        )
    return pd.DataFrame(rows)


def _make_daily_df(
    end_date: date,
    closes: Sequence[float],
) -> pd.DataFrame:
    n = len(closes)
    return pd.DataFrame(
        {
            "date": [end_date - timedelta(days=n - 1 - i) for i in range(n)],
            "open": list(closes),
            "high": list(closes),
            "low": list(closes),
            "close": list(closes),
        }
    )


def _build_test_snapshot(
    *,
    code: str,
    name: str,
    industry_sw1: str,
    industry_sw2: str | None = None,
    pe_history: Sequence[float] = (14.0, 16.0, 18.0, 22.0, 26.0),
    latest_pe: float = 12.0,
    latest_pb: float = 1.5,
    total_mv: float = 1000e8,
    dividend_total: float = 45e8,
    revenue: float = 100e8,
    operate_profit: float | None = 30e8,
    invest_income: float = 1e8,
    fair_value_change: float = 0.0,
    other_income: float = 0.2e8,
    net_profit: float = 22e8,
    deduct_net_profit: float = 21e8,
    ocf: float = 26e8,
    capex: float = 3e8,
    monetary_funds: float = 400e8,
    long_equity_invest: float = 1e8,
    short_loan: float = 0.0,
) -> StockSnapshotPayload:
    as_of = date(2026, 11, 20)
    exchange = "SH" if code.startswith(("60", "68")) else "SZ"
    meta = StockMetaRecord(
        code=code,
        name=name,
        exchange=exchange,  # type: ignore[arg-type]
        industry_sw1=industry_sw1,
        industry_sw2=industry_sw2,
    )
    bars = [
        StockDailyBar(
            code=code,
            trade_date=date(2021 + idx, 11, 20) if idx < len(pe_history) else as_of,
            open=20.0,
            high=20.0,
            low=20.0,
            close=20.0,
            total_mv_yuan=total_mv,
            pe_ttm=pe_val,
            pb=latest_pb,
        )
        for idx, pe_val in enumerate([*pe_history, latest_pe])
    ]
    reports = [
        StockAnnualReport(
            code=code,
            report_year=y,
            report_date=date(y, 12, 31),
            audit_opinion="标准无保留意见",
            revenue_yuan=revenue,
            operate_cost_yuan=None if industry_sw1 == "银行" else revenue * 0.5,
            operate_profit_yuan=operate_profit,
            invest_income_yuan=invest_income,
            fair_value_change_yuan=fair_value_change,
            other_income_yuan=other_income,
            net_profit_yuan=net_profit,
            deduct_net_profit_yuan=deduct_net_profit,
            total_assets_yuan=800e8,
            total_equity_yuan=150e8,
            parent_equity_yuan=150e8,
            monetary_funds_yuan=monetary_funds,
            long_equity_invest_yuan=long_equity_invest,
            short_loan_yuan=short_loan,
            long_loan_yuan=0.0,
            cip_yuan=1e8,
            fixed_asset_yuan=20e8,
            accounts_receivable_yuan=5e8,
            note_accounts_rece_yuan=5e8,
            inventory_yuan=5e8,
            goodwill_yuan=0.0,
            ocf_yuan=-100e8 if industry_sw1 == "银行" else ocf,
            capex_yuan=capex,
        )
        for y in range(2021, 2026)
    ]
    dividends = (
        [
            StockDividendRecord(
                code=code,
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=5.0,
                total_shares=10e8,
                dividend_cash_total_yuan=dividend_total,
            )
        ]
        if dividend_total > 0
        else []
    )
    bundle = StockFactBundle(
        code=code,
        as_of=as_of,
        daily_bars=bars,
        annual_reports=reports,
        dividends=dividends,
        repurchases=[],
        pledge=StockPledgeSnapshot(code=code, trade_date=as_of, pledge_ratio_pct=1.0),
        equity_financings=[],
    )
    return build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )


def test_parse_cross_asset_bonds_handles_beijing_close_nan_and_20d_bps() -> None:
    as_of = date(2026, 11, 20)
    bond_df = _make_bond_series(
        as_of=as_of,
        us_2y_latest=4.10,
        us_2y_20d_ago=4.40,
        us_10y_latest=4.25,
        us_10y_20d_ago=4.35,
        cn_10y_latest=1.58,
        include_beijing_nan_us_row=True,
    )
    bonds = parse_cross_asset_bonds(bond_df, as_of=as_of)
    assert bonds["us_bond_as_of"] == date(2026, 11, 19)
    assert bonds["us_2y_yield"] == pytest.approx(4.10)
    assert bonds["us_10y_yield"] == pytest.approx(4.25)
    assert bonds["cn_10y_yield"] == pytest.approx(1.58)
    assert bonds["us_10y_2y_spread"] == pytest.approx(0.15)
    assert bonds["us_cn_10y_spread"] == pytest.approx(2.67)
    assert bonds["us_2y_change_20d_bps"] == pytest.approx(-30.0)
    assert bonds["us_10y_change_20d_bps"] == pytest.approx(-10.0)

    cpi_df = pd.DataFrame(
        [
            {"时间": date(2026, 9, 1), "发布日期": date(2026, 10, 14), "现值": 2.4},
            {"时间": date(2026, 10, 1), "发布日期": date(2026, 11, 13), "现值": 2.6},
            {"时间": date(2026, 11, 1), "发布日期": date(2026, 12, 11), "现值": 9.9},
        ]
    )
    gold_closes = [550.0 + i * 2.0 for i in range(60)]
    gold_df = _make_daily_df(as_of, gold_closes)
    etf_df = pd.DataFrame(
        [
            {"日期": date(2026, 11, 19), "总库存": 870.5, "增持/减持": 1.2},
            {"日期": date(2026, 11, 20), "总库存": 875.0, "增持/减持": 4.5},
        ]
    )
    style_frames = {
        "sh000688": _make_daily_df(as_of, [1200.0] * 40 + [1020.0] * 20),
        "sh000015": _make_daily_df(as_of, [3000.0] * 40 + [3090.0] * 20),
        ".IXIC": _make_daily_df(as_of, [20000.0] * 40 + [18200.0] * 20),
    }

    macro = build_cross_asset_snapshot(
        bond_df=bond_df,
        as_of=as_of,
        cpi_df=cpi_df,
        gold_df=gold_df,
        gold_symbol="Au99.99",
        gold_etf_df=etf_df,
        style_frames=style_frames,
    )
    assert macro.us_cpi_yoy == pytest.approx(2.6)
    assert macro.us_real_yield_proxy_pct == pytest.approx(1.65)
    assert macro.gold_price_cny == pytest.approx(gold_closes[-1])
    assert macro.gold_percentile_1y == pytest.approx(99.2, abs=1.0)
    assert macro.gold_etf_tonnes == pytest.approx(875.0)
    assert macro.gold_etf_delta_tonnes == pytest.approx(4.5)
    by_style_code = {s.code: s for s in macro.style_indices}
    assert by_style_code["sh000688"].drawdown_60d_pct == pytest.approx(-15.0)
    assert by_style_code["sh000015"].change_20d_pct == pytest.approx(3.0)
    assert by_style_code[".IXIC"].drawdown_60d_pct == pytest.approx(-9.0)


async def test_akshare_market_feed_cross_asset_degrades_gracefully_on_aux_outages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    as_of = date(2026, 11, 20)
    monkeypatch.setattr(
        ak,
        "calendar_trade_date_hist_sina",
        lambda: pd.DataFrame({"trade_date": [date(2026, 11, 19), as_of]}),
    )
    monkeypatch.setattr(
        ak,
        "stock_info_a_code_name",
        lambda: pd.DataFrame({"code": ["600519"], "name": ["贵州茅台"]}),
    )
    monkeypatch.setattr(
        ak,
        "index_zh_spot_sina",
        lambda: pd.DataFrame(
            {
                "代码": ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300"],
                "名称": ["上证指数", "深证成指", "创业板指", "科创50", "沪深300"],
                "最新价": [3350.0, 10820.0, 2240.0, 1015.0, 3980.0],
                "涨跌幅": [0.4, 0.8, -0.5, -1.2, 0.3],
            }
        ),
    )
    monkeypatch.setattr(
        ak,
        "stock_a_ttm_lyr",
        lambda: pd.DataFrame({"date": [as_of], "middlePETTM": [24.0]}),
    )
    monkeypatch.setattr(
        ak,
        "bond_zh_us_yield_em",
        lambda **_kwargs: _make_bond_series(as_of=as_of),
    )
    monkeypatch.setattr(
        ak,
        "stock_fund_flow_industry_ths",
        lambda **_kwargs: pd.DataFrame(
            {
                "行业": ["半导体", "银行"],
                "行业-涨跌幅": [-1.8, 0.6],
                "净额": [-22.0, 12.0],
                "公司家数": [160, 42],
            }
        ),
    )
    # Fail CPI, SGE spot (triggering AU0 fallback), ETF, and Nasdaq; keep A-share style indices.
    monkeypatch.setattr(
        ak, "macro_usa_cpi_yoy", lambda: (_ for _ in ()).throw(RuntimeError("cpi down"))
    )
    monkeypatch.setattr(
        ak, "spot_hist_sge", lambda **_kwargs: (_ for _ in ()).throw(TimeoutError("sge timeout"))
    )
    monkeypatch.setattr(
        ak,
        "futures_zh_daily_sina",
        lambda **_kwargs: _make_daily_df(as_of, [590.0 + i for i in range(25)]),
    )
    monkeypatch.setattr(
        ak,
        "fund_gold_etf_holding_js",
        lambda: (_ for _ in ()).throw(RuntimeError("jin10 blocked")),
    )
    monkeypatch.setattr(
        ak,
        "index_zh_daily_sina",
        lambda symbol="sh000688": _make_daily_df(as_of, [1000.0] * 25),
    )
    monkeypatch.setattr(
        ak,
        "index_us_daily_sina",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("us v8 error")),
    )

    feed = AkshareMarketFeed(timeout_seconds=5.0, max_attempts=1, retry_wait_seconds=0.0)
    bundle = await feed.fetch_market_bundle(as_of=as_of)
    assert bundle.as_of == as_of
    assert bundle.cross_asset is not None
    assert bundle.cross_asset.us_2y_yield == pytest.approx(4.10)
    assert bundle.cross_asset.gold_symbol == "AU0"
    assert bundle.cross_asset.gold_price_cny == pytest.approx(614.0)
    assert bundle.cross_asset.us_cpi_yoy is None
    assert bundle.cross_asset.gold_etf_tonnes is None
    assert len(bundle.cross_asset.style_indices) == 4
    assert any("美国 CPI 通胀数据" in w for w in bundle.cross_asset.warnings)
    assert any("上海金交所现货数据" in w for w in bundle.cross_asset.warnings)
    assert any("黄金 ETF 持仓数据" in w for w in bundle.cross_asset.warnings)
    assert any("部分跨市场风格指数" in w for w in bundle.cross_asset.warnings)
    joined_warnings = " ".join(bundle.cross_asset.warnings)
    for internal_name in (
        "macro_usa_cpi_yoy",
        "spot_hist_sge",
        "fund_gold_etf_holding_js",
        "index_us_daily_sina",
        "index_zh_daily_sina",
    ):
        assert internal_name not in joined_warnings


def test_discovery_board_regime_rules_and_candidate_buckets() -> None:
    as_of = date(2026, 11, 20)
    overview = MarketOverview(
        as_of=as_of,
        data_source="akshare",
        generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
        indices=[
            IndexQuote(code="000001", name="上证指数", price=3350.0, change_pct=0.2),
            IndexQuote(code="000688", name="科创50", price=980.0, change_pct=-2.1),
        ],
        temperature=MarketTemperature(
            score=32.0,
            level=TemperatureLevel.COOL,
            pe_median=23.0,
            pe_percentile=28.0,
            bond_yield=1.60,
            equity_bond_spread=2.75,
            comment="偏低区间",
        ),
        hot_industries=[
            IndustryFlow(name="银行", change_pct=0.8, net_inflow=15e8, companies=42),
            IndustryFlow(name="半导体", change_pct=-2.3, net_inflow=-28e8, companies=160),
        ],
        cross_asset=CrossAssetMacroSnapshot(
            as_of=as_of,
            us_bond_as_of=date(2026, 11, 19),
            us_2y_yield=4.05,
            us_10y_yield=4.20,
            cn_10y_yield=1.60,
            us_2y_change_20d_bps=-25.0,
            us_cpi_yoy=3.1,
            us_real_yield_proxy_pct=1.10,
            gold_price_cny=620.0,
            gold_symbol="Au99.99",
            gold_percentile_1y=72.0,
            gold_etf_tonnes=880.0,
            gold_etf_delta_tonnes=3.2,
            style_indices=[
                StyleRegimeIndex(
                    code="sh000688",
                    name="科创50",
                    market="A",
                    style="tech",
                    as_of=as_of,
                    close=980.0,
                    change_1d_pct=-2.1,
                    change_5d_pct=-5.2,
                    change_20d_pct=-9.5,
                    drawdown_60d_pct=-14.0,
                ),
                StyleRegimeIndex(
                    code="sh000015",
                    name="上证红利",
                    market="A",
                    style="dividend",
                    as_of=as_of,
                    close=3120.0,
                    change_1d_pct=0.5,
                    change_5d_pct=1.4,
                    change_20d_pct=2.5,
                    drawdown_60d_pct=-1.8,
                ),
                StyleRegimeIndex(
                    code=".IXIC",
                    name="纳斯达克",
                    market="US",
                    style="tech",
                    as_of=date(2026, 11, 19),
                    close=18500.0,
                    change_1d_pct=-1.2,
                    change_5d_pct=-4.0,
                    change_20d_pct=-6.0,
                    drawdown_60d_pct=-9.5,
                ),
            ],
        ),
    )

    snap_shenhua = _build_test_snapshot(
        code="601088",
        name="中国神华",
        industry_sw1="煤炭",
        latest_pe=10.5,
        pe_history=[9.0, 11.0, 12.0, 14.0, 16.0],
        dividend_total=52e8,
        total_mv=1000e8,
        monetary_funds=450e8,
    )
    snap_bank = _build_test_snapshot(
        code="601398",
        name="工商银行",
        industry_sw1="银行",
        latest_pe=5.5,
        latest_pb=0.65,
        dividend_total=56e8,
        total_mv=1000e8,
        short_loan=200e8,
    )
    snap_gold = _build_test_snapshot(
        code="600547",
        name="山东黄金",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        latest_pe=22.0,
        dividend_total=10e8,
    )
    snap_invest = _build_test_snapshot(
        code="600177",
        name="雅戈尔样本",
        industry_sw1="纺织服饰",
        operate_profit=20e8,
        invest_income=21e8,
        fair_value_change=3e8,
        net_profit=18e8,
        deduct_net_profit=17e8,
        ocf=8e8,
        long_equity_invest=350e8,
        dividend_total=60e8,
    )

    board = build_market_discovery_board(
        overview, [snap_shenhua, snap_bank, snap_gold, snap_invest]
    )
    themes_by_id = {t.theme_id: t for t in board.themes}

    gold_theme = themes_by_id["gold_fed_cycle"]
    assert gold_theme.signal == "green"
    assert gold_theme.verdict == "宽松酝酿·赔率占优"
    assert [p.code for p in gold_theme.picks] == ["600547"]

    div_theme = themes_by_id["tech_vs_dividend_rotation"]
    assert div_theme.signal == "green"
    assert "红利" in div_theme.verdict
    assert [p.code for p in div_theme.picks] == ["601088", "601398"]
    assert all((p.dividend_spread_over_bond_pct or 0.0) >= 2.0 for p in div_theme.picks)

    eq_theme = themes_by_id["earnings_quality_radar"]
    assert "601088" in [p.code for p in eq_theme.picks]
    assert [p.code for p in eq_theme.caution_picks] == ["600177"]

    assert "601088" in [p.code for p in board.candidate_buckets.deep_value]
    assert "600177" not in [p.code for p in board.candidate_buckets.deep_value]

    restrictive_overview = overview.model_copy(
        update={
            "cross_asset": overview.cross_asset.model_copy(
                update={
                    "us_2y_change_20d_bps": 22.0,
                    "us_real_yield_proxy_pct": 2.35,
                    "gold_etf_delta_tonnes": -2.0,
                }
            )
        }
    )
    restrictive_board = build_market_discovery_board(restrictive_overview, [snap_gold])
    assert restrictive_board.themes[0].signal == "red"
    assert restrictive_board.themes[0].verdict == "高实际利率压制"

    # Non-financial investment-heavy stock with high FCF coverage and low PE stays only in cautions.
    snap_sneaky_inv = _build_test_snapshot(
        code="600179",
        name="隐蔽投资样本",
        industry_sw1="纺织服饰",
        latest_pe=8.0,
        pe_history=[12.0, 14.0, 16.0, 18.0, 20.0],
        operate_profit=20e8,
        invest_income=8e8,
        net_profit=16e8,
        deduct_net_profit=15e8,
        ocf=30e8,
        capex=2e8,
        long_equity_invest=400e8,
        dividend_total=25e8,
        total_mv=500e8,
    )
    anchor_overview = overview.model_copy(
        update={
            "cross_asset": overview.cross_asset.model_copy(
                update={"cn_10y_yield": 1.45, "style_indices": []}
            )
        }
    )
    anchor_board = build_market_discovery_board(anchor_overview, [snap_bank, snap_sneaky_inv])
    assert "600179" in [p.code for p in anchor_board.candidate_buckets.investment_cautions]
    assert "600179" not in [p.code for p in anchor_board.candidate_buckets.dividend_fortresses]
    assert "600179" not in [p.code for p in anchor_board.candidate_buckets.deep_value]
    div_theme_empty = next(
        t for t in anchor_board.themes if t.theme_id == "tech_vs_dividend_rotation"
    )
    assert "1.45%" in div_theme_empty.regime_summary
    assert "—" not in div_theme_empty.regime_summary
    assert snap_bank.peer_metrics.is_financial is True
    assert snap_sneaky_inv.peer_metrics.is_financial is False


async def test_market_discovery_api_and_screener_quality_filters() -> None:
    snap_cow = _build_test_snapshot(
        code="600900",
        name="长江电力",
        industry_sw1="公用事业",
        dividend_total=42e8,
        total_mv=1000e8,
    )
    snap_bank = _build_test_snapshot(
        code="601398",
        name="工商银行",
        industry_sw1="银行",
        dividend_total=52e8,
        total_mv=1000e8,
    )
    snap_inv = _build_test_snapshot(
        code="600177",
        name="雅戈尔样本",
        industry_sw1="纺织服饰",
        operate_profit=20e8,
        invest_income=22e8,
        net_profit=18e8,
        deduct_net_profit=17e8,
        ocf=8e8,
        long_equity_invest=350e8,
        dividend_total=60e8,
    )
    snap_gold = _build_test_snapshot(
        code="600547",
        name="山东黄金",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        dividend_total=10e8,
    )

    class _MemSnapRepo:
        def __init__(self, rows: list[StockSnapshotPayload]) -> None:
            self._rows = rows

        async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
            return next((r for r in self._rows if r.code == code), None)

        async def get_snapshots_for_compare(
            self, codes: Sequence[str]
        ) -> dict[str, StockSnapshotPayload]:
            return {r.code: r for r in self._rows if r.code in codes}

        async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
            return list(self._rows)

        async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
            return None

    service = MarketService(
        MemoryMarketRepository(default_market_overview()),
        _MemSnapRepo([snap_cow, snap_bank, snap_inv, snap_gold]),
    )
    app = create_app()
    app.dependency_overrides[get_market_service] = lambda: service
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/market/discovery")
            assert resp.status_code == 200
            body = resp.json()
            assert body["synced_stock_count"] == 4
            assert len(body["themes"]) == 4
            buckets = body["candidate_buckets"]
            assert [p["code"] for p in buckets["gold_resources"]] == ["600547"]
            assert [p["code"] for p in buckets["investment_cautions"]] == ["600177"]
            assert {p["code"] for p in buckets["dividend_fortresses"]} == {"600900", "601398"}
    finally:
        app.dependency_overrides.clear()

    # 503 when market snapshot missing or DB unavailable
    broken_app = create_app()
    broken_app.dependency_overrides[get_market_service] = lambda: MarketService(
        MemoryMarketRepository(allow_missing=True)
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=broken_app), base_url="http://test"
        ) as client:
            assert (await client.get("/api/market/discovery")).status_code == 503
    finally:
        broken_app.dependency_overrides.clear()

    class _BrokenMarketRepo:
        async def overview(self) -> MarketOverview:
            raise DatabaseUnavailableError("OperationalError")

        async def save_overview(self, snapshot: MarketOverview) -> None:
            raise DatabaseUnavailableError("OperationalError")

    db_err_app = create_app()
    db_err_app.dependency_overrides[get_market_service] = lambda: MarketService(_BrokenMarketRepo())
    try:
        async with AsyncClient(
            transport=ASGITransport(app=db_err_app), base_url="http://test"
        ) as client:
            assert (await client.get("/api/market/discovery")).status_code == 503
    finally:
        db_err_app.dependency_overrides.clear()

    # PG end-to-end test for /api/market/discovery & /api/stocks/screener?quality_filter=...
    if not settings.test_database_url:
        return

    engine = create_async_engine(settings.test_database_url)
    pg_app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        pg_app.dependency_overrides[get_db] = override_get_db

        async with testing_session() as session:
            await PostgresMarketRepository(session).save_overview(default_market_overview())
            await PostgresStockMetaRepository(session).upsert_many(
                [
                    StockMetaRecord(
                        code="600900", name="长江电力", exchange="SH", industry_sw1="公用事业"
                    ),
                    StockMetaRecord(
                        code="601398", name="工商银行", exchange="SH", industry_sw1="银行"
                    ),
                    StockMetaRecord(
                        code="600177", name="雅戈尔样本", exchange="SH", industry_sw1="纺织服饰"
                    ),
                ]
            )
            snap_repo = PostgresStockSnapshotRepository(session)
            for s in (snap_cow, snap_bank, snap_inv):
                await snap_repo.save_snapshot(s)

        async with AsyncClient(
            transport=ASGITransport(app=pg_app), base_url="http://test"
        ) as client:
            disc = await client.get("/api/market/discovery")
            assert disc.status_code == 200
            assert disc.json()["synced_stock_count"] == 3

            core_only = await client.get(
                "/api/stocks/screener", params={"quality_filter": "core_only"}
            )
            assert core_only.status_code == 200
            assert [i["code"] for i in core_only.json()["items"]] == ["600900"]

            hide_inv = await client.get(
                "/api/stocks/screener", params={"quality_filter": "hide_investment_heavy"}
            )
            assert hide_inv.status_code == 200
            assert {i["code"] for i in hide_inv.json()["items"]} == {"600900", "601398"}

            # Verify bank exemption even when invest_profit_share_3y_pct >= 30% on financial stocks.
            bank_heavy_inv = snap_bank.model_copy(
                update={
                    "forensics": snap_bank.forensics.model_copy(
                        update={
                            "invest_profit_share_3y_pct": 42.0,
                            "investment_assets_ratio_pct": 55.0,
                        }
                    )
                    if snap_bank.forensics is not None
                    else None
                }
            )
            from app.domain.engines.screener import screen_snapshots

            screened_bank = screen_snapshots(
                [bank_heavy_inv, snap_inv], quality_filter="hide_investment_heavy"
            )
            assert [i.code for i in screened_bank.items] == ["601398"]
            assert (
                screen_snapshots(
                    [
                        snap_cow.model_copy(
                            update={
                                "financial_ct": snap_cow.financial_ct.model_copy(
                                    update={"red_count": 1}
                                )
                            }
                        )
                    ],
                    quality_filter="core_only",
                ).items
                == []
            )

            div_fort = await client.get(
                "/api/stocks/screener", params={"quality_filter": "dividend_fortress"}
            )
            assert div_fort.status_code == 200
            assert {i["code"] for i in div_fort.json()["items"]} == {"600900", "601398"}

            bad_qf = await client.get(
                "/api/stocks/screener", params={"quality_filter": "invalid_mode"}
            )
            assert bad_qf.status_code == 422
    finally:
        pg_app.dependency_overrides.clear()
        await engine.dispose()


def test_discovery_prioritizes_hydrated_forensics_and_quality_dividend_ranking() -> None:
    as_of = date(2026, 11, 20)
    overview = MarketOverview(
        as_of=as_of,
        data_source="akshare",
        generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
        indices=[IndexQuote(code="000001", name="上证指数", price=3350.0, change_pct=0.2)],
        temperature=MarketTemperature(
            score=35.0,
            level=TemperatureLevel.COOL,
            pe_median=22.0,
            pe_percentile=25.0,
            bond_yield=1.60,
            equity_bond_spread=2.80,
            comment="偏低区间",
        ),
        hot_industries=[],
        cross_asset=None,
    )

    def _strip_forensics(snap: StockSnapshotPayload) -> StockSnapshotPayload:
        return snap.model_copy(
            update={
                "forensics": None,
                "peer_metrics": snap.peer_metrics.model_copy(
                    update={
                        "earnings_quality_tag": None,
                        "earnings_quality_label": None,
                        "invest_profit_share_3y_pct": None,
                        "investment_assets_ratio_pct": None,
                    }
                ),
            }
        )

    hydrated_large = _build_test_snapshot(
        code="601088",
        name="中国神华",
        industry_sw1="煤炭",
        latest_pe=12.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=45e8,
        total_mv=1000e8,
        net_profit=22e8,
        ocf=26e8,
    )
    small_cap_spike = _build_test_snapshot(
        code="002001",
        name="小盘高息",
        industry_sw1="基础化工",
        latest_pe=15.0,
        pe_history=(10.0, 12.0, 14.0, 16.0, 18.0),
        dividend_total=14.4e8,
        total_mv=120e8,
        net_profit=20e8,
        ocf=24e8,
    )
    legacy_superior_raw = _strip_forensics(
        _build_test_snapshot(
            code="601225",
            name="遗留高息样本",
            industry_sw1="煤炭",
            latest_pe=8.0,
            pe_history=(12.0, 16.0, 20.0, 24.0, 28.0),
            dividend_total=70e8,
            total_mv=1000e8,
            net_profit=40e8,
            ocf=50e8,
            monetary_funds=500e8,
        )
    )
    hydrated_gold = _build_test_snapshot(
        code="600547",
        name="山东黄金",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        latest_pe=28.0,
        dividend_total=10e8,
        operate_profit=15e8,
        net_profit=12e8,
        ocf=14e8,
    )
    legacy_gold = _strip_forensics(
        _build_test_snapshot(
            code="600489",
            name="中金黄金",
            industry_sw1="有色金属",
            industry_sw2="黄金",
            latest_pe=10.0,
            dividend_total=20e8,
            net_profit=35e8,
            ocf=42e8,
        )
    )

    board = build_market_discovery_board(
        overview,
        [legacy_superior_raw, small_cap_spike, hydrated_large, legacy_gold, hydrated_gold],
    )
    buckets = board.candidate_buckets
    assert [p.code for p in buckets.dividend_fortresses] == ["601088", "002001", "601225"]
    assert [p.code for p in buckets.gold_resources] == ["600547", "600489"]
    assert [p.code for p in buckets.core_cash_cows] == [
        "601088",
        "600547",
        "002001",
        "601225",
        "600489",
    ]
    dv_codes = [p.code for p in buckets.deep_value]
    assert set(dv_codes) == {"601088", "002001", "600547", "601225", "600489"}
    assert [c in {"601225", "600489"} for c in dv_codes] == [False, False, False, True, True]


def test_discovery_st_mv_tenure_leveraged_filters_and_legacy_caution_formatting() -> None:
    as_of = date(2026, 11, 20)
    overview = MarketOverview(
        as_of=as_of,
        data_source="akshare",
        generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
        indices=[IndexQuote(code="000001", name="上证指数", price=3350.0, change_pct=0.2)],
        temperature=MarketTemperature(
            score=35.0,
            level=TemperatureLevel.COOL,
            pe_median=22.0,
            pe_percentile=25.0,
            bond_yield=1.60,
            equity_bond_spread=2.80,
            comment="偏低区间",
        ),
        hot_industries=[],
        cross_asset=None,
    )

    large_cow = _build_test_snapshot(
        code="600900",
        name="长江电力",
        industry_sw1="公用事业",
        latest_pe=12.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=45e8,
        total_mv=800e8,
        net_profit=22e8,
        ocf=26e8,
    )
    st_stock = _build_test_snapshot(
        code="600518",
        name="*ST黄金样本",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        latest_pe=10.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=45e8,
        total_mv=300e8,
        net_profit=22e8,
        ocf=26e8,
    )
    micro_cap = _build_test_snapshot(
        code="300111",
        name="小微高息",
        industry_sw1="基础化工",
        latest_pe=10.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=4e8,
        total_mv=50e8,
        net_profit=22e8,
        ocf=26e8,
    )
    short_tenure_base = _build_test_snapshot(
        code="688111",
        name="次新股样本",
        industry_sw1="医药生物",
        latest_pe=10.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=25e8,
        total_mv=500e8,
        net_profit=22e8,
        ocf=26e8,
    )
    short_tenure_2y = short_tenure_base.model_copy(
        update={"annual_trends": short_tenure_base.annual_trends[:2]}
    )
    short_tenure_3y = short_tenure_base.model_copy(
        update={
            "code": "688222",
            "name": "三年次新",
            "annual_trends": short_tenure_base.annual_trends[:3],
        }
    )
    leveraged_base = _build_test_snapshot(
        code="600222",
        name="高杠杆高息",
        industry_sw1="建筑装饰",
        latest_pe=9.0,
        pe_history=(10.0, 14.0, 18.0, 22.0, 26.0),
        dividend_total=30e8,
        total_mv=600e8,
        net_profit=22e8,
        ocf=26e8,
    )
    leveraged = leveraged_base.model_copy(
        update={
            "forensics": leveraged_base.forensics.model_copy(
                update={
                    "earnings_quality_tag": "leveraged_roe",
                    "earnings_quality_label": "高杠杆驱动型 ROE",
                }
            )
            if leveraged_base.forensics is not None
            else None,
            "peer_metrics": leveraged_base.peer_metrics.model_copy(
                update={"earnings_quality_tag": "leveraged_roe"}
            ),
        }
    )
    low_roe_gold = _build_test_snapshot(
        code="600988",
        name="低ROE黄金",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        latest_pe=25.0,
        total_mv=500e8,
        net_profit=5e8,
        ocf=6e8,
    )
    cautioned_gold = _build_test_snapshot(
        code="601899",
        name="高投资黄金",
        industry_sw1="有色金属",
        industry_sw2="黄金",
        latest_pe=18.0,
        total_mv=800e8,
        operate_profit=20e8,
        invest_income=18e8,
        net_profit=22e8,
        ocf=26e8,
    )
    micro_legacy_999_base = _build_test_snapshot(
        code="300222",
        name="微盘补贴扭亏",
        industry_sw1="机械设备",
        total_mv=30e8,
        operate_profit=5e8,
        invest_income=0.0,
        other_income=4e8,
        net_profit=2e8,
        deduct_net_profit=-1e8,
        ocf=2e8,
    )
    micro_legacy_999 = micro_legacy_999_base.model_copy(
        update={
            "forensics": micro_legacy_999_base.forensics.model_copy(
                update={
                    "earnings_quality_tag": "subsidy_inflated",
                    "non_recurring_share_3y_pct": 999.0,
                }
            )
            if micro_legacy_999_base.forensics is not None
            else None,
            "peer_metrics": micro_legacy_999_base.peer_metrics.model_copy(
                update={"earnings_quality_tag": "subsidy_inflated"}
            ),
        }
    )

    board = build_market_discovery_board(
        overview,
        [
            large_cow,
            st_stock,
            micro_cap,
            short_tenure_2y,
            short_tenure_3y,
            leveraged,
            low_roe_gold,
            cautioned_gold,
            micro_legacy_999,
        ],
    )
    buckets = board.candidate_buckets
    assert [p.code for p in buckets.dividend_fortresses] == ["600900", "688222"]
    assert [p.code for p in buckets.core_cash_cows] == ["600900"]
    assert {p.code for p in buckets.deep_value} == {"600900", "688222"}
    assert buckets.gold_resources == []

    caution_codes = [p.code for p in buckets.investment_cautions]
    assert caution_codes == ["601899", "300222"]
    legacy_pick = next(p for p in buckets.investment_cautions if p.code == "300222")
    assert "999.0%" not in legacy_pick.reason
    assert "全靠非经扭亏" in legacy_pick.reason
