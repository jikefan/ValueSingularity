"""Resilient akshare 1.20.65 market feed adapter and pure DataFrame parsers."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, TypeVar
from zoneinfo import ZoneInfo

import akshare as ak
import httpx
import pandas as pd
from akshare.exceptions import RateLimitError
from akshare.utils.http import Push2RateLimitError
from tenacity import (
    AsyncRetrying,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential,
    wait_none,
)

from app.adapters.akshare._common import MINI_RACER_LOCK
from app.domain.errors import MarketFeedUnavailableError
from app.domain.market_math import subtract_years
from app.domain.models import (
    CrossAssetMacroSnapshot,
    IndexDailyRow,
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    StockExchange,
    StockMetaRecord,
    StyleRegimeIndex,
    TradeCalendarEntry,
)

logger = logging.getLogger("vs.akshare")

T = TypeVar("T")

_STOCK_CODE_RE = re.compile(r"^\d{6}$")
_SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
_ORIG_GOLD_ETF_FN = ak.fund_gold_etf_holding_js
_JIN10_ETF_URL = "https://datacenter-api.jin10.com/reports/list_v2"
_AUX_WARNING_LABELS: dict[str, str] = {
    "macro_usa_cpi_yoy": "美国 CPI 通胀数据",
    "spot_hist_sge": "上海金交所现货数据",
    "futures_zh_daily_sina": "黄金期货主力数据",
    "fund_gold_etf_holding_js": "黄金 ETF 持仓数据",
}


def _format_aux_warning(source_name: str, exc: Exception) -> str:
    if source_name.startswith(("index_us_daily_sina:", "index_zh_daily_sina:")):
        label = "部分跨市场风格指数"
    else:
        label = _AUX_WARNING_LABELS.get(source_name, "部分跨市场宏观数据")
    suffix = "暂时超时" if isinstance(exc, TimeoutError | httpx.TimeoutException) else "暂时不可用"
    return f"{label}{suffix}"


def _fetch_latest_spdr_gold_etf_df(*, timeout_seconds: float = 5.0) -> pd.DataFrame:
    # Fetch only page 1 (~20 latest rows); ak.fund_gold_etf_holding_js loops back to 2004.
    headers = {
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36"
        ),
        "x-app-id": "rU6QIu7JHe2gOUeR",
        "x-csrf-token": "x-csrf-token",
        "x-version": "1.0.0",
    }
    params = {
        "category": "etf",
        "attr_id": "1",
        "max_date": "",
        "_": str(round(time.time() * 1000)),
    }
    resp = httpx.get(_JIN10_ETF_URL, params=params, headers=headers, timeout=timeout_seconds)
    resp.raise_for_status()
    payload = resp.json()
    values = (payload.get("data") or {}).get("values") or []
    if not values:
        return pd.DataFrame(columns=["日期", "总库存", "增持/减持", "总价值"])
    df = pd.DataFrame(values)
    if df.shape[1] >= 4:
        df = df.iloc[:, :4].copy()
        df.columns = ["日期", "总库存", "增持/减持", "总价值"]
    elif df.shape[1] == 3:
        df = df.copy()
        df.columns = ["日期", "总库存", "增持/减持"]
    elif df.shape[1] == 2:
        df = df.copy()
        df.columns = ["日期", "总库存"]
    else:
        return pd.DataFrame()
    df["日期"] = pd.to_datetime(df["日期"], errors="coerce").dt.date
    df["总库存"] = pd.to_numeric(df["总库存"], errors="coerce")
    if "增持/减持" in df.columns:
        df["增持/减持"] = pd.to_numeric(df["增持/减持"], errors="coerce")
    return df.sort_values(["日期"]).reset_index(drop=True)


@dataclass(frozen=True, slots=True)
class _CachedCrossAssetAux:
    cpi_df: pd.DataFrame | None
    gold_df: pd.DataFrame | None
    gold_symbol: str | None
    gold_etf_df: pd.DataFrame | None
    style_frames: dict[str, pd.DataFrame]
    warnings: tuple[str, ...]


# (code, display_name, market, style)
_STYLE_INDEX_SPECS: tuple[
    tuple[str, str, Literal["A", "US"], Literal["tech", "dividend", "broad"]], ...
] = (
    ("sh000688", "科创50", "A", "tech"),
    ("sz399006", "创业板指", "A", "tech"),
    ("sh000015", "上证红利", "A", "dividend"),
    ("sh000300", "沪深300", "A", "broad"),
    (".IXIC", "纳斯达克", "US", "tech"),
)

# (canonical_code, prefixed_sina_code, fallback_name, include_in_overview)
_INDEX_SPECS: tuple[tuple[str, str, str, bool], ...] = (
    ("000001", "sh000001", "上证指数", True),
    ("399001", "sz399001", "深证成指", True),
    ("399006", "sz399006", "创业板指", True),
    ("000688", "sh000688", "科创50", True),
    ("000300", "sh000300", "沪深300", False),
)
_PREFIXED_TO_CANONICAL = {prefixed: code for code, prefixed, _, _ in _INDEX_SPECS}
_CANONICAL_SET = {code for code, _, _, _ in _INDEX_SPECS}
_OVERVIEW_INDEX_CODES = {code for code, _, _, in_overview in _INDEX_SPECS if in_overview}
_DEFAULT_INDEX_NAMES = {code: name for code, _, name, _ in _INDEX_SPECS}


def _is_missing(value: object) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _coerce_date(value: object) -> date | None:
    if _is_missing(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        parsed = pd.to_datetime(text, errors="coerce")
        if _is_missing(parsed):
            return None
        if isinstance(parsed, datetime):
            return parsed.date()
        return None


def _coerce_float(value: object) -> float | None:
    if _is_missing(value):
        return None
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "").rstrip("%")
        if not cleaned or cleaned in {"-", "--", "nan", "NaN", "None"}:
            return None
        raw_input: object = cleaned
    else:
        raw_input = value
    try:
        num = float(str(raw_input)) if not isinstance(raw_input, int | float) else float(raw_input)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _coerce_int(value: object) -> int | None:
    num = _coerce_float(value)
    if num is None:
        return None
    return round(num)


def _infer_exchange(code: str) -> StockExchange | None:
    if code.startswith(("60", "68")):
        return "SH"
    if code.startswith(("00", "30")):
        return "SZ"
    if code.startswith(("4", "8", "92")):
        return "BJ"
    return None


def parse_trade_calendar(df: pd.DataFrame) -> list[TradeCalendarEntry]:
    if "trade_date" not in df.columns:
        raise MarketFeedUnavailableError("calendar_trade_date_hist_sina", "缺少 trade_date 列")

    unique_dates: set[date] = set()
    for raw in df["trade_date"].tolist():
        parsed = _coerce_date(raw)
        if parsed is not None:
            unique_dates.add(parsed)

    if not unique_dates:
        raise MarketFeedUnavailableError("calendar_trade_date_hist_sina", "交易日历结果为空")

    return [TradeCalendarEntry(trade_date=d, is_open=True) for d in sorted(unique_dates)]


def parse_stock_list(df: pd.DataFrame) -> list[StockMetaRecord]:
    if not {"code", "name"} <= set(df.columns):
        raise MarketFeedUnavailableError("stock_info_a_code_name", "缺少 code/name 列")

    by_code: dict[str, StockMetaRecord] = {}
    for row in df.to_dict(orient="records"):
        raw_code = row.get("code")
        raw_name = row.get("name")
        if _is_missing(raw_code) or _is_missing(raw_name):
            continue
        code = str(raw_code).strip().zfill(6)
        if not _STOCK_CODE_RE.fullmatch(code):
            continue
        exchange = _infer_exchange(code)
        if exchange is None:
            continue
        name = str(raw_name).strip()[:64]
        if not name:
            continue
        by_code[code] = StockMetaRecord(
            code=code,
            name=name,
            exchange=exchange,
            is_st="ST" in name.upper(),
            is_active=True,
        )

    if not by_code:
        raise MarketFeedUnavailableError("stock_info_a_code_name", "A 股代码表为空")

    return [by_code[code] for code in sorted(by_code)]


def parse_index_spots(
    df: pd.DataFrame,
    *,
    trade_date: date,
) -> tuple[list[IndexQuote], list[IndexDailyRow]]:
    required_cols = {"代码", "名称", "最新价", "涨跌幅"}
    if not required_cols <= set(df.columns):
        raise MarketFeedUnavailableError(
            "index_spot",
            f"缺少必需列: {sorted(required_cols - set(df.columns))}",
        )

    matched: dict[str, tuple[IndexQuote, IndexDailyRow, bool]] = {}
    for row in df.to_dict(orient="records"):
        raw_code = str(row.get("代码", "")).strip().lower()
        is_prefixed = False
        if raw_code in _PREFIXED_TO_CANONICAL:
            canonical = _PREFIXED_TO_CANONICAL[raw_code]
            is_prefixed = True
        elif raw_code in _CANONICAL_SET:
            canonical = raw_code
        else:
            continue

        # Prefer exact exchange-prefixed Sina code over bare 6-digit codes when both appear.
        existing = matched.get(canonical)
        if existing is not None and existing[2] and not is_prefixed:
            continue

        price = _coerce_float(row.get("最新价"))
        change_pct = _coerce_float(row.get("涨跌幅"))
        if price is None or change_pct is None or price <= 0:
            continue

        raw_name = row.get("名称")
        name = (
            str(raw_name).strip()
            if not _is_missing(raw_name) and str(raw_name).strip()
            else _DEFAULT_INDEX_NAMES[canonical]
        )
        turnover = _coerce_float(row.get("成交额"))

        quote = IndexQuote(
            code=canonical,
            name=name,
            price=price,
            change_pct=change_pct,
        )
        daily = IndexDailyRow(
            code=canonical,
            trade_date=trade_date,
            close=price,
            change_pct=change_pct,
            turnover=turnover,
        )
        matched[canonical] = (quote, daily, is_prefixed)

    missing_overview = sorted(_OVERVIEW_INDEX_CODES - set(matched))
    if missing_overview:
        raise MarketFeedUnavailableError(
            "index_spot",
            f"缺少核心指数: {', '.join(missing_overview)}",
        )

    quotes: list[IndexQuote] = []
    daily_rows: list[IndexDailyRow] = []
    for canonical, _, _, in_overview in _INDEX_SPECS:
        item = matched.get(canonical)
        if item is None:
            continue
        if in_overview:
            quotes.append(item[0])
        daily_rows.append(item[1])

    return quotes, daily_rows


def parse_macro_history(
    pe_df: pd.DataFrame,
    bond_df: pd.DataFrame,
    *,
    as_of: date | None = None,
    max_staleness_days: int = 45,
) -> list[MacroRateRow]:
    if not {"date", "middlePETTM"} <= set(pe_df.columns):
        raise MarketFeedUnavailableError("stock_a_ttm_lyr", "缺少 date/middlePETTM 列")
    if not {"日期", "中国国债收益率10年"} <= set(bond_df.columns):
        raise MarketFeedUnavailableError("bond_zh_us_yield_em", "缺少 日期/中国国债收益率10年 列")

    pe_by_date: dict[date, float] = {}
    for row in pe_df.to_dict(orient="records"):
        d = _coerce_date(row.get("date"))
        pe_val = _coerce_float(row.get("middlePETTM"))
        if d is None or pe_val is None or pe_val <= 0:
            continue
        if as_of is not None and d > as_of:
            continue
        pe_by_date[d] = pe_val

    bond_by_date: dict[date, float] = {}
    for row in bond_df.to_dict(orient="records"):
        d = _coerce_date(row.get("日期"))
        bond_val = _coerce_float(row.get("中国国债收益率10年"))
        if d is None or bond_val is None:
            continue
        if as_of is not None and d > as_of:
            continue
        bond_by_date[d] = bond_val

    if not pe_by_date:
        raise MarketFeedUnavailableError("stock_a_ttm_lyr", "有效全市场 PE 中位数记录为空")
    if not bond_by_date:
        raise MarketFeedUnavailableError("bond_zh_us_yield_em", "有效十年国债收益率记录为空")

    pe_rows = sorted(pe_by_date.items())
    bond_rows = sorted(bond_by_date.items())
    latest_pe_date = pe_rows[-1][0]
    latest_bond_date = bond_rows[-1][0]

    if as_of is not None:
        if (as_of - latest_pe_date).days > max_staleness_days:
            raise MarketFeedUnavailableError(
                "stock_a_ttm_lyr",
                (
                    f"全市场 PE 数据过旧（最新 {latest_pe_date.isoformat()}，"
                    f"滞后于 {as_of.isoformat()} 超过 {max_staleness_days} 天）"
                ),
            )
        if (as_of - latest_bond_date).days > max_staleness_days:
            raise MarketFeedUnavailableError(
                "bond_zh_us_yield_em",
                (
                    f"十年国债收益率数据过旧（最新 {latest_bond_date.isoformat()}，"
                    f"滞后于 {as_of.isoformat()} 超过 {max_staleness_days} 天）"
                ),
            )
    if abs((latest_pe_date - latest_bond_date).days) > max_staleness_days:
        raise MarketFeedUnavailableError(
            "macro_rates",
            (
                f"全市场 PE({latest_pe_date.isoformat()}) 与国债收益率"
                f"({latest_bond_date.isoformat()}) 最新日期差距超过 {max_staleness_days} 天"
            ),
        )

    bond_dates = [d for d, _ in bond_rows]
    merged: dict[date, MacroRateRow] = {}
    for pe_date, pe_val in pe_rows:
        idx = bisect_right(bond_dates, pe_date) - 1
        if idx < 0:
            continue
        _, bond_val = bond_rows[idx]
        merged[pe_date] = MacroRateRow(
            trade_date=pe_date,
            cn_10y_bond_yield=bond_val,
            market_pe_median=pe_val,
        )

    if not merged:
        raise MarketFeedUnavailableError("macro_rates", "PE 与国债收益率日期区间无有效交集")

    return [merged[d] for d in sorted(merged)]


def _select_hot_industries(flows: Sequence[IndustryFlow], source_name: str) -> list[IndustryFlow]:
    deduped: dict[str, IndustryFlow] = {}
    for flow in flows:
        if flow.name not in deduped:
            deduped[flow.name] = flow

    ordered = sorted(deduped.values(), key=lambda item: (-item.net_inflow, item.name))
    if not ordered:
        raise MarketFeedUnavailableError(source_name, "有效行业资金流数据为空")

    if len(ordered) <= 8:
        return ordered

    selected: dict[str, IndustryFlow] = {}
    for item in [*ordered[:5], *ordered[-3:]]:
        selected[item.name] = item
    return sorted(selected.values(), key=lambda item: (-item.net_inflow, item.name))


def parse_industry_flows_ths(df: pd.DataFrame) -> list[IndustryFlow]:
    required_cols = {"行业", "行业-涨跌幅", "净额", "公司家数"}
    if not required_cols <= set(df.columns):
        raise MarketFeedUnavailableError(
            "stock_fund_flow_industry_ths",
            f"缺少必需列: {sorted(required_cols - set(df.columns))}",
        )

    flows: list[IndustryFlow] = []
    for row in df.to_dict(orient="records"):
        raw_name = row.get("行业")
        if _is_missing(raw_name):
            continue
        name = str(raw_name).strip()
        change_pct = _coerce_float(row.get("行业-涨跌幅"))
        net_inflow_yi = _coerce_float(row.get("净额"))
        companies = _coerce_int(row.get("公司家数"))
        if not name or change_pct is None or net_inflow_yi is None or companies is None:
            continue
        # THS reports net flow in 亿元; domain contract uses yuan.
        flows.append(
            IndustryFlow(
                name=name,
                change_pct=change_pct,
                net_inflow=net_inflow_yi * 1e8,
                companies=max(0, companies),
            )
        )

    return _select_hot_industries(flows, "stock_fund_flow_industry_ths")


def parse_industry_flows_em(df: pd.DataFrame) -> list[IndustryFlow]:
    required_cols = {"名称", "今日涨跌幅", "今日主力净流入-净额"}
    if not required_cols <= set(df.columns):
        raise MarketFeedUnavailableError(
            "stock_fund_flow_sector_rank_em",
            f"缺少必需列: {sorted(required_cols - set(df.columns))}",
        )

    flows: list[IndustryFlow] = []
    for row in df.to_dict(orient="records"):
        raw_name = row.get("名称")
        if _is_missing(raw_name):
            continue
        name = str(raw_name).strip()
        change_pct = _coerce_float(row.get("今日涨跌幅"))
        net_inflow_yuan = _coerce_float(row.get("今日主力净流入-净额"))
        companies = _coerce_int(row.get("公司家数")) if "公司家数" in row else None
        if not name or change_pct is None or net_inflow_yuan is None:
            continue
        flows.append(
            IndustryFlow(
                name=name,
                change_pct=change_pct,
                net_inflow=net_inflow_yuan,
                companies=max(0, companies) if companies is not None else None,
            )
        )

    return _select_hot_industries(flows, "stock_fund_flow_sector_rank_em")


def _extract_date_close_series(
    df: pd.DataFrame,
    *,
    as_of: date | None = None,
) -> list[tuple[date, float]]:
    if df.empty or not {"date", "close"} <= set(df.columns):
        return []
    by_date: dict[date, float] = {}
    for row in df.to_dict(orient="records"):
        d = _coerce_date(row.get("date"))
        close = _coerce_float(row.get("close"))
        if d is None or close is None or close <= 0:
            continue
        if as_of is not None and d > as_of:
            continue
        by_date[d] = close
    return sorted(by_date.items())


def parse_cross_asset_bonds(
    bond_df: pd.DataFrame,
    *,
    as_of: date | None = None,
) -> dict[str, Any]:
    """Extract CN 10Y and latest non-NaN US 2Y/10Y yields + 20-trading-day bps deltas."""
    empty: dict[str, Any] = {
        "us_bond_as_of": None,
        "us_2y_yield": None,
        "us_10y_yield": None,
        "us_10y_2y_spread": None,
        "cn_10y_yield": None,
        "us_cn_10y_spread": None,
        "us_2y_change_20d_bps": None,
        "us_10y_change_20d_bps": None,
    }
    if bond_df.empty or "日期" not in bond_df.columns:
        return empty

    by_date: dict[date, dict[str, Any]] = {}
    for raw in bond_df.to_dict(orient="records"):
        row = {str(k): v for k, v in raw.items()}
        d = _coerce_date(row.get("日期"))
        if d is None:
            continue
        if as_of is not None and d > as_of:
            continue
        by_date[d] = row

    if not by_date:
        return empty

    ordered = sorted(by_date.items())
    cn_10y_rows = [
        (d, v) for d, r in ordered if (v := _coerce_float(r.get("中国国债收益率10年"))) is not None
    ]
    us_2y_rows = [
        (d, v) for d, r in ordered if (v := _coerce_float(r.get("美国国债收益率2年"))) is not None
    ]
    us_10y_rows = [
        (d, v) for d, r in ordered if (v := _coerce_float(r.get("美国国债收益率10年"))) is not None
    ]
    us_spread_rows = [
        (d, v)
        for d, r in ordered
        if (v := _coerce_float(r.get("美国国债收益率10年-2年"))) is not None
    ]

    cn_10y = round(cn_10y_rows[-1][1], 2) if cn_10y_rows else None
    us_2y = round(us_2y_rows[-1][1], 2) if us_2y_rows else None
    us_10y = round(us_10y_rows[-1][1], 2) if us_10y_rows else None
    us_bond_dates = [rows[-1][0] for rows in (us_2y_rows, us_10y_rows) if rows]
    us_bond_as_of = max(us_bond_dates) if us_bond_dates else None

    us_spread: float | None = None
    if us_spread_rows and (us_bond_as_of is None or us_spread_rows[-1][0] == us_bond_as_of):
        us_spread = round(us_spread_rows[-1][1], 2)
    elif us_10y is not None and us_2y is not None:
        us_spread = round(us_10y - us_2y, 2)

    us_cn_spread = round(us_10y - cn_10y, 2) if us_10y is not None and cn_10y is not None else None
    us_2y_bps = (
        round((us_2y_rows[-1][1] - us_2y_rows[-21][1]) * 100.0, 1)
        if len(us_2y_rows) >= 21
        else None
    )
    us_10y_bps = (
        round((us_10y_rows[-1][1] - us_10y_rows[-21][1]) * 100.0, 1)
        if len(us_10y_rows) >= 21
        else None
    )
    return {
        "us_bond_as_of": us_bond_as_of,
        "us_2y_yield": us_2y,
        "us_10y_yield": us_10y,
        "us_10y_2y_spread": us_spread,
        "cn_10y_yield": cn_10y,
        "us_cn_10y_spread": us_cn_spread,
        "us_2y_change_20d_bps": us_2y_bps,
        "us_10y_change_20d_bps": us_10y_bps,
    }


def parse_us_cpi_yoy(
    df: pd.DataFrame,
    *,
    as_of: date | None = None,
) -> tuple[float | None, date | None]:
    if df.empty or "现值" not in df.columns:
        return None, None
    rows: list[tuple[date, date, float]] = []
    for row in df.to_dict(orient="records"):
        val = _coerce_float(row.get("现值"))
        report_d = _coerce_date(row.get("时间"))
        pub_d = _coerce_date(row.get("发布日期"))
        effective_d = pub_d or report_d
        if val is None or effective_d is None:
            continue
        if as_of is not None and effective_d > as_of:
            continue
        rows.append((report_d or effective_d, effective_d, val))
    if not rows:
        return None, None
    rows.sort(key=lambda item: (item[0], item[1]))
    _, latest_date, latest_val = rows[-1]
    return round(latest_val, 2), latest_date


def parse_gold_series(
    df: pd.DataFrame,
    *,
    as_of: date | None = None,
) -> tuple[float | None, date | None, float | None, float | None, float | None]:
    series = _extract_date_close_series(df, as_of=as_of)
    if not series:
        return None, None, None, None, None
    gold_as_of, latest_close = series[-1]
    closes = [c for _, c in series]
    chg_5d = round((closes[-1] / closes[-6] - 1.0) * 100.0, 2) if len(closes) >= 6 else None
    chg_20d = round((closes[-1] / closes[-21] - 1.0) * 100.0, 2) if len(closes) >= 21 else None
    cutoff_1y = subtract_years(gold_as_of, 1)
    window_1y = [c for d, c in series if d >= cutoff_1y]
    less = sum(1 for c in window_1y if c < latest_close)
    equal = sum(1 for c in window_1y if c == latest_close)
    pct_1y = (
        round(max(0.0, min(100.0, ((less + 0.5 * equal) / len(window_1y)) * 100.0)), 1)
        if window_1y
        else None
    )
    return round(latest_close, 2), gold_as_of, chg_5d, chg_20d, pct_1y


def parse_gold_etf_holding(
    df: pd.DataFrame,
    *,
    as_of: date | None = None,
) -> tuple[float | None, float | None, date | None]:
    if df.empty or not {"日期", "总库存"} <= set(df.columns):
        return None, None, None
    rows: list[tuple[date, float, float | None]] = []
    for row in df.to_dict(orient="records"):
        d = _coerce_date(row.get("日期"))
        tonnes = _coerce_float(row.get("总库存"))
        if d is None or tonnes is None or tonnes <= 0:
            continue
        if as_of is not None and d > as_of:
            continue
        delta = _coerce_float(row.get("增持/减持"))
        rows.append((d, tonnes, delta))
    if not rows:
        return None, None, None
    rows.sort(key=lambda item: item[0])
    latest_d, latest_tonnes, latest_delta = rows[-1]
    if latest_delta is None and len(rows) >= 2:
        latest_delta = rows[-1][1] - rows[-2][1]
    return (
        round(latest_tonnes, 2),
        round(latest_delta, 2) if latest_delta is not None else None,
        latest_d,
    )


def parse_style_index_history(
    df: pd.DataFrame,
    *,
    code: str,
    name: str,
    market: Literal["A", "US"],
    style: Literal["tech", "dividend", "broad"],
    as_of: date | None = None,
) -> StyleRegimeIndex | None:
    series = _extract_date_close_series(df, as_of=as_of)
    if not series:
        return None
    latest_d, latest_close = series[-1]
    closes = [c for _, c in series]
    chg_1d = round((closes[-1] / closes[-2] - 1.0) * 100.0, 2) if len(closes) >= 2 else None
    chg_5d = round((closes[-1] / closes[-6] - 1.0) * 100.0, 2) if len(closes) >= 6 else None
    chg_20d = round((closes[-1] / closes[-21] - 1.0) * 100.0, 2) if len(closes) >= 21 else None
    peak_60 = max(closes[-60:])
    drawdown_60d = round(((closes[-1] - peak_60) / peak_60) * 100.0, 2) if peak_60 > 0 else None
    return StyleRegimeIndex(
        code=code,
        name=name,
        market=market,
        style=style,
        as_of=latest_d,
        close=round(latest_close, 2),
        change_1d_pct=chg_1d,
        change_5d_pct=chg_5d,
        change_20d_pct=chg_20d,
        drawdown_60d_pct=drawdown_60d,
    )


def build_cross_asset_snapshot(
    *,
    bond_df: pd.DataFrame,
    as_of: date | None = None,
    cpi_df: pd.DataFrame | None = None,
    gold_df: pd.DataFrame | None = None,
    gold_symbol: str | None = None,
    gold_etf_df: pd.DataFrame | None = None,
    style_frames: Mapping[str, pd.DataFrame] | None = None,
    warnings: Sequence[str] = (),
) -> CrossAssetMacroSnapshot:
    bonds = parse_cross_asset_bonds(bond_df, as_of=as_of)
    us_cpi_yoy, us_cpi_as_of = (
        parse_us_cpi_yoy(cpi_df, as_of=as_of) if cpi_df is not None else (None, None)
    )
    us_10y = bonds["us_10y_yield"]
    real_yield = (
        round(us_10y - us_cpi_yoy, 2) if us_10y is not None and us_cpi_yoy is not None else None
    )
    gold_px, gold_dt, gold_5d, gold_20d, gold_pct = (
        parse_gold_series(gold_df, as_of=as_of)
        if gold_df is not None
        else (None, None, None, None, None)
    )
    etf_tonnes, etf_delta, etf_dt = (
        parse_gold_etf_holding(gold_etf_df, as_of=as_of)
        if gold_etf_df is not None
        else (None, None, None)
    )

    style_indices: list[StyleRegimeIndex] = []
    if style_frames:
        for code, name, market, style in _STYLE_INDEX_SPECS:
            df = style_frames.get(code)
            if df is None:
                continue
            parsed = parse_style_index_history(
                df, code=code, name=name, market=market, style=style, as_of=as_of
            )
            if parsed is not None:
                style_indices.append(parsed)

    return CrossAssetMacroSnapshot(
        as_of=as_of,
        us_bond_as_of=bonds["us_bond_as_of"],
        us_2y_yield=bonds["us_2y_yield"],
        us_10y_yield=bonds["us_10y_yield"],
        us_10y_2y_spread=bonds["us_10y_2y_spread"],
        cn_10y_yield=bonds["cn_10y_yield"],
        us_cn_10y_spread=bonds["us_cn_10y_spread"],
        us_2y_change_20d_bps=bonds["us_2y_change_20d_bps"],
        us_10y_change_20d_bps=bonds["us_10y_change_20d_bps"],
        us_cpi_yoy=us_cpi_yoy,
        us_cpi_as_of=us_cpi_as_of,
        us_real_yield_proxy_pct=real_yield,
        gold_price_cny=gold_px,
        gold_symbol=gold_symbol if gold_px is not None else None,
        gold_as_of=gold_dt,
        gold_change_5d_pct=gold_5d,
        gold_change_20d_pct=gold_20d,
        gold_percentile_1y=gold_pct,
        gold_etf_tonnes=etf_tonnes,
        gold_etf_delta_tonnes=etf_delta,
        gold_etf_as_of=etf_dt,
        style_indices=style_indices,
        warnings=list(warnings),
    )


class AkshareMarketFeed:
    def __init__(
        self,
        *,
        timeout_seconds: float = 20.0,
        max_attempts: int = 3,
        retry_wait_seconds: float = 1.0,
        cross_asset_ttl_seconds: float = 180.0,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max(1, max_attempts)
        self._retry_wait_seconds = max(0.0, retry_wait_seconds)
        self._cross_asset_ttl_seconds = max(0.0, cross_asset_ttl_seconds)
        self._cross_asset_cache: dict[date, tuple[float, _CachedCrossAssetAux]] = {}
        self._cross_asset_inflight: dict[date, asyncio.Task[_CachedCrossAssetAux]] = {}
        self._ak_timeout = (min(5.0, self._timeout_seconds), self._timeout_seconds)
        ak.set_timeout(self._ak_timeout)

    async def _run_call(self, source_name: str, fn: Callable[[], T]) -> T:
        ak.set_timeout(self._ak_timeout)
        wait_strategy = (
            wait_exponential(
                multiplier=self._retry_wait_seconds,
                min=self._retry_wait_seconds,
                max=8.0,
            )
            if self._retry_wait_seconds > 0
            else wait_none()
        )
        try:
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(self._max_attempts),
                wait=wait_strategy,
                retry=retry_if_not_exception_type((Push2RateLimitError, RateLimitError)),
                reraise=True,
            ):
                with attempt:
                    return await asyncio.wait_for(
                        asyncio.to_thread(fn),
                        timeout=self._timeout_seconds,
                    )
        except MarketFeedUnavailableError:
            raise
        except Exception as exc:
            msg = str(exc).strip()
            detail = f"{exc.__class__.__name__}: {msg}" if msg else exc.__class__.__name__
            raise MarketFeedUnavailableError(source_name, detail) from exc
        raise MarketFeedUnavailableError(source_name, "未知采集失败")

    async def _fetch_indices(
        self, trade_date: date
    ) -> tuple[list[IndexQuote], list[IndexDailyRow], bool]:
        try:
            sina_df = await self._run_call("index_zh_spot_sina", ak.index_zh_spot_sina)
            quotes, daily_rows = parse_index_spots(sina_df, trade_date=trade_date)
            return quotes, daily_rows, False
        except Exception as primary_exc:
            logger.warning("Sina 指数实时行情失败，切换至东方财富备用源: %s", primary_exc)
            try:
                sh_df = await self._run_call(
                    "index_zh_spot_em_sh",
                    lambda: ak.index_zh_spot_em(symbol="上证系列指数"),
                )
                sz_df = await self._run_call(
                    "index_zh_spot_em_sz",
                    lambda: ak.index_zh_spot_em(symbol="深证系列指数"),
                )
                em_df = pd.concat([sh_df, sz_df], ignore_index=True)
                quotes, daily_rows = parse_index_spots(em_df, trade_date=trade_date)
                return quotes, daily_rows, True
            except Exception as fallback_exc:
                raise MarketFeedUnavailableError(
                    "index_spot",
                    f"主源({primary_exc})与备用源({fallback_exc})均失败",
                ) from fallback_exc

    async def _fetch_industries(self) -> tuple[list[IndustryFlow], bool]:
        try:
            ths_df = await self._run_call(
                "stock_fund_flow_industry_ths",
                lambda: ak.stock_fund_flow_industry_ths(symbol="即时"),
            )
            return parse_industry_flows_ths(ths_df), False
        except Exception as primary_exc:
            logger.warning("同花顺行业资金流失败，切换至东方财富备用源: %s", primary_exc)
            try:
                em_df = await self._run_call(
                    "stock_fund_flow_sector_rank_em",
                    lambda: ak.stock_fund_flow_sector_rank_em(
                        indicator="今日",
                        sector_type="行业资金流",
                    ),
                )
                return parse_industry_flows_em(em_df), True
            except Exception as fallback_exc:
                raise MarketFeedUnavailableError(
                    "industry_flow",
                    f"主源({primary_exc})与备用源({fallback_exc})均失败",
                ) from fallback_exc

    async def fetch_market_bundle(self, as_of: date | None = None) -> MarketFeedBundle:
        cal_df = await self._run_call(
            "calendar_trade_date_hist_sina",
            ak.calendar_trade_date_hist_sina,
        )
        trade_calendar = parse_trade_calendar(cal_df)

        shanghai_today = datetime.now(_SHANGHAI_TZ).date()
        open_dates = {
            entry.trade_date
            for entry in trade_calendar
            if entry.is_open and entry.trade_date <= shanghai_today
        }
        if not open_dates:
            raise MarketFeedUnavailableError(
                "calendar_trade_date_hist_sina",
                f"交易日历缺少 {shanghai_today.isoformat()} 及之前的开市日期",
            )
        latest_open = max(open_dates)
        if as_of is not None and as_of != latest_open:
            raise MarketFeedUnavailableError(
                "market_sync",
                (
                    f"实时行情源仅支持同步最近交易日 {latest_open.isoformat()}，"
                    f"不支持历史回补 --date={as_of.isoformat()}"
                ),
            )
        resolved_as_of = latest_open

        stock_df = await self._run_call("stock_info_a_code_name", ak.stock_info_a_code_name)
        stock_list = parse_stock_list(stock_df)

        indices, index_daily, index_fallback = await self._fetch_indices(resolved_as_of)

        bond_start = subtract_years(resolved_as_of, 11).strftime("%Y%m%d")
        pe_df = await self._run_call("stock_a_ttm_lyr", ak.stock_a_ttm_lyr)
        bond_df = await self._run_call(
            "bond_zh_us_yield_em",
            lambda: ak.bond_zh_us_yield_em(start_date=bond_start),
        )
        macro_rates = parse_macro_history(pe_df, bond_df, as_of=resolved_as_of)

        hot_industries, flow_fallback = await self._fetch_industries()
        cross_asset = await self._fetch_cross_asset(bond_df, as_of=resolved_as_of)

        if not index_fallback and not flow_fallback:
            data_source = "akshare"
        elif index_fallback and flow_fallback:
            data_source = "akshare:em"
        elif index_fallback:
            data_source = "akshare:index-em"
        else:
            data_source = "akshare:flow-em"

        return MarketFeedBundle(
            as_of=resolved_as_of,
            data_source=data_source,
            indices=indices,
            hot_industries=hot_industries,
            stock_list=stock_list,
            trade_calendar=trade_calendar,
            index_daily=index_daily,
            macro_rates=macro_rates,
            cross_asset=cross_asset,
        )

    async def _safe_aux(
        self,
        source_name: str,
        fn: Callable[[], pd.DataFrame],
        warnings: list[str],
        *,
        serialize_v8: bool = False,
        timeout_seconds: float | None = None,
    ) -> pd.DataFrame | None:
        aux_timeout = min(
            self._timeout_seconds,
            timeout_seconds if timeout_seconds is not None else 10.0,
        )

        def _invoke() -> pd.DataFrame:
            if serialize_v8:
                with MINI_RACER_LOCK:
                    return fn()
            return fn()

        try:
            return await asyncio.wait_for(asyncio.to_thread(_invoke), timeout=aux_timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("跨资产辅助数据源 %s 降级跳过: %s", source_name, exc)
            msg = _format_aux_warning(source_name, exc)
            if msg not in warnings:
                warnings.append(msg)
            return None

    async def _fetch_cross_asset_aux(self, *, as_of: date) -> _CachedCrossAssetAux:
        warnings: list[str] = []

        async def _fetch_gold() -> tuple[pd.DataFrame | None, str | None]:
            sge_df = await self._safe_aux(
                "spot_hist_sge",
                lambda: ak.spot_hist_sge(symbol="Au99.99"),
                warnings,
            )
            if (
                sge_df is not None
                and not sge_df.empty
                and _extract_date_close_series(sge_df, as_of=as_of)
            ):
                return sge_df, "Au99.99"
            fut_df = await self._safe_aux(
                "futures_zh_daily_sina",
                lambda: ak.futures_zh_daily_sina(symbol="AU0"),
                warnings,
            )
            if fut_df is not None and not fut_df.empty:
                return fut_df, "AU0"
            return None, None

        def _fetch_gold_etf() -> pd.DataFrame:
            if ak.fund_gold_etf_holding_js is not _ORIG_GOLD_ETF_FN:
                return ak.fund_gold_etf_holding_js()
            return _fetch_latest_spdr_gold_etf_df(
                timeout_seconds=min(self._timeout_seconds, 5.0),
            )

        async def _fetch_all_styles() -> dict[str, pd.DataFrame]:
            # Run style fetches sequentially under MINI_RACER_LOCK with fresh 4.5s budgets.
            frames: dict[str, pd.DataFrame] = {}
            style_timeout = min(self._timeout_seconds, 4.5)
            for code, _, market, _ in _STYLE_INDEX_SPECS:

                def _call_style(
                    sym: str = code,
                    mkt: Literal["A", "US"] = market,
                ) -> pd.DataFrame:
                    if mkt == "US":
                        return ak.index_us_daily_sina(symbol=sym)
                    return ak.index_zh_daily_sina(symbol=sym)

                source_name = (
                    f"index_us_daily_sina:{code}"
                    if market == "US"
                    else f"index_zh_daily_sina:{code}"
                )
                df = await self._safe_aux(
                    source_name,
                    _call_style,
                    warnings,
                    serialize_v8=True,
                    timeout_seconds=style_timeout,
                )
                if df is not None and not df.empty:
                    frames[code] = df
            return frames

        cpi_task = self._safe_aux("macro_usa_cpi_yoy", ak.macro_usa_cpi_yoy, warnings)
        gold_task = _fetch_gold()
        etf_task = self._safe_aux(
            "fund_gold_etf_holding_js",
            _fetch_gold_etf,
            warnings,
            timeout_seconds=min(self._timeout_seconds, 5.0),
        )
        style_task = _fetch_all_styles()

        cpi_df, (gold_df, gold_symbol), gold_etf_df, style_frames = await asyncio.gather(
            cpi_task, gold_task, etf_task, style_task
        )
        return _CachedCrossAssetAux(
            cpi_df=cpi_df,
            gold_df=gold_df,
            gold_symbol=gold_symbol,
            gold_etf_df=gold_etf_df,
            style_frames=style_frames,
            warnings=tuple(warnings),
        )

    async def _get_or_fetch_cross_asset_aux(self, *, as_of: date) -> _CachedCrossAssetAux:
        if self._cross_asset_ttl_seconds <= 0:
            return await self._fetch_cross_asset_aux(as_of=as_of)

        now = time.monotonic()
        cached = self._cross_asset_cache.get(as_of)
        if cached is not None and (now - cached[0]) < self._cross_asset_ttl_seconds:
            return cached[1]

        loop = asyncio.get_running_loop()
        task = self._cross_asset_inflight.get(as_of)
        if task is None or task.done() or task.get_loop() is not loop:
            task = asyncio.create_task(self._fetch_cross_asset_aux(as_of=as_of))
            self._cross_asset_inflight[as_of] = task

            def _cleanup(done_task: asyncio.Task[_CachedCrossAssetAux]) -> None:
                if self._cross_asset_inflight.get(as_of) is done_task:
                    self._cross_asset_inflight.pop(as_of, None)
                if not done_task.cancelled() and done_task.exception() is None:
                    self._cross_asset_cache[as_of] = (time.monotonic(), done_task.result())

            task.add_done_callback(_cleanup)

        return await asyncio.shield(task)

    async def _fetch_cross_asset(
        self,
        bond_df: pd.DataFrame,
        *,
        as_of: date,
    ) -> CrossAssetMacroSnapshot:
        aux = await self._get_or_fetch_cross_asset_aux(as_of=as_of)
        return build_cross_asset_snapshot(
            bond_df=bond_df,
            as_of=as_of,
            cpi_df=aux.cpi_df,
            gold_df=aux.gold_df,
            gold_symbol=aux.gold_symbol,
            gold_etf_df=aux.gold_etf_df,
            style_frames=aux.style_frames,
            warnings=aux.warnings,
        )


def _extract_csindex_codes(df: pd.DataFrame) -> list[str]:
    if df.empty:
        return []
    code_col: str | None = None
    for candidate in ("成分券代码", "代码", "股票代码", "code"):
        if candidate in df.columns:
            code_col = candidate
            break
    if code_col is None:
        return []
    codes: list[str] = []
    seen: set[str] = set()
    for raw in df[code_col].tolist():
        if _is_missing(raw):
            continue
        code = str(raw).strip().zfill(6)
        if _STOCK_CODE_RE.fullmatch(code) and code not in seen:
            seen.add(code)
            codes.append(code)
    return codes


async def fetch_priority_index_codes(
    *, timeout_seconds: float = 15.0
) -> tuple[list[str], list[str]]:
    """Fetch HS300 (000300) and CSI500 (000905) constituent codes, returning ([], []) on outage."""
    effective_timeout = max(1.0, timeout_seconds)
    ak.set_timeout((min(5.0, effective_timeout), effective_timeout))

    async def _fetch_one(symbol: str) -> list[str]:
        try:
            df = await asyncio.wait_for(
                asyncio.to_thread(ak.index_stock_cons_csindex, symbol),
                timeout=effective_timeout,
            )
            return _extract_csindex_codes(df)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("获取指数成分股失败 (%s): %s", symbol, exc)
            return []

    hs300, csi500 = await asyncio.gather(_fetch_one("000300"), _fetch_one("000905"))
    return hs300, csi500
