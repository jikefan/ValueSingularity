from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import date, datetime, timedelta
from pathlib import Path

import akshare as ak
import duckdb
import pandas as pd
import pyarrow.parquet as pq
import pytest
from akshare.exceptions import RateLimitError
from akshare.utils.http import Push2RateLimitError
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.akshare.market_feed import (
    AkshareMarketFeed,
    parse_index_spots,
    parse_industry_flows_em,
    parse_industry_flows_ths,
    parse_macro_history,
    parse_stock_list,
    parse_trade_calendar,
)
from app.adapters.duckdb.market_store import DuckDBMarketFactStore
from app.adapters.memory.market import MemoryMarketRepository
from app.adapters.postgres.market import PostgresMarketRepository, PostgresStockMetaRepository
from app.api.deps import get_db
from app.db.base import Base
from app.db.models import MarketSnapshot, StockMeta
from app.domain.errors import MarketFeedUnavailableError
from app.domain.market_math import compute_market_temperature
from app.domain.models import (
    IndexDailyRow,
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    MarketOverview,
    MarketTemperature,
    StockMetaRecord,
    TemperatureLevel,
    TradeCalendarEntry,
)
from app.main import create_app
from app.services.market_sync import MarketSyncService
from app.settings import Settings, settings


def _sample_trade_calendar_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "trade_date": [
                date(2026, 11, 20),
                date(2026, 11, 18),
                date(2026, 11, 19),
                date(2026, 11, 19),
            ]
        }
    )


def _sample_stock_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "code": ["600519", "688981", "000001", "300750", "835185", "920001", "000002"],
            "name": [
                "贵州茅台",
                "中芯国际",
                "平安银行",
                "宁德时代",
                "*ST新研",
                "ST北交",
                "万 科Ａ",
            ],
        }
    )


def _sample_sina_index_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "代码": ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300", "sh000905"],
            "名称": ["上证指数", "深证成指", "创业板指", "科创50", "沪深300", "中证500"],
            "最新价": [3350.12, 10820.45, 2240.33, 1015.66, 3980.10, 5810.20],
            "涨跌额": [15.2, 85.4, -12.1, 18.7, 22.5, 31.0],
            "涨跌幅": [0.46, 0.80, -0.54, 1.88, 0.57, 0.54],
            "昨收": [3334.92, 10735.05, 2252.43, 996.96, 3957.60, 5779.20],
            "今开": [3336.0, 10740.0, 2250.0, 1000.0, 3960.0, 5780.0],
            "最高": [3360.0, 10850.0, 2255.0, 1020.0, 3990.0, 5820.0],
            "最低": [3330.0, 10720.0, 2230.0, 995.0, 3955.0, 5770.0],
            "成交量": [100, 200, 300, 400, 500, 600],
            "成交额": [4.2e11, 5.1e11, 2.3e11, 9.8e10, 3.1e11, 1.9e11],
        }
    )


def _sample_em_index_sh_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "代码": ["000001", "000688", "000300"],
            "名称": ["上证指数", "科创50", "沪深300"],
            "最新价": [3351.0, 1016.0, 3981.0],
            "涨跌幅": [0.49, 1.91, 0.59],
            "成交额": [4.21e11, 9.9e10, 3.11e11],
        }
    )


def _sample_em_index_sz_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "代码": ["399001", "399006"],
            "名称": ["深证成指", "创业板指"],
            "最新价": [10821.0, 2241.0],
            "涨跌幅": [0.81, -0.51],
            "成交额": [5.12e11, 2.31e11],
        }
    )


def _sample_pe_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": [
                date(2018, 6, 30),
                date(2020, 6, 30),
                date(2022, 6, 30),
                date(2024, 6, 30),
                date(2026, 11, 18),
            ],
            "middlePETTM": [32.0, 36.0, 29.0, 24.0, 25.0],
            "quantileInRecent10YearsMiddlePeTtm": [
                0.4,
                float("nan"),
                0.3,
                float("nan"),
                float("nan"),
            ],
        }
    )


def _sample_bond_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "日期": [
                date(2018, 6, 29),
                date(2020, 6, 30),
                date(2022, 6, 30),
                date(2024, 6, 28),
                date(2026, 11, 18),
                date(2026, 11, 20),
            ],
            "中国国债收益率10年": [3.55, 2.85, 2.82, 2.21, 1.62, 1.58],
        }
    )


def _sample_ths_flows_df() -> pd.DataFrame:
    rows = [
        ("半导体", 2.41, 43.12, 168),
        ("电力设备", 1.77, 25.40, 312),
        ("计算机", 1.52, 18.90, 340),
        ("电子", 1.25, 14.20, 410),
        ("通信", 0.98, 9.80, 128),
        ("机械设备", 0.41, 4.10, 520),
        ("医药生物", 0.12, 1.05, 421),
        ("银行", -0.35, -6.10, 42),
        ("煤炭", -0.82, -11.40, 38),
        ("房地产", -1.45, -19.25, 115),
    ]
    return pd.DataFrame(
        {
            "序号": list(range(1, len(rows) + 1)),
            "行业": [r[0] for r in rows],
            "行业指数": [1000.0] * len(rows),
            "行业-涨跌幅": [r[1] for r in rows],
            "流入资金": [100.0] * len(rows),
            "流出资金": [80.0] * len(rows),
            "净额": [r[2] for r in rows],
            "公司家数": [r[3] for r in rows],
            "领涨股": ["示例股"] * len(rows),
            "领涨股-涨跌幅": [5.0] * len(rows),
            "当前价": [20.0] * len(rows),
        }
    )


