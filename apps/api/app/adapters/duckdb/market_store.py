"""DuckDB + Parquet fact store for market metadata, index daily bars, and macro rates."""

from __future__ import annotations

import asyncio
import fcntl
import os
import tempfile
from collections.abc import Callable, Sequence
from datetime import date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

if TYPE_CHECKING:
    from _typeshed import SupportsRichComparison

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
        os.chmod(tmp_path, 0o644)
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


def _normalize_stock_row(row: dict[str, Any]) -> dict[str, Any]:
    list_date_raw = row.get("list_date")
    return {
        "code": str(row["code"]),
        "name": str(row["name"]),
        "exchange": str(row["exchange"]),
        "industry_sw1": str(row["industry_sw1"]) if row.get("industry_sw1") is not None else None,
        "industry_sw2": str(row["industry_sw2"]) if row.get("industry_sw2") is not None else None,
        "list_date": _coerce_date(list_date_raw) if list_date_raw is not None else None,
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
    return {"trade_date": _coerce_date(row["trade_date"]), "is_open": bool(row["is_open"])}


def _normalize_index_daily_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row["code"]),
        "trade_date": _coerce_date(row["trade_date"]),
        "close": float(row["close"]),
        "change_pct": float(row["change_pct"]),
        "pe_ttm": float(row["pe_ttm"]) if row["pe_ttm"] is not None else None,
        "pb": float(row["pb"]) if row["pb"] is not None else None,
        "turnover": float(row["turnover"]) if row["turnover"] is not None else None,
    }


def _normalize_macro_rate_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "trade_date": _coerce_date(row["trade_date"]),
        "cn_10y_bond_yield": float(row["cn_10y_bond_yield"]),
        "market_pe_median": float(row["market_pe_median"]),
    }


def _upsert_parquet[K](
    path: Path,
    schema: pa.Schema,
    incoming: Sequence[BaseModel],
    *,
    normalize_existing: Callable[[dict[str, Any]], dict[str, Any]],
    key_of: Callable[[dict[str, Any]], K],
    sort_key: Callable[[K], SupportsRichComparison],
    merge_existing: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] | None = None,
    deactivate_missing: bool = False,
    skip_if_empty_and_exists: bool = False,
) -> None:
    if skip_if_empty_and_exists and not incoming and path.exists():
        return

    merged: dict[K, dict[str, Any]] = {}
    for raw in _read_existing_rows(path):
        row = normalize_existing(raw)
        if deactivate_missing and incoming:
            row["is_active"] = False
        merged[key_of(row)] = row

    for item in incoming:
        new_row = item.model_dump(mode="python")
        key = key_of(new_row)
        if merge_existing is not None and key in merged:
            new_row = merge_existing(merged[key], new_row)
        merged[key] = new_row

    ordered = [merged[k] for k in sorted(merged, key=sort_key)]
    _atomic_write_parquet(path, pa.Table.from_pylist(ordered, schema=schema))


def _sync_write_meta_facts(
    meta_dir: Path,
    *,
    stock_list: Sequence[StockMetaRecord],
    trade_calendar: Sequence[TradeCalendarEntry],
    index_daily: Sequence[IndexDailyRow],
    macro_rates: Sequence[MacroRateRow],
) -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    lock_path = meta_dir / ".sync.lock"
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
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
                key_of=lambda r: _coerce_date(r["trade_date"]),
                sort_key=lambda d: d,
            )
            _upsert_parquet(
                meta_dir / "index_daily.parquet",
                INDEX_DAILY_SCHEMA,
                index_daily,
                normalize_existing=_normalize_index_daily_row,
                key_of=lambda r: (str(r["code"]), _coerce_date(r["trade_date"])),
                sort_key=lambda pair: (pair[1], pair[0]),
            )
            _upsert_parquet(
                meta_dir / "macro_rates.parquet",
                MACRO_RATES_SCHEMA,
                macro_rates,
                normalize_existing=_normalize_macro_rate_row,
                key_of=lambda r: _coerce_date(r["trade_date"]),
                sort_key=lambda d: d,
            )
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


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
