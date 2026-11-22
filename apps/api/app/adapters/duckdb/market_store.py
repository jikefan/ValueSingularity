"""DuckDB + Parquet fact store for market metadata, index daily bars, and macro rates."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa

from app.adapters.duckdb.parquet_io import (
    _upsert_parquet,
    coerce_date,
    coerce_optional_date,
    coerce_optional_float,
    coerce_optional_str,
    file_lock,
)
from app.domain.market_math import subtract_years
from app.domain.models import (
    IndexDailyRow,
    MacroRateRow,
    StockMetaRecord,
    TradeCalendarEntry,
)

STOCK_LIST_SCHEMA = pa.schema(
    [
        ("code", pa.string()),
        ("name", pa.string()),
        ("exchange", pa.string()),
        ("industry_sw1", pa.string()),
        ("industry_sw2", pa.string()),
        ("list_date", pa.date32()),
        ("is_st", pa.bool_()),
        ("is_active", pa.bool_()),
    ]
)

TRADE_CALENDAR_SCHEMA = pa.schema(
    [
        ("trade_date", pa.date32()),
        ("is_open", pa.bool_()),
    ]
)

INDEX_DAILY_SCHEMA = pa.schema(
    [
        ("code", pa.string()),
        ("trade_date", pa.date32()),
        ("close", pa.float64()),
        ("change_pct", pa.float64()),
        ("pe_ttm", pa.float64()),
        ("pb", pa.float64()),
        ("turnover", pa.float64()),
    ]
)

MACRO_RATES_SCHEMA = pa.schema(
    [
        ("trade_date", pa.date32()),
        ("cn_10y_bond_yield", pa.float64()),
        ("market_pe_median", pa.float64()),
    ]
)


def _normalize_stock_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row["code"]),
        "name": str(row["name"]),
        "exchange": str(row["exchange"]),
        "industry_sw1": coerce_optional_str(row.get("industry_sw1")),
        "industry_sw2": coerce_optional_str(row.get("industry_sw2")),
        "list_date": coerce_optional_date(row.get("list_date")),
        "is_st": bool(row["is_st"]),
        "is_active": bool(row["is_active"]),
    }


def _merge_stock_meta_row(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(incoming)
    for col in ("industry_sw1", "industry_sw2", "list_date"):
        if merged.get(col) is None and existing.get(col) is not None:
            merged[col] = existing[col]
    return merged


def _normalize_trade_calendar_row(row: dict[str, Any]) -> dict[str, Any]:
    return {"trade_date": coerce_date(row["trade_date"]), "is_open": bool(row["is_open"])}


def _normalize_index_daily_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row["code"]),
        "trade_date": coerce_date(row["trade_date"]),
        "close": float(row["close"]),
        "change_pct": float(row["change_pct"]),
        "pe_ttm": coerce_optional_float(row.get("pe_ttm")),
        "pb": coerce_optional_float(row.get("pb")),
        "turnover": coerce_optional_float(row.get("turnover")),
    }


def _normalize_macro_rate_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "trade_date": coerce_date(row["trade_date"]),
        "cn_10y_bond_yield": float(row["cn_10y_bond_yield"]),
        "market_pe_median": float(row["market_pe_median"]),
    }


def _sync_write_meta_facts(
    meta_dir: Path,
    *,
    stock_list: Sequence[StockMetaRecord],
    trade_calendar: Sequence[TradeCalendarEntry],
    index_daily: Sequence[IndexDailyRow],
    macro_rates: Sequence[MacroRateRow],
) -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    with file_lock(meta_dir / ".sync.lock"):
        _upsert_parquet(
            meta_dir / "stock_list.parquet",
            STOCK_LIST_SCHEMA,
            stock_list,
            normalize_existing=_normalize_stock_row,
            key_of=lambda r: str(r["code"]),
            sort_key=lambda code: code,
            merge_existing=_merge_stock_meta_row,
            deactivate_missing=True,
            skip_if_empty_and_exists=True,
        )
        _upsert_parquet(
            meta_dir / "trade_calendar.parquet",
            TRADE_CALENDAR_SCHEMA,
            trade_calendar,
            normalize_existing=_normalize_trade_calendar_row,
            key_of=lambda r: coerce_date(r["trade_date"]),
            sort_key=lambda d: d,
        )
        _upsert_parquet(
            meta_dir / "index_daily.parquet",
            INDEX_DAILY_SCHEMA,
            index_daily,
            normalize_existing=_normalize_index_daily_row,
            key_of=lambda r: (str(r["code"]), coerce_date(r["trade_date"])),
            sort_key=lambda pair: (pair[1], pair[0]),
        )
        _upsert_parquet(
            meta_dir / "macro_rates.parquet",
            MACRO_RATES_SCHEMA,
            macro_rates,
            normalize_existing=_normalize_macro_rate_row,
            key_of=lambda r: coerce_date(r["trade_date"]),
            sort_key=lambda d: d,
        )


def _sync_load_macro_history(
    macro_path: Path,
    as_of: date,
    lookback_years: int,
) -> list[MacroRateRow]:
    if not macro_path.exists():
        return []
    start_date = subtract_years(as_of, lookback_years)
    con = duckdb.connect(":memory:")
    try:
        rows = con.execute(
            """
            SELECT trade_date, cn_10y_bond_yield, market_pe_median
            FROM read_parquet(?)
            WHERE trade_date BETWEEN ? AND ?
            ORDER BY trade_date ASC
            """,
            [str(macro_path), start_date, as_of],
        ).fetchall()
    finally:
        con.close()

    return [
        MacroRateRow(
            trade_date=coerce_date(row[0]),
            cn_10y_bond_yield=float(row[1]),
            market_pe_median=float(row[2]),
        )
        for row in rows
    ]


class DuckDBMarketFactStore:
    def __init__(self, data_dir: Path) -> None:
        self._meta_dir = data_dir / "meta"

    async def write_meta_facts(
        self,
        *,
        stock_list: Sequence[StockMetaRecord],
        trade_calendar: Sequence[TradeCalendarEntry],
        index_daily: Sequence[IndexDailyRow],
        macro_rates: Sequence[MacroRateRow],
    ) -> None:
        await asyncio.to_thread(
            _sync_write_meta_facts,
            self._meta_dir,
            stock_list=list(stock_list),
            trade_calendar=list(trade_calendar),
            index_daily=list(index_daily),
            macro_rates=list(macro_rates),
        )

    async def load_macro_history(self, as_of: date, lookback_years: int = 10) -> list[MacroRateRow]:
        return await asyncio.to_thread(
            _sync_load_macro_history,
            self._meta_dir / "macro_rates.parquet",
            as_of,
            lookback_years,
        )
