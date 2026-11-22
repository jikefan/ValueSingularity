"""DuckDB + Parquet fact store for market metadata, index daily bars, and macro rates."""

from __future__ import annotations

import asyncio
import os
import tempfile
from collections.abc import Sequence
from datetime import date, datetime
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

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


def _coerce_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _atomic_write_parquet(target: Path, table: pa.Table) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=".tmp",
    )
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        pq.write_table(table, tmp_path, compression="snappy")
        os.replace(tmp_path, target)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise


def _read_existing_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = pq.read_table(path).to_pylist()
    return rows


def _sync_write_meta_facts(
    meta_dir: Path,
    *,
    stock_list: Sequence[StockMetaRecord],
    trade_calendar: Sequence[TradeCalendarEntry],
    index_daily: Sequence[IndexDailyRow],
    macro_rates: Sequence[MacroRateRow],
) -> None:
    stock_by_code = {item.code: item.model_dump(mode="python") for item in stock_list}
    ordered_stocks = [stock_by_code[code] for code in sorted(stock_by_code)]
    _atomic_write_parquet(
        meta_dir / "stock_list.parquet",
        pa.Table.from_pylist(ordered_stocks, schema=STOCK_LIST_SCHEMA),
    )

    cal_path = meta_dir / "trade_calendar.parquet"
    cal_by_date: dict[date, dict[str, Any]] = {}
    for row in _read_existing_rows(cal_path):
        d = _coerce_date(row["trade_date"])
        cal_by_date[d] = {"trade_date": d, "is_open": bool(row["is_open"])}
    for cal_entry in trade_calendar:
        cal_by_date[cal_entry.trade_date] = cal_entry.model_dump(mode="python")
    ordered_cal = [cal_by_date[d] for d in sorted(cal_by_date)]
    _atomic_write_parquet(
        cal_path,
        pa.Table.from_pylist(ordered_cal, schema=TRADE_CALENDAR_SCHEMA),
    )

    index_path = meta_dir / "index_daily.parquet"
    index_by_key: dict[tuple[str, date], dict[str, Any]] = {}
    for row in _read_existing_rows(index_path):
        key = (str(row["code"]), _coerce_date(row["trade_date"]))
        index_by_key[key] = {
            "code": key[0],
            "trade_date": key[1],
            "close": float(row["close"]),
            "change_pct": float(row["change_pct"]),
            "pe_ttm": float(row["pe_ttm"]) if row["pe_ttm"] is not None else None,
            "pb": float(row["pb"]) if row["pb"] is not None else None,
            "turnover": float(row["turnover"]) if row["turnover"] is not None else None,
        }
    for idx_row in index_daily:
        index_by_key[(idx_row.code, idx_row.trade_date)] = idx_row.model_dump(mode="python")
    ordered_index = [
        index_by_key[k] for k in sorted(index_by_key, key=lambda pair: (pair[1], pair[0]))
    ]
    _atomic_write_parquet(
        index_path,
        pa.Table.from_pylist(ordered_index, schema=INDEX_DAILY_SCHEMA),
    )

    macro_path = meta_dir / "macro_rates.parquet"
    macro_by_date: dict[date, dict[str, Any]] = {}
    for row in _read_existing_rows(macro_path):
        d = _coerce_date(row["trade_date"])
        macro_by_date[d] = {
            "trade_date": d,
            "cn_10y_bond_yield": float(row["cn_10y_bond_yield"]),
            "market_pe_median": float(row["market_pe_median"]),
        }
    for macro_row in macro_rates:
        macro_by_date[macro_row.trade_date] = macro_row.model_dump(mode="python")
    ordered_macro = [macro_by_date[d] for d in sorted(macro_by_date)]
    _atomic_write_parquet(
        macro_path,
        pa.Table.from_pylist(ordered_macro, schema=MACRO_RATES_SCHEMA),
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
            trade_date=_coerce_date(row[0]),
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