def _sample_em_flows_df() -> pd.DataFrame:
    rows = [
        ("半导体", 2.41, 43.12e8),
        ("电力设备", 1.77, 25.40e8),
        ("计算机", 1.52, 18.90e8),
        ("电子", 1.25, 14.20e8),
        ("通信", 0.98, 9.80e8),
        ("机械设备", 0.41, 4.10e8),
        ("银行", -0.35, -6.10e8),
        ("煤炭", -0.82, -11.40e8),
        ("房地产", -1.45, -19.25e8),
    ]
    return pd.DataFrame(
        {
            "名称": [r[0] for r in rows],
            "今日涨跌幅": [r[1] for r in rows],
            "今日主力净流入-净额": [r[2] for r in rows],
        }
    )


def test_parse_trade_calendar_and_stock_list() -> None:
    calendar = parse_trade_calendar(_sample_trade_calendar_df())
    assert [entry.trade_date for entry in calendar] == [
        date(2026, 11, 18),
        date(2026, 11, 19),
        date(2026, 11, 20),
    ]
    assert all(entry.is_open for entry in calendar)

    stocks = parse_stock_list(_sample_stock_df())
    by_code = {item.code: item for item in stocks}
    assert by_code["600519"].exchange == "SH"
    assert by_code["688981"].exchange == "SH"
    assert by_code["000001"].exchange == "SZ"
    assert by_code["300750"].exchange == "SZ"
    assert by_code["835185"].exchange == "BJ"
    assert by_code["920001"].exchange == "BJ"
    assert by_code["835185"].is_st is True
    assert by_code["920001"].is_st is True
    assert by_code["600519"].is_st is False


def test_parse_index_spots_normalizes_codes_and_benchmark() -> None:
    quotes, daily = parse_index_spots(_sample_sina_index_df(), trade_date=date(2026, 11, 20))
    assert [q.code for q in quotes] == ["000001", "399001", "399006", "000688"]
    assert [row.code for row in daily] == ["000001", "399001", "399006", "000688", "000300"]
    assert daily[-1].turnover == pytest.approx(3.1e11)

    with pytest.raises(MarketFeedUnavailableError):
        parse_index_spots(
            _sample_sina_index_df().iloc[:2],
            trade_date=date(2026, 11, 20),
        )


def test_parse_macro_history_backward_as_of_and_latest_pairing() -> None:
    rows = parse_macro_history(_sample_pe_df(), _sample_bond_df(), as_of=date(2026, 11, 20))
    by_date = {row.trade_date: row for row in rows}
    # 2018-06-30 PE matches backward to 2018-06-29 bond yield (3.55).
    assert by_date[date(2018, 6, 30)].cn_10y_bond_yield == pytest.approx(3.55)
    # 2024-06-30 PE matches backward to 2024-06-28 bond yield (2.21).
    assert by_date[date(2024, 6, 30)].cn_10y_bond_yield == pytest.approx(2.21)
    # Never fabricates a future 2026-11-20 row when PE only goes up to 2026-11-18.
    assert rows[-1].trade_date == date(2026, 11, 18)
    assert rows[-1].cn_10y_bond_yield == pytest.approx(1.62)
    assert rows[-1].market_pe_median == pytest.approx(25.0)
    assert date(2026, 11, 20) not in by_date

    # When PE is at 2026-11-20 and bond ends at 2026-11-18, backward-pairs latest bond onto PE date.
    pe_at_as_of = pd.DataFrame(
        {
            "date": [date(2024, 6, 30), date(2026, 11, 20)],
            "middlePETTM": [24.0, 26.5],
        }
    )
    bond_before_as_of = pd.DataFrame(
        {
            "日期": [date(2024, 6, 28), date(2026, 11, 18)],
            "中国国债收益率10年": [2.21, 1.62],
        }
    )
    paired_rows = parse_macro_history(pe_at_as_of, bond_before_as_of, as_of=date(2026, 11, 20))
    assert paired_rows[-1].trade_date == date(2026, 11, 20)
    assert paired_rows[-1].cn_10y_bond_yield == pytest.approx(1.62)
    assert paired_rows[-1].market_pe_median == pytest.approx(26.5)


