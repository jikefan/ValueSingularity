"""Resilient akshare 1.20.65 per-stock fact feed adapter (non-Push2 endpoints)."""

from __future__ import annotations

import asyncio
import logging
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import date, datetime, timedelta
from typing import Any

import akshare as ak
import pandas as pd

from app.adapters.akshare._common import (
    SHANGHAI_TZ,
    STOCK_CODE_RE,
    coerce_cn_amount_yuan,
    coerce_date,
    coerce_float,
    infer_exchange,
    is_missing,
    run_akshare_call,
)
from app.domain.errors import StockFactUnavailableError
from app.domain.market_math import subtract_years
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
)

logger = logging.getLogger("vs.akshare.stock")

_VALID_DIVIDEND_PROGRESS = frozenset({"实施分配", "股东大会通过"})
_VALID_REPURCHASE_PROGRESS = frozenset({"完成实施", "实施中"})
_PLEDGE_LOOKBACK_WEEKS = 5
_VALUATION_MAX_LAG_DAYS = 10


def _lookup_backward(
    dates: Sequence[date],
    mapping: dict[date, float],
    target: date,
    *,
    max_lag_days: int = _VALUATION_MAX_LAG_DAYS,
) -> float | None:
    if not dates:
        return None
    idx = bisect_right(dates, target) - 1
    if idx < 0:
        return None
    matched_date = dates[idx]
    if (target - matched_date).days > max_lag_days:
        return None
    return mapping[matched_date]


