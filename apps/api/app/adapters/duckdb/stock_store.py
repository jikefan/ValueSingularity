"""DuckDB + Parquet fact store for per-stock daily bars, financials, dividends, and pledges."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any, Literal, cast

import duckdb
import pyarrow as pa

from app.adapters.duckdb.parquet_io import (
    _upsert_parquet,
    coerce_date,
    coerce_optional_date,
    coerce_optional_float,
    coerce_optional_str,
)
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
)

STOCK_DAILY_BAR_SCHEMA = pa.schema(
    [
        ("code", pa.string()),
        ("trade_date", pa.date32()),
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("volume", pa.float64()),
        ("amount", pa.float64()),
        ("outstanding_share", pa.float64()),
        ("turnover", pa.float64()),
        ("total_mv_yuan", pa.float64()),
        ("pe_ttm", pa.float64()),
        ("pb", pa.float64()),
        ("pcf", pa.float64()),
    ]
)

STOCK_ANNUAL_REPORT_SCHEMA = pa.schema(
    [
        ("code", pa.string()),
        ("report_year", pa.int32()),
        ("report_date", pa.date32()),
        ("notice_date", pa.date32()),
        ("update_date", pa.date32()),
        ("audit_opinion", pa.string()),
        ("revenue_yuan", pa.float64()),
        ("operate_cost_yuan", pa.float64()),
        ("net_profit_yuan", pa.float64()),
        ("deduct_net_profit_yuan", pa.float64()),
        ("research_expense_yuan", pa.float64()),
        ("interest_expense_yuan", pa.float64()),
        ("finance_expense_yuan", pa.float64()),
        ("total_assets_yuan", pa.float64()),
        ("total_liabilities_yuan", pa.float64()),
        ("total_equity_yuan", pa.float64()),
        ("parent_equity_yuan", pa.float64()),
        ("monetary_funds_yuan", pa.float64()),
        ("trade_fin_assets_yuan", pa.float64()),
        ("short_loan_yuan", pa.float64()),
        ("noncurrent_liab_1y_yuan", pa.float64()),
        ("long_loan_yuan", pa.float64()),
        ("bond_payable_yuan", pa.float64()),
        ("short_bond_payable_yuan", pa.float64()),
        ("lease_liab_yuan", pa.float64()),
        ("cip_yuan", pa.float64()),
        ("fixed_asset_yuan", pa.float64()),
        ("accounts_receivable_yuan", pa.float64()),
        ("note_accounts_rece_yuan", pa.float64()),
        ("inventory_yuan", pa.float64()),
        ("goodwill_yuan", pa.float64()),
        ("share_capital_yuan", pa.float64()),
        ("ocf_yuan", pa.float64()),
        ("capex_yuan", pa.float64()),
        ("accept_invest_cash_yuan", pa.float64()),
        ("subsidiary_accept_invest_yuan", pa.float64()),
        ("cash_dividend_paid_yuan", pa.float64()),
    ]
)

DIVIDEND_REPURCHASE_SCHEMA = pa.schema(
    [
        ("record_type", pa.string()),
        ("code", pa.string()),
        ("primary_date", pa.date32()),
        ("secondary_date", pa.date32()),
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

PLEDGE_FINANCING_SCHEMA = pa.schema(
    [
        ("record_type", pa.string()),
        ("code", pa.string()),
        ("event_date", pa.date32()),
        ("year", pa.int32()),
        ("source", pa.string()),
        ("financing_type", pa.string()),
        ("amount_yuan", pa.float64()),
        ("pledge_ratio_pct", pa.float64()),
        ("pledge_shares", pa.float64()),
        ("pledge_market_cap_yuan", pa.float64()),
    ]
)

_ANNUAL_FLOAT_FIELDS: tuple[str, ...] = (
    "revenue_yuan",
    "operate_cost_yuan",
    "net_profit_yuan",
    "deduct_net_profit_yuan",
    "research_expense_yuan",
    "interest_expense_yuan",
    "finance_expense_yuan",
    "total_assets_yuan",
    "total_liabilities_yuan",
    "total_equity_yuan",
    "parent_equity_yuan",
    "monetary_funds_yuan",
    "trade_fin_assets_yuan",
    "short_loan_yuan",
    "noncurrent_liab_1y_yuan",
    "long_loan_yuan",
    "bond_payable_yuan",
    "short_bond_payable_yuan",
    "lease_liab_yuan",
    "cip_yuan",
    "fixed_asset_yuan",
    "accounts_receivable_yuan",
    "note_accounts_rece_yuan",
    "inventory_yuan",
    "goodwill_yuan",
    "share_capital_yuan",
    "ocf_yuan",
    "capex_yuan",
    "accept_invest_cash_yuan",
    "subsidiary_accept_invest_yuan",
    "cash_dividend_paid_yuan",
)

_BAR_OPTIONAL_FLOAT_FIELDS: tuple[str, ...] = (
    "volume",
    "amount",
    "outstanding_share",
    "turnover",
    "total_mv_yuan",
    "pe_ttm",
    "pb",
    "pcf",
)


def _normalize_bar_row(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "code": str(row["code"]),
        "trade_date": coerce_date(row["trade_date"]),
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
    }
    for field in _BAR_OPTIONAL_FLOAT_FIELDS:
        out[field] = coerce_optional_float(row.get(field))
    return out


def _normalize_annual_row(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "code": str(row["code"]),
        "report_year": int(row["report_year"]),
        "report_date": coerce_date(row["report_date"]),
        "notice_date": coerce_optional_date(row.get("notice_date")),
        "update_date": coerce_optional_date(row.get("update_date")),
        "audit_opinion": coerce_optional_str(row.get("audit_opinion")),
    }
    for field in _ANNUAL_FLOAT_FIELDS:
        out[field] = coerce_optional_float(row.get(field))
    return out


def _normalize_div_rep_row(row: dict[str, Any]) -> dict[str, Any]:
    record_type = str(row["record_type"])
    primary_date = coerce_date(row["primary_date"])
    notice_date = coerce_optional_date(row.get("notice_date"))
    secondary_date = coerce_optional_date(row.get("secondary_date"))
    if secondary_date is None and record_type == "repurchase":
        secondary_date = notice_date or primary_date
    return {
        "record_type": record_type,
        "code": str(row["code"]),
        "primary_date": primary_date,
        "secondary_date": secondary_date,
        "notice_date": notice_date,
        "year": int(row["year"]),
        "progress": str(row["progress"]),
        "cash_per_10_shares": coerce_optional_float(row.get("cash_per_10_shares")),
        "total_shares": coerce_optional_float(row.get("total_shares")),
        "amount_yuan": float(row["amount_yuan"]),
        "repurchased_shares": coerce_optional_float(row.get("repurchased_shares")),
        "dividend_yield_pct": coerce_optional_float(row.get("dividend_yield_pct")),
    }


def _normalize_pledge_fin_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_type": str(row["record_type"]),
        "code": str(row["code"]),
        "event_date": coerce_date(row["event_date"]),
        "year": int(row["year"]),
        "source": coerce_optional_str(row.get("source")),
        "financing_type": coerce_optional_str(row.get("financing_type")),
        "amount_yuan": coerce_optional_float(row.get("amount_yuan")),
        "pledge_ratio_pct": coerce_optional_float(row.get("pledge_ratio_pct")),
        "pledge_shares": coerce_optional_float(row.get("pledge_shares")),
        "pledge_market_cap_yuan": coerce_optional_float(row.get("pledge_market_cap_yuan")),
    }


def _dividend_to_row(item: StockDividendRecord) -> dict[str, Any]:
    return {
        "record_type": "dividend",
        "code": item.code,
        "primary_date": item.report_date,
        "secondary_date": item.ex_dividend_date,
        "notice_date": item.notice_date,
        "year": item.report_year,
        "progress": item.plan_progress,
        "cash_per_10_shares": float(item.cash_per_10_shares),
        "total_shares": float(item.total_shares),
        "amount_yuan": float(item.dividend_cash_total_yuan),
        "repurchased_shares": None,
        "dividend_yield_pct": coerce_optional_float(item.dividend_yield_pct),
    }


def _repurchase_to_row(item: StockRepurchaseRecord) -> dict[str, Any]:
    return {
        "record_type": "repurchase",
        "code": item.code,
        "primary_date": item.start_date or item.event_date,
        "secondary_date": item.event_date,
        "notice_date": item.event_date,
        "year": item.year,
        "progress": item.progress,
        "cash_per_10_shares": None,
        "total_shares": None,
        "amount_yuan": float(item.repurchased_amount_yuan),
        "repurchased_shares": coerce_optional_float(item.repurchased_shares),
        "dividend_yield_pct": None,
    }


def _pledge_to_row(item: StockPledgeSnapshot) -> dict[str, Any]:
    return {
        "record_type": "pledge",
        "code": item.code,
        "event_date": item.trade_date,
        "year": item.trade_date.year,
        "source": None,
        "financing_type": None,
        "amount_yuan": None,
        "pledge_ratio_pct": float(item.pledge_ratio_pct),
        "pledge_shares": coerce_optional_float(item.pledge_shares),
        "pledge_market_cap_yuan": coerce_optional_float(item.pledge_market_cap_yuan),
    }


def _financing_to_row(item: StockEquityFinancingRecord) -> dict[str, Any]:
    return {
        "record_type": "equity_financing",
        "code": item.code,
        "event_date": item.event_date,
        "year": item.year,
        "source": item.source,
        "financing_type": item.financing_type,
        "amount_yuan": float(item.amount_yuan),
        "pledge_ratio_pct": None,
        "pledge_shares": None,
        "pledge_market_cap_yuan": None,
    }


def _sync_write_stock_facts(data_dir: Path, bundle: StockFactBundle) -> None:
    bars_by_year: dict[int, list[StockDailyBar]] = defaultdict(list)
    for bar in bundle.daily_bars:
        bars_by_year[bar.trade_date.year].append(bar)

    for year, bars in bars_by_year.items():
        path = data_dir / "bars" / "daily" / f"year={year}" / "data.parquet"
        _upsert_parquet(
            path,
            STOCK_DAILY_BAR_SCHEMA,
            bars,
            normalize_existing=_normalize_bar_row,
            key_of=lambda r: (str(r["code"]), coerce_date(r["trade_date"])),
            sort_key=lambda pair: (pair[0], pair[1]),
            lock_path=path.parent / f".{path.name}.lock",
        )

    reports_by_year: dict[int, list[StockAnnualReport]] = defaultdict(list)
    for report in bundle.annual_reports:
        reports_by_year[report.report_year].append(report)

    for year, reports in reports_by_year.items():
        path = data_dir / "fundamentals" / "annual" / f"report_year={year}" / "data.parquet"
        _upsert_parquet(
            path,
            STOCK_ANNUAL_REPORT_SCHEMA,
            reports,
            normalize_existing=_normalize_annual_row,
            key_of=lambda r: (str(r["code"]), int(r["report_year"])),
            sort_key=lambda pair: (pair[0], pair[1]),
            lock_path=path.parent / f".{path.name}.lock",
        )

    div_rep_rows = [
        *(_dividend_to_row(item) for item in bundle.dividends),
        *(_repurchase_to_row(item) for item in bundle.repurchases),
    ]
    div_rep_path = data_dir / "fundamentals" / "dividends_repurchase" / "all.parquet"
    if div_rep_rows or div_rep_path.exists():
        _upsert_parquet(
            div_rep_path,
            DIVIDEND_REPURCHASE_SCHEMA,
            div_rep_rows,
            normalize_existing=_normalize_div_rep_row,
            key_of=lambda r: (
                str(r["code"]),
                str(r["record_type"]),
                coerce_date(r["primary_date"]),
                coerce_optional_date(r.get("secondary_date"))
                or coerce_optional_date(r.get("notice_date"))
                or coerce_date(r["primary_date"]),
            ),
            sort_key=lambda key: (key[0], key[1], key[2], key[3]),
            prune_existing=lambda r: (
                str(r["code"]) == bundle.code
                and str(r["record_type"]) in {"dividend", "repurchase"}
            ),
            lock_path=div_rep_path.parent / f".{div_rep_path.name}.lock",
        )

    pledge_fin_rows: list[dict[str, Any]] = []
    if bundle.pledge is not None:
        pledge_fin_rows.append(_pledge_to_row(bundle.pledge))
    pledge_fin_rows.extend(_financing_to_row(item) for item in bundle.equity_financings)
    pledge_fin_path = data_dir / "fundamentals" / "pledge_financing" / "all.parquet"
    if pledge_fin_rows or pledge_fin_path.exists():
        _upsert_parquet(
            pledge_fin_path,
            PLEDGE_FINANCING_SCHEMA,
            pledge_fin_rows,
            normalize_existing=_normalize_pledge_fin_row,
            key_of=lambda r: (
                str(r["code"]),
                str(r["record_type"]),
                coerce_date(r["event_date"]),
                str(r.get("source") or ""),
                str(r.get("financing_type") or ""),
            ),
            sort_key=lambda key: (key[0], key[1], key[2], key[3], key[4]),
            prune_existing=lambda r: (
                str(r["code"]) == bundle.code and str(r["record_type"]) == "equity_financing"
            ),
            lock_path=pledge_fin_path.parent / f".{pledge_fin_path.name}.lock",
        )


def _fetch_dicts(
    con: duckdb.DuckDBPyConnection, query: str, params: Sequence[Any]
) -> list[dict[str, Any]]:
    cursor = con.execute(query, list(params))
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row, strict=True)) for row in cursor.fetchall()]


def _sync_load_stock_facts(
    data_dir: Path,
    code: str,
    *,
    as_of: date | None = None,
) -> StockFactBundle | None:
    bars: list[StockDailyBar] = []
    annual_reports: list[StockAnnualReport] = []
    dividends: list[StockDividendRecord] = []
    repurchases: list[StockRepurchaseRecord] = []
    pledge: StockPledgeSnapshot | None = None
    equity_financings: list[StockEquityFinancingRecord] = []

    con = duckdb.connect(":memory:")
    try:
        bars_dir = data_dir / "bars" / "daily"
        if any(bars_dir.glob("*/*.parquet")):
            bars_glob = str(bars_dir / "*" / "*.parquet")
            if as_of is not None:
                bar_rows = _fetch_dicts(
                    con,
                    """
                    SELECT code, trade_date, open, high, low, close, volume, amount,
                           outstanding_share, turnover, total_mv_yuan, pe_ttm, pb, pcf
                    FROM read_parquet(?, hive_partitioning=true)
                    WHERE code = ? AND trade_date <= ?
                    ORDER BY trade_date ASC
                    """,
                    [bars_glob, code, as_of],
                )
            else:
                bar_rows = _fetch_dicts(
                    con,
                    """
                    SELECT code, trade_date, open, high, low, close, volume, amount,
                           outstanding_share, turnover, total_mv_yuan, pe_ttm, pb, pcf
                    FROM read_parquet(?, hive_partitioning=true)
                    WHERE code = ?
                    ORDER BY trade_date ASC
                    """,
                    [bars_glob, code],
                )
            bars = [StockDailyBar.model_validate(_normalize_bar_row(r)) for r in bar_rows]

        annual_dir = data_dir / "fundamentals" / "annual"
        if any(annual_dir.glob("*/*.parquet")):
            annual_glob = str(annual_dir / "*" / "*.parquet")
            if as_of is not None:
                annual_rows = _fetch_dicts(
                    con,
                    """
                    SELECT * EXCLUDE (report_year), report_year
                    FROM read_parquet(?, hive_partitioning=true)
                    WHERE code = ? AND report_date <= ?
                    ORDER BY report_year ASC
                    """,
                    [annual_glob, code, as_of],
                )
            else:
                annual_rows = _fetch_dicts(
                    con,
                    """
                    SELECT * EXCLUDE (report_year), report_year
                    FROM read_parquet(?, hive_partitioning=true)
                    WHERE code = ?
                    ORDER BY report_year ASC
                    """,
                    [annual_glob, code],
                )
            for raw_annual in annual_rows:
                report = StockAnnualReport.model_validate(_normalize_annual_row(raw_annual))
                if as_of is not None and (
                    report.report_date > as_of
                    or (report.notice_date is not None and report.notice_date > as_of)
                ):
                    continue
                annual_reports.append(report)

        div_rep_path = data_dir / "fundamentals" / "dividends_repurchase" / "all.parquet"
        if div_rep_path.exists():
            div_rep_rows = _fetch_dicts(
                con,
                "SELECT * FROM read_parquet(?) WHERE code = ? ORDER BY primary_date ASC",
                [str(div_rep_path), code],
            )
            for raw in div_rep_rows:
                norm = _normalize_div_rep_row(raw)
                if norm["record_type"] == "dividend":
                    if as_of is not None and (
                        norm["primary_date"] > as_of
                        or (norm["notice_date"] is not None and norm["notice_date"] > as_of)
                    ):
                        continue
                    dividends.append(
                        StockDividendRecord(
                            code=norm["code"],
                            report_date=norm["primary_date"],
                            report_year=norm["year"],
                            ex_dividend_date=norm["secondary_date"],
                            notice_date=norm["notice_date"],
                            plan_progress=norm["progress"],
                            cash_per_10_shares=float(norm["cash_per_10_shares"] or 0.0),
                            total_shares=float(norm["total_shares"] or 1.0),
                            dividend_cash_total_yuan=norm["amount_yuan"],
                            dividend_yield_pct=norm["dividend_yield_pct"],
                        )
                    )
                elif norm["record_type"] == "repurchase":
                    event_dt = norm["secondary_date"] or norm["primary_date"]
                    if as_of is not None and event_dt > as_of:
                        continue
                    repurchases.append(
                        StockRepurchaseRecord(
                            code=norm["code"],
                            event_date=event_dt,
                            year=norm["year"],
                            start_date=norm["primary_date"],
                            progress=norm["progress"],
                            repurchased_amount_yuan=norm["amount_yuan"],
                            repurchased_shares=norm["repurchased_shares"],
                        )
                    )
            repurchases.sort(key=lambda item: (item.event_date, item.start_date or date.min))

        pledge_fin_path = data_dir / "fundamentals" / "pledge_financing" / "all.parquet"
        if pledge_fin_path.exists():
            pf_rows = _fetch_dicts(
                con,
                "SELECT * FROM read_parquet(?) WHERE code = ? ORDER BY event_date ASC",
                [str(pledge_fin_path), code],
            )
            pledge_candidates: list[StockPledgeSnapshot] = []
            for raw in pf_rows:
                norm = _normalize_pledge_fin_row(raw)
                if as_of is not None and norm["event_date"] > as_of:
                    continue
                if norm["record_type"] == "pledge" and norm["pledge_ratio_pct"] is not None:
                    pledge_candidates.append(
                        StockPledgeSnapshot(
                            code=norm["code"],
                            trade_date=norm["event_date"],
                            pledge_ratio_pct=norm["pledge_ratio_pct"],
                            pledge_shares=norm["pledge_shares"],
                            pledge_market_cap_yuan=norm["pledge_market_cap_yuan"],
                        )
                    )
                elif norm["record_type"] == "equity_financing" and norm["amount_yuan"] is not None:
                    source_val = cast(
                        Literal["cash_flow", "add_stock"],
                        norm["source"]
                        if norm["source"] in {"cash_flow", "add_stock"}
                        else "cash_flow",
                    )
                    equity_financings.append(
                        StockEquityFinancingRecord(
                            code=norm["code"],
                            year=norm["year"],
                            event_date=norm["event_date"],
                            source=source_val,
                            financing_type=norm["financing_type"] or "股权融资",
                            amount_yuan=norm["amount_yuan"],
                        )
                    )
            if pledge_candidates:
                pledge = pledge_candidates[-1]
    finally:
        con.close()

    if (
        not bars
        and not annual_reports
        and not dividends
        and not repurchases
        and pledge is None
        and not equity_financings
    ):
        return None

    inferred_as_of = as_of
    if inferred_as_of is None:
        candidate_dates: list[date] = []
        if bars:
            candidate_dates.append(bars[-1].trade_date)
        if annual_reports:
            candidate_dates.append(annual_reports[-1].report_date)
        if dividends:
            candidate_dates.append(dividends[-1].report_date)
        if repurchases:
            candidate_dates.append(repurchases[-1].event_date)
        if equity_financings:
            candidate_dates.append(equity_financings[-1].event_date)
        if pledge is not None:
            candidate_dates.append(pledge.trade_date)
        inferred_as_of = max(candidate_dates)

    return StockFactBundle(
        code=code,
        as_of=inferred_as_of,
        data_source="parquet",
        daily_bars=bars,
        annual_reports=annual_reports,
        dividends=dividends,
        repurchases=repurchases,
        pledge=pledge,
        equity_financings=equity_financings,
    )


class DuckDBStockFactStore:
    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir

    async def write_stock_facts(self, bundle: StockFactBundle) -> None:
        await asyncio.to_thread(_sync_write_stock_facts, self._data_dir, bundle)

    async def load_stock_facts(
        self, code: str, *, as_of: date | None = None
    ) -> StockFactBundle | None:
        return await asyncio.to_thread(_sync_load_stock_facts, self._data_dir, code, as_of=as_of)