def test_parse_macro_history_rejects_stale_gaps_and_empty_intersection() -> None:
    stale_pe = pd.DataFrame({"date": [date(2026, 9, 1)], "middlePETTM": [24.0]})
    fresh_bond = pd.DataFrame({"日期": [date(2026, 11, 18)], "中国国债收益率10年": [1.62]})
    with pytest.raises(MarketFeedUnavailableError, match="PE"):
        parse_macro_history(stale_pe, fresh_bond, as_of=date(2026, 11, 20))

    fresh_pe = pd.DataFrame({"date": [date(2026, 11, 18)], "middlePETTM": [24.0]})
    stale_bond = pd.DataFrame({"日期": [date(2026, 9, 1)], "中国国债收益率10年": [1.62]})
    with pytest.raises(MarketFeedUnavailableError, match="国债收益率"):
        parse_macro_history(fresh_pe, stale_bond, as_of=date(2026, 11, 20))

    # Cross-series gap > max_staleness_days rejected even when as_of is None.
    with pytest.raises(MarketFeedUnavailableError, match="差距超过"):
        parse_macro_history(stale_pe, fresh_bond, as_of=None)

    # Non-overlapping series within 45 days still produces empty intersection and must fail.
    early_pe = pd.DataFrame({"date": [date(2026, 11, 1)], "middlePETTM": [24.0]})
    later_bond = pd.DataFrame({"日期": [date(2026, 11, 10)], "中国国债收益率10年": [1.62]})
    with pytest.raises(MarketFeedUnavailableError, match="无有效交集"):
        parse_macro_history(early_pe, later_bond, as_of=date(2026, 11, 20))


def test_parse_industry_flows_scales_ths_yi_and_selects_top5_bottom3() -> None:
    ths_flows = parse_industry_flows_ths(_sample_ths_flows_df())
    assert len(ths_flows) == 8
    assert [f.name for f in ths_flows] == [
        "半导体",
        "电力设备",
        "计算机",
        "电子",
        "通信",
        "银行",
        "煤炭",
        "房地产",
    ]
    assert ths_flows[0].net_inflow == pytest.approx(43.12e8)
    assert ths_flows[-1].net_inflow == pytest.approx(-19.25e8)
    inflows = [f.net_inflow for f in ths_flows]
    assert inflows == sorted(inflows, reverse=True)

    em_flows = parse_industry_flows_em(_sample_em_flows_df())
    assert len(em_flows) == 8
    assert em_flows[0].net_inflow == pytest.approx(43.12e8)
    assert em_flows[-1].net_inflow == pytest.approx(-19.25e8)
    assert all(flow.companies is None for flow in em_flows)


def test_compute_market_temperature_buckets_and_10y_window() -> None:
    as_of = date(2026, 11, 20)
    # Out-of-window extreme row (11 years earlier) must not distort trailing 10y percentile.
    stale_row = MacroRateRow(
        trade_date=date(2015, 1, 5), cn_10y_bond_yield=3.5, market_pe_median=80.0
    )
    base_history = [
        MacroRateRow(
            trade_date=date(2018, 1, 1) + timedelta(days=i * 30),
            cn_10y_bond_yield=2.5,
            market_pe_median=20.0 + i,
        )
        for i in range(1, 20)
    ]

    cold_temp = compute_market_temperature(
        as_of,
        [
            stale_row,
            *base_history,
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=1.6, market_pe_median=18.0),
        ],
    )
    assert cold_temp.level == TemperatureLevel.COLD
    assert cold_temp.score < 20.0
    assert cold_temp.equity_bond_spread == pytest.approx(round(100.0 / 18.0 - 1.6, 2))

    cool_temp = compute_market_temperature(
        as_of,
        [
            *base_history,
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=2.2, market_pe_median=24.0),
        ],
    )
    assert cool_temp.level == TemperatureLevel.COOL
    assert 20.0 <= cool_temp.score < 40.0

    neutral_temp = compute_market_temperature(
        as_of,
        [
            *base_history,
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=2.0, market_pe_median=30.0),
        ],
    )
    assert neutral_temp.level == TemperatureLevel.NEUTRAL
    assert 40.0 <= neutral_temp.score < 60.0

    warm_temp = compute_market_temperature(
        as_of,
        [
            *base_history,
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=2.5, market_pe_median=36.0),
        ],
    )
    assert warm_temp.level == TemperatureLevel.WARM
    assert 60.0 <= warm_temp.score < 80.0

    hot_temp = compute_market_temperature(
        as_of,
        [
            *base_history,
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=3.5, market_pe_median=60.0),
        ],
    )
    assert hot_temp.level == TemperatureLevel.HOT
    assert hot_temp.score >= 80.0