def _first_float(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        if key in row:
            val = coerce_float(row.get(key))
            if val is not None:
                return val
    return None


def _first_str(row: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        if key in row:
            raw = row.get(key)
            if not is_missing(raw):
                text = str(raw).strip()
                if text:
                    return text
    return None


def parse_baidu_valuation(
    df: pd.DataFrame,
    *,
    scale: float = 1.0,
    positive_only: bool = False,
) -> dict[date, float]:
    if df.empty or not {"date", "value"} <= set(df.columns):
        return {}
    by_date: dict[date, float] = {}
    for row in df.to_dict(orient="records"):
        d = coerce_date(row.get("date"))
        val = coerce_float(row.get("value"))
        if d is None or val is None:
            continue
        if positive_only and val <= 0:
            continue
        by_date[d] = val * scale
    return by_date


def parse_daily_bars(
    bars_df: pd.DataFrame,
    code: str,
    *,
    mv_df: pd.DataFrame | None = None,
    pe_df: pd.DataFrame | None = None,
    pb_df: pd.DataFrame | None = None,
    pcf_df: pd.DataFrame | None = None,
    as_of: date | None = None,
) -> list[StockDailyBar]:
    required_cols = {"date", "open", "high", "low", "close"}
    if bars_df.empty or not required_cols <= set(bars_df.columns):
        raise StockFactUnavailableError(code, "stock_daily_bars", "日线行情为空或缺少必需 OHLC 列")

    mv_map = (
        parse_baidu_valuation(mv_df, scale=1e8, positive_only=True) if mv_df is not None else {}
    )
    pe_map = parse_baidu_valuation(pe_df) if pe_df is not None else {}
    pb_map = parse_baidu_valuation(pb_df) if pb_df is not None else {}
    pcf_map = parse_baidu_valuation(pcf_df) if pcf_df is not None else {}

    mv_dates = sorted(mv_map)
    pe_dates = sorted(pe_map)
    pb_dates = sorted(pb_map)
    pcf_dates = sorted(pcf_map)

    by_date: dict[date, StockDailyBar] = {}
    for row in bars_df.to_dict(orient="records"):
        trade_date = coerce_date(row.get("date"))
        if trade_date is None:
            continue
        if as_of is not None and trade_date > as_of:
            continue

        open_p = coerce_float(row.get("open"))
        high_p = coerce_float(row.get("high"))
        low_p = coerce_float(row.get("low"))
        close_p = coerce_float(row.get("close"))
        if open_p is None or high_p is None or low_p is None or close_p is None or close_p <= 0:
            continue

        outstanding_share = coerce_float(row.get("outstanding_share"))
        total_mv_yuan = _lookup_backward(mv_dates, mv_map, trade_date)
        if total_mv_yuan is None and outstanding_share is not None and outstanding_share > 0:
            total_mv_yuan = close_p * outstanding_share

        by_date[trade_date] = StockDailyBar(
            code=code,
            trade_date=trade_date,
            open=open_p,
            high=high_p,
            low=low_p,
            close=close_p,
            volume=coerce_float(row.get("volume")),
            amount=coerce_float(row.get("amount")),
            outstanding_share=outstanding_share,
            turnover=coerce_float(row.get("turnover")),
            total_mv_yuan=total_mv_yuan,
            pe_ttm=_lookup_backward(pe_dates, pe_map, trade_date),
            pb=_lookup_backward(pb_dates, pb_map, trade_date),
            pcf=_lookup_backward(pcf_dates, pcf_map, trade_date),
        )

    if not by_date:
        raise StockFactUnavailableError(code, "stock_daily_bars", "有效日线行情记录为空")

    return [by_date[d] for d in sorted(by_date)]


def _dedup_annual_sheet(df: pd.DataFrame, *, as_of: date | None) -> dict[int, dict[str, Any]]:
    if df.empty or "REPORT_DATE" not in df.columns:
        return {}
    selected: dict[int, tuple[tuple[date, date, date], dict[str, Any]]] = {}
    for raw in df.to_dict(orient="records"):
        row = {str(k): v for k, v in raw.items()}
        if "REPORT_TYPE" in row and str(row.get("REPORT_TYPE", "")).strip() != "年报":
            continue
        report_date = coerce_date(row.get("REPORT_DATE"))
        if report_date is None:
            continue
        raw_notice_date = coerce_date(row.get("NOTICE_DATE"))
        raw_update_date = coerce_date(row.get("UPDATE_DATE"))
        if as_of is not None:
            if report_date > as_of:
                continue
            if raw_notice_date is not None and raw_notice_date > as_of:
                continue
            if raw_update_date is not None and raw_update_date > as_of:
                continue
        year = report_date.year
        update_date = raw_update_date or date.min
        notice_date = raw_notice_date or date.min
        rank = (update_date, notice_date, report_date)
        existing = selected.get(year)
        if existing is None or rank >= existing[0]:
            selected[year] = (rank, row)
    return {year: pair[1] for year, pair in selected.items()}


def parse_annual_reports(
    code: str,
    *,
    balance_df: pd.DataFrame,
    profit_df: pd.DataFrame,
    cash_flow_df: pd.DataFrame,
    as_of: date | None = None,
    max_years: int = 12,
) -> list[StockAnnualReport]:
    bs_by_year = _dedup_annual_sheet(balance_df, as_of=as_of)
    ps_by_year = _dedup_annual_sheet(profit_df, as_of=as_of)
    cf_by_year = _dedup_annual_sheet(cash_flow_df, as_of=as_of)

    years = sorted(set(bs_by_year) | set(ps_by_year) | set(cf_by_year), reverse=True)[:max_years]
    if not years:
        return []

    reports: list[StockAnnualReport] = []
    for year in sorted(years):
        bs = bs_by_year.get(year, {})
        ps = ps_by_year.get(year, {})
        cf = cf_by_year.get(year, {})

        report_date = (
            coerce_date(bs.get("REPORT_DATE"))
            or coerce_date(ps.get("REPORT_DATE"))
            or coerce_date(cf.get("REPORT_DATE"))
            or date(year, 12, 31)
        )
        notice_date = (
            coerce_date(bs.get("NOTICE_DATE"))
            or coerce_date(ps.get("NOTICE_DATE"))
            or coerce_date(cf.get("NOTICE_DATE"))
        )
        update_date = max(
            [
                d
                for d in (
                    coerce_date(bs.get("UPDATE_DATE")),
                    coerce_date(ps.get("UPDATE_DATE")),
                    coerce_date(cf.get("UPDATE_DATE")),
                )
                if d is not None
            ],
            default=None,
        )
        audit_opinion = (
            _first_str(bs, "OPINION_TYPE")
            or _first_str(ps, "OPINION_TYPE")
            or _first_str(cf, "OPINION_TYPE")
        )

        reports.append(
            StockAnnualReport(
                code=code,
                report_year=year,
                report_date=report_date,
                notice_date=notice_date,
                update_date=update_date,
                audit_opinion=audit_opinion,
                revenue_yuan=_first_float(ps, "OPERATE_INCOME", "TOTAL_OPERATE_INCOME"),
                operate_cost_yuan=_first_float(ps, "OPERATE_COST"),
                net_profit_yuan=_first_float(ps, "PARENT_NETPROFIT", "NETPROFIT"),
                deduct_net_profit_yuan=_first_float(ps, "DEDUCT_PARENT_NETPROFIT"),
                research_expense_yuan=_first_float(ps, "RESEARCH_EXPENSE", "ME_RESEARCH_EXPENSE"),
                interest_expense_yuan=_first_float(ps, "FE_INTEREST_EXPENSE", "INTEREST_EXPENSE"),
                finance_expense_yuan=_first_float(ps, "FINANCE_EXPENSE"),
                total_assets_yuan=_first_float(bs, "TOTAL_ASSETS"),
                total_liabilities_yuan=_first_float(bs, "TOTAL_LIABILITIES"),
                total_equity_yuan=_first_float(bs, "TOTAL_EQUITY"),
                parent_equity_yuan=_first_float(bs, "TOTAL_PARENT_EQUITY"),
                monetary_funds_yuan=_first_float(bs, "MONETARYFUNDS"),
                trade_fin_assets_yuan=_first_float(
                    bs, "TRADE_FINASSET_NOTFVTPL", "TRADE_FINASSET", "FVTPL_FINASSET"
                ),
                short_loan_yuan=_first_float(bs, "SHORT_LOAN"),
                noncurrent_liab_1y_yuan=_first_float(bs, "NONCURRENT_LIAB_1YEAR"),
                long_loan_yuan=_first_float(bs, "LONG_LOAN"),
                bond_payable_yuan=_first_float(bs, "BOND_PAYABLE"),
                short_bond_payable_yuan=_first_float(bs, "SHORT_BOND_PAYABLE"),
                lease_liab_yuan=_first_float(bs, "LEASE_LIAB"),
                cip_yuan=_first_float(bs, "CIP"),
                fixed_asset_yuan=_first_float(bs, "FIXED_ASSET"),
                accounts_receivable_yuan=_first_float(bs, "ACCOUNTS_RECE"),
                note_accounts_rece_yuan=_first_float(bs, "NOTE_ACCOUNTS_RECE"),
                inventory_yuan=_first_float(bs, "INVENTORY"),
                goodwill_yuan=_first_float(bs, "GOODWILL"),
                share_capital_yuan=_first_float(bs, "SHARE_CAPITAL"),
                ocf_yuan=_first_float(cf, "NETCASH_OPERATE"),
                capex_yuan=_first_float(cf, "CONSTRUCT_LONG_ASSET"),
                accept_invest_cash_yuan=_first_float(cf, "ACCEPT_INVEST_CASH"),
                subsidiary_accept_invest_yuan=_first_float(cf, "SUBSIDIARY_ACCEPT_INVEST"),
                cash_dividend_paid_yuan=_first_float(cf, "ASSIGN_DIVIDEND_PORFIT"),
            )
        )

    return reports


def parse_dividends(
    df: pd.DataFrame,
    code: str,
    *,
    as_of: date | None = None,
) -> list[StockDividendRecord]:
    if df.empty or not {"报告期", "现金分红-现金分红比例", "总股本", "方案进度"} <= set(df.columns):
        return []

    by_report_date: dict[date, StockDividendRecord] = {}
    for row in df.to_dict(orient="records"):
        progress = str(row.get("方案进度", "")).strip()
        if progress not in _VALID_DIVIDEND_PROGRESS:
            continue
        report_date = coerce_date(row.get("报告期"))
        if report_date is None:
            continue
        notice_date = coerce_date(row.get("最新公告日期")) or coerce_date(row.get("业绩披露日期"))
        effective_disclosure = notice_date or report_date
        if as_of is not None and (report_date > as_of or effective_disclosure > as_of):
            continue

        cash_per_10 = coerce_float(row.get("现金分红-现金分红比例"))
        total_shares = coerce_float(row.get("总股本"))
        if cash_per_10 is None or total_shares is None or cash_per_10 <= 0 or total_shares <= 0:
            continue

        raw_yield = coerce_float(row.get("现金分红-股息率"))
        yield_pct = (
            round(raw_yield * 100.0, 2) if raw_yield is not None and raw_yield >= 0 else None
        )

        by_report_date[report_date] = StockDividendRecord(
            code=code,
            report_date=report_date,
            report_year=report_date.year,
            ex_dividend_date=coerce_date(row.get("除权除息日")),
            notice_date=notice_date,
            plan_progress=progress,
            cash_per_10_shares=cash_per_10,
            total_shares=total_shares,
            dividend_cash_total_yuan=round((cash_per_10 / 10.0) * total_shares, 2),
            dividend_yield_pct=yield_pct,
        )

    return [by_report_date[d] for d in sorted(by_report_date)]


def parse_repurchases(df: pd.DataFrame) -> dict[str, list[StockRepurchaseRecord]]:
    required_cols = {"股票代码", "实施进度", "已回购金额"}
    if df.empty or not required_cols <= set(df.columns):
        return {}

    grouped: dict[str, dict[tuple[date | None, date], StockRepurchaseRecord]] = defaultdict(dict)
    for row in df.to_dict(orient="records"):
        raw_code = row.get("股票代码")
        if is_missing(raw_code):
            continue
        code = str(raw_code).strip().zfill(6)
        if not STOCK_CODE_RE.fullmatch(code):
            continue

        progress = str(row.get("实施进度", "")).strip()
        if progress not in _VALID_REPURCHASE_PROGRESS:
            continue

        amount = coerce_float(row.get("已回购金额"))
        if amount is None or amount <= 0:
            continue

        start_date = coerce_date(row.get("回购起始时间"))
        event_date = coerce_date(row.get("最新公告日期")) or start_date
        if event_date is None:
            continue

        candidate = StockRepurchaseRecord(
            code=code,
            event_date=event_date,
            year=event_date.year,
            start_date=start_date,
            progress=progress,
            repurchased_amount_yuan=round(amount, 2),
            repurchased_shares=coerce_float(row.get("已回购股份数量")),
        )
        dedup_key = (start_date, event_date)
        existing = grouped[code].get(dedup_key)
        if existing is None or (
            candidate.event_date,
            candidate.repurchased_amount_yuan,
        ) >= (
            existing.event_date,
            existing.repurchased_amount_yuan,
        ):
            grouped[code][dedup_key] = candidate

    return {
        code: sorted(
            records.values(),
            key=lambda item: (item.event_date, item.start_date or date.min),
        )
        for code, records in grouped.items()
    }


def parse_pledge_table(df: pd.DataFrame) -> tuple[date, dict[str, StockPledgeSnapshot]] | None:
    if df.empty or not {"股票代码", "交易日期", "质押比例"} <= set(df.columns):
        return None

    by_code: dict[str, StockPledgeSnapshot] = {}
    latest_date: date | None = None
    for row in df.to_dict(orient="records"):
        raw_code = row.get("股票代码")
        if is_missing(raw_code):
            continue
        code = str(raw_code).strip().zfill(6)
        if not STOCK_CODE_RE.fullmatch(code):
            continue

        trade_date = coerce_date(row.get("交易日期"))
        ratio = coerce_float(row.get("质押比例"))
        if trade_date is None or ratio is None or ratio < 0:
            continue
        if latest_date is None or trade_date > latest_date:
            latest_date = trade_date

        pledge_shares_wan = coerce_float(row.get("质押股数"))
        pledge_mcap_wan = coerce_float(row.get("质押市值"))
        by_code[code] = StockPledgeSnapshot(
            code=code,
            trade_date=trade_date,
            pledge_ratio_pct=round(ratio, 2),
            pledge_shares=pledge_shares_wan * 1e4 if pledge_shares_wan is not None else None,
            pledge_market_cap_yuan=pledge_mcap_wan * 1e4 if pledge_mcap_wan is not None else None,
        )

    if latest_date is None or not by_code:
        return None
    return latest_date, by_code


def parse_add_stock(
    df: pd.DataFrame,
    code: str,
    *,
    as_of: date | None = None,
) -> list[StockEquityFinancingRecord]:
    if df.empty or not {"公告日期", "实际公司募集资金总额"} <= set(df.columns):
        return []

    records: list[StockEquityFinancingRecord] = []
    for row in df.to_dict(orient="records"):
        event_date = coerce_date(row.get("公告日期"))
        if event_date is None:
            continue
        if as_of is not None and event_date > as_of:
            continue
        amount_yuan = coerce_cn_amount_yuan(row.get("实际公司募集资金总额"))
        if amount_yuan is None or amount_yuan <= 0:
            continue
        issue_mode = str(row.get("发行方式", "")).strip() or "增发募集"
        records.append(
            StockEquityFinancingRecord(
                code=code,
                year=event_date.year,
                event_date=event_date,
                source="add_stock",
                financing_type=issue_mode,
                amount_yuan=round(amount_yuan, 2),
            )
        )
    return sorted(records, key=lambda item: item.event_date)


def extract_cf_equity_financings(
    code: str,
    reports: list[StockAnnualReport],
) -> list[StockEquityFinancingRecord]:
    records: list[StockEquityFinancingRecord] = []
    for report in reports:
        inflow = max(
            0.0,
            (report.accept_invest_cash_yuan or 0.0) - (report.subsidiary_accept_invest_yuan or 0.0),
        )
        if inflow > 0:
            records.append(
                StockEquityFinancingRecord(
                    code=code,
                    year=report.report_year,
                    event_date=report.report_date,
                    source="cash_flow",
                    financing_type="现金流量表-吸收投资(母公司口径)",
                    amount_yuan=round(inflow, 2),
                )
            )
    return records


def _safe_fhps_detail_em(code: str) -> pd.DataFrame:
    try:
        return ak.stock_fhps_detail_em(symbol=code)
    except (ValueError, TypeError, KeyError):
        return pd.DataFrame()


def _safe_add_stock_em(code: str) -> pd.DataFrame:
    try:
        return ak.stock_add_stock(symbol=code)
    except Exception as exc:
        msg = str(exc)
        if "BaseException" in msg or "无增发记录" in msg:
            return pd.DataFrame()
        raise


class AkshareStockFactFeed:
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
        self._pledge_lock = asyncio.Lock()
        self._repurchase_lock = asyncio.Lock()
        self._pledge_cache: dict[date, tuple[date, dict[str, StockPledgeSnapshot]]] = {}
        self._repurchase_cache: tuple[date, dict[str, list[StockRepurchaseRecord]]] | None = None

    async def _run_call[T](self, code: str, source_name: str, fn: Callable[[], T]) -> T:
        try:
            return await run_akshare_call(
                fn,
                timeout_seconds=self._timeout_seconds,
                max_attempts=self._max_attempts,
                retry_wait_seconds=self._retry_wait_seconds,
            )
        except StockFactUnavailableError:
            raise
        except Exception as exc:
            msg = str(exc).strip()
            detail = f"{exc.__class__.__name__}: {msg}" if msg else exc.__class__.__name__
            raise StockFactUnavailableError(code, source_name, detail) from exc

    async def _fetch_bars_and_valuation(
        self,
        code: str,
        *,
        exchange: str,
        as_of: date | None,
    ) -> tuple[list[StockDailyBar], bool]:
        anchor = as_of or datetime.now(SHANGHAI_TZ).date()
        start_str = subtract_years(anchor, 11).strftime("%Y%m%d")
        end_str = anchor.strftime("%Y%m%d")
        sina_symbol = f"{exchange.lower()}{code}"

        used_tx_fallback = False
        try:
            bars_df = await self._run_call(
                code,
                "stock_zh_a_hist_sina",
                lambda: ak.stock_zh_a_hist_sina(
                    symbol=sina_symbol,
                    start_date=start_str,
                    end_date=end_str,
                ),
            )
        except Exception as primary_exc:
            logger.warning("Sina 个股日线失败 (%s)，切换至腾讯备用源: %s", code, primary_exc)
            used_tx_fallback = True
            bars_df = await self._run_call(
                code,
                "stock_zh_a_hist_tx",
                lambda: ak.stock_zh_a_hist_tx(
                    symbol=sina_symbol,
                    start_date=start_str,
                    end_date=end_str,
                ),
            )

        async def _safe_baidu_period(indicator: str, period: str) -> pd.DataFrame | None:
            def _fetch() -> pd.DataFrame:
                return ak.stock_zh_valuation_baidu(
                    symbol=code,
                    indicator=indicator,
                    period=period,
                )

            try:
                return await self._run_call(
                    code,
                    f"stock_zh_valuation_baidu:{indicator}:{period}",
                    _fetch,
                )
            except Exception as exc:
                logger.warning(
                    "百度估值指标 %s (%s) 获取失败 (%s): %s",
                    indicator,
                    period,
                    code,
                    exc,
                )
                return None

        async def _safe_baidu(indicator: str) -> pd.DataFrame | None:
            long_df, recent_df = await asyncio.gather(
                _safe_baidu_period(indicator, "近十年"),
                _safe_baidu_period(indicator, "近一年"),
            )
            frames = [df for df in (long_df, recent_df) if df is not None and not df.empty]
            if not frames:
                return None
            if len(frames) == 1:
                return frames[0]
            # Order long before recent so dense 1y rows override sparse 10y rows on shared dates.
            return pd.concat(frames, ignore_index=True)

        mv_df, pe_df, pb_df, pcf_df = await asyncio.gather(
            _safe_baidu("总市值"),
            _safe_baidu("市盈率(TTM)"),
            _safe_baidu("市净率"),
            _safe_baidu("市现率"),
        )
        bars = parse_daily_bars(
            bars_df,
            code,
            mv_df=mv_df,
            pe_df=pe_df,
            pb_df=pb_df,
            pcf_df=pcf_df,
            as_of=as_of,
        )
        return bars, used_tx_fallback

    async def _fetch_statements(
        self,
        code: str,
        *,
        exchange: str,
        as_of: date | None,
    ) -> list[StockAnnualReport]:
        em_symbol = f"{exchange.upper()}{code}"

        async def _safe_sheet(source: str, fn: Callable[[], pd.DataFrame]) -> pd.DataFrame | None:
            try:
                return await self._run_call(code, source, fn)
            except Exception as exc:
                logger.warning("东方财富报表 %s 获取失败 (%s): %s", source, code, exc)
                return None

        bs_df, ps_df, cf_df = await asyncio.gather(
            _safe_sheet(
                "stock_balance_sheet_by_report_em",
                lambda: ak.stock_balance_sheet_by_report_em(symbol=em_symbol),
            ),
            _safe_sheet(
                "stock_profit_sheet_by_report_em",
                lambda: ak.stock_profit_sheet_by_report_em(symbol=em_symbol),
            ),
            _safe_sheet(
                "stock_cash_flow_sheet_by_report_em",
                lambda: ak.stock_cash_flow_sheet_by_report_em(symbol=em_symbol),
            ),
        )
        if bs_df is None and ps_df is None and cf_df is None:
            raise StockFactUnavailableError(
                code, "eastmoney_statements", "三张财务报表全部获取失败"
            )

        return parse_annual_reports(
            code,
            balance_df=bs_df if bs_df is not None else pd.DataFrame(),
            profit_df=ps_df if ps_df is not None else pd.DataFrame(),
            cash_flow_df=cf_df if cf_df is not None else pd.DataFrame(),
            as_of=as_of,
        )

    async def _fetch_dividends(self, code: str, *, as_of: date | None) -> list[StockDividendRecord]:
        try:
            df = await self._run_call(
                code,
                "stock_fhps_detail_em",
                lambda: _safe_fhps_detail_em(code),
            )
            return parse_dividends(df, code, as_of=as_of)
        except Exception as exc:
            logger.warning("分红送配详情获取失败 (%s): %s", code, exc)
            return []

    async def _get_repurchases_for_code(
        self, code: str, *, as_of: date | None
    ) -> list[StockRepurchaseRecord]:
        today = datetime.now(SHANGHAI_TZ).date()
        async with self._repurchase_lock:
            if self._repurchase_cache is None or self._repurchase_cache[0] != today:
                try:
                    df = await self._run_call(
                        code,
                        "stock_repurchase_em",
                        ak.stock_repurchase_em,
                    )
                    self._repurchase_cache = (today, parse_repurchases(df))
                except Exception as exc:
                    logger.warning("全市场回购数据获取失败: %s", exc)
                    return []
            by_code = self._repurchase_cache[1]

        records = by_code.get(code, [])
        if as_of is None:
            return list(records)
        return [item for item in records if item.event_date <= as_of]

    async def _get_pledge_for_code(
        self, code: str, *, anchor_date: date
    ) -> StockPledgeSnapshot | None:
        days_since_friday = (anchor_date.weekday() - 4) % 7
        latest_friday = anchor_date - timedelta(days=days_since_friday)
        async with self._pledge_lock:
            cached = self._pledge_cache.get(latest_friday)
            if cached is None:
                for week_offset in range(_PLEDGE_LOOKBACK_WEEKS):
                    candidate_date = latest_friday - timedelta(weeks=week_offset)
                    date_str = candidate_date.strftime("%Y%m%d")

                    def _fetch_pledge(ds: str = date_str) -> pd.DataFrame:
                        return ak.stock_gpzy_pledge_ratio_em(date=ds)

                    try:
                        df = await self._run_call(
                            code,
                            "stock_gpzy_pledge_ratio_em",
                            _fetch_pledge,
                        )
                        parsed = parse_pledge_table(df)
                        if parsed is not None and parsed[0] <= anchor_date:
                            cached = parsed
                            self._pledge_cache[latest_friday] = parsed
                            break
                    except Exception as exc:
                        logger.debug("质押日期 %s 查询无果: %s", date_str, exc)

        if cached is None:
            return None
        pledge_date, pledge_by_code = cached
        if pledge_date > anchor_date:
            return None
        existing = pledge_by_code.get(code)
        if existing is not None:
            if existing.trade_date > anchor_date:
                return None
            return existing
        # Explicit 0.0% snapshot when the global pledge table succeeded and omitted the stock.
        return StockPledgeSnapshot(
            code=code,
            trade_date=pledge_date,
            pledge_ratio_pct=0.0,
        )

    async def _fetch_add_stock(
        self, code: str, *, as_of: date | None
    ) -> list[StockEquityFinancingRecord]:
        try:
            df = await self._run_call(
                code,
                "stock_add_stock",
                lambda: _safe_add_stock_em(code),
            )
            return parse_add_stock(df, code, as_of=as_of)
        except Exception as exc:
            logger.warning("新浪增发记录获取跳过 (%s): %s", code, exc)
            return []

    async def fetch_stock_bundle(self, code: str, *, as_of: date | None = None) -> StockFactBundle:
        exchange = infer_exchange(code)
        if exchange is None:
            raise StockFactUnavailableError(code, "exchange", f"不支持的股票代码前缀: {code}")

        bars, used_tx = await self._fetch_bars_and_valuation(code, exchange=exchange, as_of=as_of)
        resolved_as_of = as_of or bars[-1].trade_date

        reports = await self._fetch_statements(code, exchange=exchange, as_of=resolved_as_of)
        dividends, repurchases, pledge, add_stocks = await asyncio.gather(
            self._fetch_dividends(code, as_of=resolved_as_of),
            self._get_repurchases_for_code(code, as_of=resolved_as_of),
            self._get_pledge_for_code(code, anchor_date=resolved_as_of),
            self._fetch_add_stock(code, as_of=resolved_as_of),
        )
        cf_financings = extract_cf_equity_financings(code, reports)

        return StockFactBundle(
            code=code,
            as_of=resolved_as_of,
            data_source="akshare:tx" if used_tx else "akshare",
            daily_bars=bars,
            annual_reports=reports,
            dividends=dividends,
            repurchases=repurchases,
            pledge=pledge,
            equity_financings=[*cf_financings, *add_stocks],
        )
