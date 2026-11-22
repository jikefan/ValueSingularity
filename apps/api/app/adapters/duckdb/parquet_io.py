"""Shared atomic Parquet I/O and file-locking utilities for DuckDB fact stores."""

from __future__ import annotations

import fcntl
import math
import os
import tempfile
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

if TYPE_CHECKING:
    from _typeshed import SupportsRichComparison


def coerce_date(value: object) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def coerce_optional_date(value: object) -> date | None:
    if value is None:
        return None
    return coerce_date(value)


def coerce_optional_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        num = float(str(value)) if not isinstance(value, int | float) else float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def coerce_optional_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@contextmanager
def file_lock(lock_path: Path) -> Iterator[None]:
    """Acquire an exclusive advisory lock around Parquet read-merge-write cycles."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def atomic_write_parquet(target: Path, table: pa.Table) -> None:
    """Write a PyArrow table atomically via temp file + 0o644 chmod + os.replace."""
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


def _read_parquet(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = pq.read_table(path).to_pylist()
    return rows


def _upsert_parquet[K](
    path: Path,
    schema: pa.Schema,
    incoming: Sequence[BaseModel] | Sequence[dict[str, Any]],
    *,
    normalize_existing: Callable[[dict[str, Any]], dict[str, Any]],
    key_of: Callable[[dict[str, Any]], K],
    sort_key: Callable[[K], SupportsRichComparison],
    merge_existing: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]] | None = None,
    prune_existing: Callable[[dict[str, Any]], bool] | None = None,
    deactivate_missing: bool = False,
    skip_if_empty_and_exists: bool = False,
    lock_path: Path | None = None,
) -> None:
    if skip_if_empty_and_exists and not incoming and path.exists():
        return

    def _run_upsert() -> None:
        merged: dict[K, dict[str, Any]] = {}
        for raw in _read_parquet(path):
            row = normalize_existing(raw)
            if prune_existing is not None and prune_existing(row):
                continue
            if deactivate_missing and incoming:
                row["is_active"] = False
            merged[key_of(row)] = row

        for item in incoming:
            new_row = item.model_dump(mode="python") if isinstance(item, BaseModel) else dict(item)
            key = key_of(new_row)
            if merge_existing is not None and key in merged:
                new_row = merge_existing(merged[key], new_row)
            merged[key] = new_row

        ordered = [merged[k] for k in sorted(merged, key=sort_key)]
        atomic_write_parquet(path, pa.Table.from_pylist(ordered, schema=schema))

    if lock_path is not None:
        with file_lock(lock_path):
            _run_upsert()
    else:
        _run_upsert()