def test_compute_market_temperature_normalizes_daily_and_monthly_cadence() -> None:
    as_of = date(2026, 11, 20)
    # 9 years of monthly history (108 months) with PE ranging from 20 to 30.
    monthly_older: list[MacroRateRow] = []
    for m in range(108):
        year = 2016 + (11 + m) // 12
        month = ((11 + m) % 12) + 1
        monthly_older.append(
            MacroRateRow(
                trade_date=date(year, month, 15),
                cn_10y_bond_yield=2.2,
                market_pe_median=20.0 + (m % 11),
            )
        )

    # Last 12 months (2025-12 .. 2026-11): compare 1 obs/month vs 250 daily rows all at low PE=18.
    monthly_recent = [
        MacroRateRow(
            trade_date=date(2025 + (11 + k) // 12, ((11 + k) % 12) + 1, 20),
            cn_10y_bond_yield=1.6,
            market_pe_median=18.0 if k < 11 else 25.0,
        )
        for k in range(12)
    ]
    daily_recent: list[MacroRateRow] = []
    cursor = date(2025, 12, 1)
    while len(daily_recent) < 250 and cursor < as_of:
        daily_recent.append(
            MacroRateRow(
                trade_date=cursor,
                cn_10y_bond_yield=1.6,
                market_pe_median=18.0,
            )
        )
        cursor += timedelta(days=1)
    # Latest observation on each month-end / as_of matches monthly_recent.
    daily_recent.extend(monthly_recent)

    temp_monthly = compute_market_temperature(as_of, [*monthly_older, *monthly_recent])
    temp_with_daily = compute_market_temperature(as_of, [*monthly_older, *daily_recent])
    assert temp_with_daily.pe_percentile == temp_monthly.pe_percentile
    assert temp_with_daily.score == temp_monthly.score


def test_finite_float_and_math_reject_non_finite_values() -> None:
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValidationError):
            MacroRateRow(
                trade_date=date(2026, 11, 20), cn_10y_bond_yield=bad, market_pe_median=25.0
            )
        with pytest.raises(ValidationError):
            MacroRateRow(trade_date=date(2026, 11, 20), cn_10y_bond_yield=1.6, market_pe_median=bad)
        with pytest.raises(ValidationError):
            IndexQuote(code="000001", name="上证指数", price=bad, change_pct=0.5)
        with pytest.raises(ValidationError):
            IndustryFlow(name="半导体", change_pct=0.5, net_inflow=bad, companies=10)
        with pytest.raises(ValidationError):
            IndexDailyRow(
                code="000001", trade_date=date(2026, 11, 20), close=3350.0, change_pct=bad
            )
        with pytest.raises(ValidationError):
            MarketOverview(
                as_of=date(2026, 11, 20),
                generated_at=datetime(2026, 11, 20, 9, 30),
                indices=[IndexQuote(code="000001", name="上证指数", price=3350.0, change_pct=0.5)],
                temperature=MarketTemperature(
                    score=bad,
                    level=TemperatureLevel.COOL,
                    pe_median=25.0,
                    pe_percentile=30.0,
                    bond_yield=1.6,
                    equity_bond_spread=2.4,
                    comment="ok",
                ),
                hot_industries=[],
            )

    bad_row = MacroRateRow.model_construct(
        trade_date=date(2026, 11, 20),
        cn_10y_bond_yield=float("nan"),
        market_pe_median=25.0,
    )
    with pytest.raises(ValueError, match="非有限"):
        compute_market_temperature(date(2026, 11, 20), [bad_row])

    non_positive_pe = MacroRateRow.model_construct(
        trade_date=date(2026, 11, 20),
        cn_10y_bond_yield=1.6,
        market_pe_median=0.0,
    )
    with pytest.raises(ValueError, match="必须大于 0"):
        compute_market_temperature(date(2026, 11, 20), [non_positive_pe])


async def test_akshare_feed_retries_and_switches_to_fallbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ak, "calendar_trade_date_hist_sina", _sample_trade_calendar_df)
    monkeypatch.setattr(ak, "stock_info_a_code_name", _sample_stock_df)
    monkeypatch.setattr(ak, "stock_a_ttm_lyr", _sample_pe_df)
    monkeypatch.setattr(ak, "bond_zh_us_yield_em", lambda **_kwargs: _sample_bond_df())

    sina_calls = 0

    def broken_sina() -> pd.DataFrame:
        nonlocal sina_calls
        sina_calls += 1
        raise RuntimeError("sina blocked")

    def em_index(symbol: str = "上证系列指数") -> pd.DataFrame:
        return _sample_em_index_sh_df() if symbol == "上证系列指数" else _sample_em_index_sz_df()

    monkeypatch.setattr(ak, "index_zh_spot_sina", broken_sina)
    monkeypatch.setattr(ak, "index_zh_spot_em", em_index)
    monkeypatch.setattr(
        ak, "stock_fund_flow_industry_ths", lambda **_kwargs: _sample_ths_flows_df()
    )

    feed = AkshareMarketFeed(timeout_seconds=5.0, max_attempts=2, retry_wait_seconds=0.0)
    bundle = await feed.fetch_market_bundle(as_of=date(2026, 11, 20))
    assert sina_calls == 2
    assert bundle.data_source == "akshare:index-em"
    assert [idx.code for idx in bundle.indices] == ["000001", "399001", "399006", "000688"]

    # Also fail THS flows to trigger EM sector flow fallback.
    monkeypatch.setattr(
        ak,
        "stock_fund_flow_industry_ths",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("ths timeout")),
    )
    monkeypatch.setattr(
        ak, "stock_fund_flow_sector_rank_em", lambda **_kwargs: _sample_em_flows_df()
    )
    bundle2 = await feed.fetch_market_bundle(as_of=date(2026, 11, 20))
    assert bundle2.data_source == "akshare:em"
    assert len(bundle2.hot_industries) == 8

    # If both primary and fallback fail, raise MarketFeedUnavailableError cleanly.
    monkeypatch.setattr(
        ak,
        "stock_fund_flow_sector_rank_em",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("em failed")),
    )
    with pytest.raises(MarketFeedUnavailableError):
        await feed.fetch_market_bundle(as_of=date(2026, 11, 20))


