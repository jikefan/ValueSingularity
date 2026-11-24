"""PostgreSQL repository for precomputed per-stock snapshots."""

from __future__ import annotations

import asyncio
import time
import weakref
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import Select, case, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import StockSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.models import StockSnapshotPayload
from app.settings import settings

_SUMMARY_CACHE: dict[int, tuple[float, list[StockSnapshotPayload]]] = {}
_SUMMARY_LOCKS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[int, asyncio.Lock]] = (
    weakref.WeakKeyDictionary()
)


def _build_slim_payload_expr() -> Any:
    p = StockSnapshot.payload
    empty_array = func.jsonb_build_array()
    empty_object = func.jsonb_build_object()

    def _slim_array_section(section: str, key: str) -> Any:
        sec = p[section]
        return case(
            (
                func.jsonb_typeof(sec) == "object",
                sec.op("-")(key).op("||")(func.jsonb_build_object(key, empty_array)),
            ),
            else_=sec,
        )

    forensics = p["forensics"]
    slim_forensics = case(
        (
            func.jsonb_typeof(forensics) == "object",
            forensics.op("-")("annual_decomposition").op("-")("dupont_series").op("-")("findings"),
        ),
        else_=forensics,
    )

    # Guard with jsonb_typeof(p) == "object" so corrupt scalars skip on ValidationError
    # rather than failing SQL `-`.
    return case(
        (
            func.jsonb_typeof(p) == "object",
            p.op("-")("annual_trends")
            .op("-")("formula_notes")
            .op("||")(
                func.jsonb_build_object(
                    "annual_trends",
                    empty_array,
                    "formula_notes",
                    empty_object,
                    "valuation",
                    _slim_array_section("valuation", "history"),
                    "financial_ct",
                    _slim_array_section("financial_ct", "checks"),
                    "shareholder_return",
                    _slim_array_section("shareholder_return", "series"),
                    "reverse_dcf",
                    _slim_array_section("reverse_dcf", "sensitivity"),
                    "moat",
                    _slim_array_section("moat", "dimensions"),
                    "forensics",
                    slim_forensics,
                )
            ),
        ),
        else_=p,
    )


_SLIM_PAYLOAD_EXPR = _build_slim_payload_expr()


def _is_postgresql_bind(bind: Any) -> bool:
    return getattr(getattr(bind, "dialect", None), "name", None) == "postgresql"


def _get_summary_lock(bind_key: int) -> asyncio.Lock:
    # Locks are bound to the active event loop so multi-loop test runners never share a Lock.
    loop = asyncio.get_running_loop()
    loop_locks = _SUMMARY_LOCKS.setdefault(loop, {})
    lock = loop_locks.get(bind_key)
    if lock is None:
        lock = asyncio.Lock()
        loop_locks[bind_key] = lock
    return lock


class PostgresStockSnapshotRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
        try:
            row = await self._session.get(StockSnapshot, code)
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None:
            return None
        return StockSnapshotPayload.model_validate(row.payload)

    async def get_snapshots_for_compare(
        self, codes: Sequence[str]
    ) -> dict[str, StockSnapshotPayload]:
        unique_codes = list(dict.fromkeys(codes))
        if not unique_codes:
            return {}
        stmt = select(StockSnapshot).where(StockSnapshot.code.in_(unique_codes))
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return {row.code: StockSnapshotPayload.model_validate(row.payload) for row in rows}

    async def _load_all_snapshots(self, bind: Any) -> list[StockSnapshotPayload]:
        stmt: Select[Any] = (
            select(_SLIM_PAYLOAD_EXPR) if _is_postgresql_bind(bind) else select(StockSnapshot)
        ).order_by(StockSnapshot.code.asc())
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        payloads = [row.payload if hasattr(row, "payload") else row for row in rows]
        if not payloads:
            return []

        def _validate_all(raw_payloads: list[Any]) -> list[StockSnapshotPayload]:
            items: list[StockSnapshotPayload] = []
            for raw in raw_payloads:
                try:
                    items.append(StockSnapshotPayload.model_validate(raw))
                except ValidationError:
                    continue
            return items

        return await asyncio.to_thread(_validate_all, payloads)

    async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
        bind = getattr(self._session, "bind", None)
        ttl = settings.snapshot_summary_cache_ttl_seconds
        if bind is None or ttl <= 0:
            return await self._load_all_snapshots(bind)

        bind_key = id(bind)
        cached = _SUMMARY_CACHE.get(bind_key)
        if cached is not None and cached[0] > time.monotonic():
            return list(cached[1])

        lock = _get_summary_lock(bind_key)
        async with lock:
            cached = _SUMMARY_CACHE.get(bind_key)
            if cached is not None and cached[0] > time.monotonic():
                return list(cached[1])

            items = await self._load_all_snapshots(bind)
            _SUMMARY_CACHE[bind_key] = (time.monotonic() + ttl, list(items))
            return list(items)

    async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
        now = datetime.now(UTC)
        payload = snapshot.model_dump(mode="json")
        stmt = (
            pg_insert(StockSnapshot)
            .values(
                code=snapshot.code,
                as_of=snapshot.as_of,
                payload=payload,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["code"],
                set_={
                    "as_of": snapshot.as_of,
                    "payload": payload,
                    "updated_at": now,
                },
                where=(StockSnapshot.as_of <= snapshot.as_of),
            )
        )
        try:
            await self._session.execute(stmt)
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        except Exception:
            await self._session.rollback()
            raise

        bind = getattr(self._session, "bind", None)
        if bind is not None:
            _SUMMARY_CACHE.pop(id(bind), None)
