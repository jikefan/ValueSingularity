"""Resilient akshare 1.20.65 market feed adapter and pure DataFrame parsers."""

from __future__ import annotations

import asyncio
import logging
import math
import re
from bisect import bisect_right
from collections.abc import Callable, Sequence
from datetime import date, datetime
from typing import TypeVar
from zoneinfo import ZoneInfo

import akshare as ak
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

from app.domain.errors import MarketFeedUnavailableError
from app.domain.market_math import subtract_years
from app.domain.models import (
    IndexDailyRow,
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    StockExchange,
    StockMetaRecord,
    TradeCalendarEntry,
)

logger = logging.getLogger("vs.akshare")

T = TypeVar("T")

_STOCK_CODE_RE = re.compile(r"^\d{6}$")
_SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

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


class AkshareMarketFeed:
    def __init__(
        self,
        *,
        timeout_seconds: float = 20.0,
        max_attempts: int = 3,
        retry_wait_seconds: float = 1.0,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max(1, max_attempts)
        self._retry_wait_seconds = max(0.0, retry_wait_seconds)
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
        )