async def test_akshare_feed_rejects_historical_backfill_and_rate_limit_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ak, "calendar_trade_date_hist_sina", _sample_trade_calendar_df)

    def _forbidden_endpoint(*_args: object, **_kwargs: object) -> pd.DataFrame:
        raise AssertionError("Historical date check must reject before spot/stock endpoints")

    monkeypatch.setattr(ak, "stock_info_a_code_name", _forbidden_endpoint)
    monkeypatch.setattr(ak, "index_zh_spot_sina", _forbidden_endpoint)
    monkeypatch.setattr(ak, "index_zh_spot_em", _forbidden_endpoint)
    monkeypatch.setattr(ak, "stock_fund_flow_industry_ths", _forbidden_endpoint)

    feed = AkshareMarketFeed(timeout_seconds=12.0, max_attempts=3, retry_wait_seconds=0.0)
    assert ak.get_timeout() == (5.0, 12.0)

    with pytest.raises(MarketFeedUnavailableError, match="不支持历史回补 --date=2024-06-28"):
        await feed.fetch_market_bundle(as_of=date(2024, 6, 28))

    # Push2RateLimitError and RateLimitError must not retry 3x before falling back.
    monkeypatch.setattr(ak, "stock_info_a_code_name", _sample_stock_df)
    monkeypatch.setattr(ak, "stock_a_ttm_lyr", _sample_pe_df)
    monkeypatch.setattr(ak, "bond_zh_us_yield_em", lambda **_kwargs: _sample_bond_df())
    monkeypatch.setattr(
        ak, "stock_fund_flow_industry_ths", lambda **_kwargs: _sample_ths_flows_df()
    )

    push2_calls = 0

    def push2_limited() -> pd.DataFrame:
        nonlocal push2_calls
        push2_calls += 1
        raise Push2RateLimitError("push2 banned")

    def em_index(symbol: str = "上证系列指数") -> pd.DataFrame:
        return _sample_em_index_sh_df() if symbol == "上证系列指数" else _sample_em_index_sz_df()

    monkeypatch.setattr(ak, "index_zh_spot_sina", push2_limited)
    monkeypatch.setattr(ak, "index_zh_spot_em", em_index)

    bundle = await feed.fetch_market_bundle(as_of=None)
    assert push2_calls == 1
    assert bundle.as_of == date(2026, 11, 20)
    assert bundle.data_source == "akshare:index-em"

    rate_limit_calls = 0

    def rate_limited() -> pd.DataFrame:
        nonlocal rate_limit_calls
        rate_limit_calls += 1
        raise RateLimitError("429")

    monkeypatch.setattr(ak, "index_zh_spot_sina", rate_limited)
    await feed.fetch_market_bundle(as_of=date(2026, 11, 20))
    assert rate_limit_calls == 1

    with pytest.raises(MarketFeedUnavailableError) as exc_info:
        await feed._run_call("empty_timeout", lambda: (_ for _ in ()).throw(TimeoutError()))
    assert exc_info.value.detail == "TimeoutError"


async def test_duckdb_fact_store_writes_idempotently_and_queries_window(tmp_path: Path) -> None:
    store = DuckDBMarketFactStore(tmp_path)
    stocks = [
        StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
        StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
    ]
    cal = [
        TradeCalendarEntry(trade_date=date(2026, 11, 19), is_open=True),
        TradeCalendarEntry(trade_date=date(2026, 11, 20), is_open=True),
    ]
    idx_rows = [
        IndexDailyRow(code="000001", trade_date=date(2026, 11, 20), close=3350.0, change_pct=0.46),
        IndexDailyRow(code="000300", trade_date=date(2026, 11, 20), close=3980.0, change_pct=0.57),
    ]
    macro_rows = [
        MacroRateRow(trade_date=date(2014, 1, 15), cn_10y_bond_yield=4.4, market_pe_median=19.0),
        MacroRateRow(trade_date=date(2020, 6, 30), cn_10y_bond_yield=2.85, market_pe_median=36.0),
        MacroRateRow(trade_date=date(2026, 11, 20), cn_10y_bond_yield=1.58, market_pe_median=25.0),
    ]

    await store.write_meta_facts(
        stock_list=stocks,
        trade_calendar=cal,
        index_daily=idx_rows,
        macro_rates=macro_rows,
    )

    # Re-write overlapping keys with updated close/yield to verify upsert dedup.
    await store.write_meta_facts(
        stock_list=stocks,
        trade_calendar=[TradeCalendarEntry(trade_date=date(2026, 11, 20), is_open=True)],
        index_daily=[
            IndexDailyRow(
                code="000001",
                trade_date=date(2026, 11, 20),
                close=3355.5,
                change_pct=0.62,
            )
        ],
        macro_rates=[
            MacroRateRow(
                trade_date=date(2026, 11, 20), cn_10y_bond_yield=1.59, market_pe_median=25.2
            )
        ],
    )

    meta_dir = tmp_path / "meta"
    assert (meta_dir / "stock_list.parquet").exists()
    assert (meta_dir / "trade_calendar.parquet").exists()
    assert (meta_dir / "index_daily.parquet").exists()
    assert (meta_dir / "macro_rates.parquet").exists()

    assert pq.read_table(meta_dir / "trade_calendar.parquet").num_rows == 2
    idx_table = pq.read_table(meta_dir / "index_daily.parquet")
    assert idx_table.num_rows == 2
    idx_map = {(r["code"], r["trade_date"]): r["close"] for r in idx_table.to_pylist()}
    assert idx_map[("000001", date(2026, 11, 20))] == pytest.approx(3355.5)

    history = await store.load_macro_history(date(2026, 11, 20), lookback_years=10)
    assert [row.trade_date for row in history] == [date(2020, 6, 30), date(2026, 11, 20)]
    assert history[-1].cn_10y_bond_yield == pytest.approx(1.59)
    assert history[-1].market_pe_median == pytest.approx(25.2)

    # Double check DuckDB direct SQL readability on generated Parquet.
    con = duckdb.connect(":memory:")
    try:
        cnt = con.execute(
            "SELECT count(*) FROM read_parquet(?)",
            [str(meta_dir / "stock_list.parquet")],
        ).fetchone()
        assert cnt == (2,)
    finally:
        con.close()


async def test_duckdb_fact_store_preserves_metadata_tracks_delisted_and_locks_concurrency(
    tmp_path: Path,
) -> None:
    store = DuckDBMarketFactStore(tmp_path)
    initial_stocks = [
        StockMetaRecord(
            code="600519",
            name="贵州茅台",
            exchange="SH",
            industry_sw1="食品饮料",
            industry_sw2="白酒",
            list_date=date(2001, 8, 27),
        ),
        StockMetaRecord(
            code="000001",
            name="平安银行",
            exchange="SZ",
            industry_sw1="银行",
            list_date=date(1991, 4, 3),
        ),
        StockMetaRecord(code="835185", name="*ST新研", exchange="BJ", is_st=True),
    ]
    await store.write_meta_facts(
        stock_list=initial_stocks,
        trade_calendar=[TradeCalendarEntry(trade_date=date(2026, 11, 18), is_open=True)],
        index_daily=[],
        macro_rates=[],
    )

    # Empty stock_list must NOT wipe existing stock_list.parquet.
    await store.write_meta_facts(
        stock_list=[],
        trade_calendar=[],
        index_daily=[],
        macro_rates=[],
    )
    assert pq.read_table(tmp_path / "meta/stock_list.parquet").num_rows == 3

    await store.write_meta_facts(
        stock_list=[
            StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
            StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
        ],
        trade_calendar=[],
        index_daily=[],
        macro_rates=[],
    )
    rows_by_code = {
        row["code"]: row for row in pq.read_table(tmp_path / "meta/stock_list.parquet").to_pylist()
    }
    assert rows_by_code["600519"]["industry_sw1"] == "食品饮料"
    assert rows_by_code["600519"]["industry_sw2"] == "白酒"
    assert rows_by_code["600519"]["list_date"] == date(2001, 8, 27)
    assert rows_by_code["600519"]["is_active"] is True
    assert rows_by_code["000001"]["industry_sw1"] == "银行"
    assert rows_by_code["000001"]["list_date"] == date(1991, 4, 3)
    assert rows_by_code["835185"]["is_active"] is False

    # Concurrent asyncio.gather upserts drop zero dates and set readable 0o644 file permissions.
    await asyncio.gather(
        store.write_meta_facts(
            stock_list=[],
            trade_calendar=[TradeCalendarEntry(trade_date=date(2026, 11, 19), is_open=True)],
            index_daily=[
                IndexDailyRow(
                    code="000001", trade_date=date(2026, 11, 19), close=3340.0, change_pct=0.1
                )
            ],
            macro_rates=[
                MacroRateRow(
                    trade_date=date(2026, 11, 19), cn_10y_bond_yield=1.60, market_pe_median=24.8
                )
            ],
        ),
        store.write_meta_facts(
            stock_list=[],
            trade_calendar=[TradeCalendarEntry(trade_date=date(2026, 11, 20), is_open=True)],
            index_daily=[
                IndexDailyRow(
                    code="000001", trade_date=date(2026, 11, 20), close=3350.0, change_pct=0.3
                )
            ],
            macro_rates=[
                MacroRateRow(
                    trade_date=date(2026, 11, 20), cn_10y_bond_yield=1.58, market_pe_median=25.0
                )
            ],
        ),
    )

    meta_dir = tmp_path / "meta"
    cal_dates = {
        r["trade_date"] for r in pq.read_table(meta_dir / "trade_calendar.parquet").to_pylist()
    }
    assert cal_dates == {date(2026, 11, 18), date(2026, 11, 19), date(2026, 11, 20)}
    idx_dates = {
        r["trade_date"] for r in pq.read_table(meta_dir / "index_daily.parquet").to_pylist()
    }
    assert idx_dates == {date(2026, 11, 19), date(2026, 11, 20)}
    macro_dates = {
        r["trade_date"] for r in pq.read_table(meta_dir / "macro_rates.parquet").to_pylist()
    }
    assert macro_dates == {date(2026, 11, 19), date(2026, 11, 20)}

    for name in (
        "stock_list.parquet",
        "trade_calendar.parquet",
        "index_daily.parquet",
        "macro_rates.parquet",
    ):
        mode = (meta_dir / name).stat().st_mode & 0o777
        assert (mode & 0o444) == 0o444


def _stub_bundle(as_of: date, pe_latest: float = 25.0) -> MarketFeedBundle:
    return MarketFeedBundle(
        as_of=as_of,
        data_source="akshare",
        indices=[
            IndexQuote(code="000001", name="上证指数", price=3350.0, change_pct=0.5),
            IndexQuote(code="399001", name="深证成指", price=10800.0, change_pct=0.8),
            IndexQuote(code="399006", name="创业板指", price=2240.0, change_pct=-0.3),
            IndexQuote(code="000688", name="科创50", price=1015.0, change_pct=1.2),
        ],
        hot_industries=[
            IndustryFlow(name="半导体", change_pct=2.4, net_inflow=43.12e8, companies=168),
            IndustryFlow(name="房地产", change_pct=-1.4, net_inflow=-19.25e8, companies=115),
        ],
        stock_list=[
            StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
            StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
            StockMetaRecord(code="835185", name="*ST新研", exchange="BJ", is_st=True),
        ],
        trade_calendar=[
            TradeCalendarEntry(trade_date=date(2026, 11, 19), is_open=True),
            TradeCalendarEntry(trade_date=as_of, is_open=True),
        ],
        index_daily=[
            IndexDailyRow(
                code="000001", trade_date=as_of, close=3350.0, change_pct=0.5, turnover=4.2e11
            ),
            IndexDailyRow(
                code="000300", trade_date=as_of, close=3980.0, change_pct=0.6, turnover=3.1e11
            ),
        ],
        macro_rates=[
            MacroRateRow(
                trade_date=date(2020, 6, 30), cn_10y_bond_yield=2.85, market_pe_median=36.0
            ),
            MacroRateRow(
                trade_date=date(2024, 6, 30), cn_10y_bond_yield=2.21, market_pe_median=24.0
            ),
            MacroRateRow(trade_date=as_of, cn_10y_bond_yield=1.58, market_pe_median=pe_latest),
        ],
    )


async def test_market_sync_service_preserves_prior_snapshot_on_feed_failure(tmp_path: Path) -> None:
    class _SwitchableStubFeed:
        def __init__(self) -> None:
            self.fail = False

        async def fetch_market_bundle(self, as_of: date | None = None) -> MarketFeedBundle:
            if self.fail:
                raise MarketFeedUnavailableError("stub", "network unreachable")
            return _stub_bundle(as_of or date(2026, 11, 20))

    class _StubStockMetaRepo:
        def __init__(self) -> None:
            self.items: dict[str, StockMetaRecord] = {}

        async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
            for item in items:
                self.items[item.code] = item
            return len(items)

    feed = _SwitchableStubFeed()
    store = DuckDBMarketFactStore(tmp_path)
    stock_repo = _StubStockMetaRepo()
    market_repo = MemoryMarketRepository(allow_missing=True)
    service = MarketSyncService(
        feed=feed,
        fact_store=store,
        stock_meta_repo=stock_repo,
        market_repo=market_repo,
    )

    summary = await service.sync(as_of=date(2026, 11, 20))
    assert summary.as_of == date(2026, 11, 20)
    assert summary.stock_count == 3
    first_snapshot = await market_repo.overview()
    assert first_snapshot.as_of == date(2026, 11, 20)

    feed.fail = True
    with pytest.raises(MarketFeedUnavailableError):
        await service.sync(as_of=date(2026, 11, 21))

    # Prior valid snapshot and Parquet facts remain intact after upstream failure.
    preserved = await market_repo.overview()
    assert preserved == first_snapshot
    assert pq.read_table(tmp_path / "meta/macro_rates.parquet").num_rows == 3

    # Uncomputable bundle (no macro history inside 10y window) fails BEFORE mutating Parquet/PG.
    invalid_bundle = _stub_bundle(date(2038, 1, 5)).model_copy(
        update={
            "stock_list": [StockMetaRecord(code="601318", name="中国平安", exchange="SH")],
            "macro_rates": [],
        }
    )

    class _InvalidOverviewFeed:
        async def fetch_market_bundle(self, as_of: date | None = None) -> MarketFeedBundle:
            return invalid_bundle

    invalid_service = MarketSyncService(
        feed=_InvalidOverviewFeed(),
        fact_store=store,
        stock_meta_repo=stock_repo,
        market_repo=market_repo,
    )
    with pytest.raises(ValueError, match="宏观估值历史"):
        await invalid_service.sync(as_of=date(2038, 1, 5))

    assert await market_repo.overview() == first_snapshot
    assert "601318" not in stock_repo.items
    persisted_codes = {
        r["code"] for r in pq.read_table(tmp_path / "meta/stock_list.parquet").to_pylist()
    }
    assert persisted_codes == {"600519", "000001", "835185"}


async def test_market_sync_service_end_to_end_with_postgres_and_parquet(tmp_path: Path) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    class _StubFeed:
        def __init__(self, bundle: MarketFeedBundle) -> None:
            self.bundle = bundle
            self.should_fail = False

        async def fetch_market_bundle(self, as_of: date | None = None) -> MarketFeedBundle:
            if self.should_fail:
                raise MarketFeedUnavailableError("stub", "upstream timeout")
            return self.bundle

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

        store = DuckDBMarketFactStore(tmp_path)
        feed = _StubFeed(_stub_bundle(date(2026, 11, 20), pe_latest=25.0))

        # Run sync twice to verify PG and Parquet idempotency.
        for _ in range(2):
            async with testing_session() as session:
                service = MarketSyncService(
                    feed=feed,
                    fact_store=store,
                    stock_meta_repo=PostgresStockMetaRepository(session),
                    market_repo=PostgresMarketRepository(session),
                )
                summary = await service.sync(as_of=date(2026, 11, 20))
                assert summary.stock_count == 3
                assert summary.macro_rate_count == 3

        async with testing_session() as session:
            pg_stock_count = await session.scalar(select(func.count()).select_from(StockMeta))
            pg_snapshot_count = await session.scalar(
                select(func.count()).select_from(MarketSnapshot)
            )
            assert pg_stock_count == 3
            assert pg_snapshot_count == 1

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/market/overview")
            assert resp.status_code == 200
            body = resp.json()
            assert body["as_of"] == "2026-11-20"
            assert body["data_source"] == "akshare"
            assert body["temperature"]["pe_median"] == 25.0
            assert body["temperature"]["bond_yield"] == 1.58
            assert body["temperature"]["equity_bond_spread"] == pytest.approx(2.42)
            assert [f["name"] for f in body["hot_industries"]] == ["半导体", "房地产"]

        # Simulate upstream outage and verify PG snapshot & Parquet stay intact.
        feed.should_fail = True
        async with testing_session() as session:
            service = MarketSyncService(
                feed=feed,
                fact_store=store,
                stock_meta_repo=PostgresStockMetaRepository(session),
                market_repo=PostgresMarketRepository(session),
            )
            with pytest.raises(MarketFeedUnavailableError):
                await service.sync(as_of=date(2026, 11, 21))

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            after_fail = await client.get("/api/market/overview")
            assert after_fail.status_code == 200
            assert after_fail.json()["as_of"] == "2026-11-20"

        enriched = [
            StockMetaRecord(
                code="600519",
                name="贵州茅台",
                exchange="SH",
                industry_sw1="食品饮料",
                industry_sw2="白酒",
                list_date=date(2001, 8, 27),
            ),
            StockMetaRecord(
                code="000001",
                name="平安银行",
                exchange="SZ",
                industry_sw1="银行",
                list_date=date(1991, 4, 3),
            ),
            StockMetaRecord(code="835185", name="*ST新研", exchange="BJ", is_st=True),
        ]
        feed.should_fail = False
        feed.bundle = _stub_bundle(date(2026, 11, 20), pe_latest=25.0).model_copy(
            update={"stock_list": enriched}
        )
        async with testing_session() as session:
            enrich_service = MarketSyncService(
                feed=feed,
                fact_store=store,
                stock_meta_repo=PostgresStockMetaRepository(session),
                market_repo=PostgresMarketRepository(session),
            )
            await enrich_service.sync(as_of=date(2026, 11, 20))

        shrink_bundle = _stub_bundle(date(2026, 11, 21), pe_latest=25.5).model_copy(
            update={
                "stock_list": [
                    StockMetaRecord(code="600519", name="贵州茅台", exchange="SH"),
                    StockMetaRecord(code="000001", name="平安银行", exchange="SZ"),
                ]
            }
        )
        feed.bundle = shrink_bundle
        async with testing_session() as session:
            service = MarketSyncService(
                feed=feed,
                fact_store=store,
                stock_meta_repo=PostgresStockMetaRepository(session),
                market_repo=PostgresMarketRepository(session),
            )
            await service.sync(as_of=date(2026, 11, 21))

        async with testing_session() as session:
            pg_rows = {row.code: row for row in (await session.scalars(select(StockMeta))).all()}
            assert pg_rows["600519"].industry_sw1 == "食品饮料"
            assert pg_rows["600519"].industry_sw2 == "白酒"
            assert pg_rows["600519"].list_date == date(2001, 8, 27)
            assert pg_rows["600519"].is_active is True
            assert pg_rows["000001"].industry_sw1 == "银行"
            assert pg_rows["000001"].list_date == date(1991, 4, 3)
            assert pg_rows["835185"].is_active is False

        pq_rows = {
            r["code"]: r for r in pq.read_table(tmp_path / "meta/stock_list.parquet").to_pylist()
        }
        assert pq_rows["600519"]["industry_sw1"] == "食品饮料"
        assert pq_rows["600519"]["list_date"] == date(2001, 8, 27)
        assert pq_rows["835185"]["is_active"] is False

        # Partial enrichment with deactivate_missing=False keeps other active rows active.
        async with testing_session() as session:
            await PostgresStockMetaRepository(session).upsert_many(
                [
                    StockMetaRecord(
                        code="000001",
                        name="平安银行",
                        exchange="SZ",
                        industry_sw2="股份制银行",
                    )
                ],
                deactivate_missing=False,
            )
            row_600519 = await session.get(StockMeta, "600519")
            row_000001 = await session.get(StockMeta, "000001")
            assert row_600519 is not None and row_600519.is_active is True
            assert row_000001 is not None and row_000001.industry_sw2 == "股份制银行"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_settings_resolves_relative_data_dir_consistently_across_cwd(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    expected = Settings().data_dir
    monkeypatch.setenv("VS_DATA_DIR", "./data/market")
    monkeypatch.chdir(tmp_path)
    assert Settings().data_dir == expected

    custom_abs = tmp_path / "custom-market"
    monkeypatch.setenv("VS_DATA_DIR", str(custom_abs))
    assert Settings().data_dir == custom_abs
