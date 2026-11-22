"""PostgreSQL watchlist repository — the only place that knows SQL for this table."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import WatchlistItem as WatchlistRow
from app.domain.models import WatchlistItem, WatchlistUpsert


def _to_float(val: Decimal | None) -> float | None:
    return float(val) if val is not None else None


def _to_decimal(val: float | None) -> Decimal | None:
    return Decimal(str(val)) if val is not None else None


def _to_domain(row: WatchlistRow) -> WatchlistItem:
    return WatchlistItem(
        code=row.code,
        name=row.name,
        industry=row.industry,
        note=row.note,
        target_price=_to_float(row.target_price),
        target_pe_percentile=_to_float(row.target_pe_percentile),
        target_dividend_yield=_to_float(row.target_dividend_yield),
        alert_enabled=row.alert_enabled,
        added_at=row.added_at,
        updated_at=row.updated_at,
    )


class PostgresWatchlistRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self, user_id: UUID) -> list[WatchlistItem]:
        rows = (
            await self._session.scalars(
                select(WatchlistRow)
                .where(WatchlistRow.user_id == user_id)
                .order_by(WatchlistRow.added_at.desc())
            )
        ).all()
        return [_to_domain(row) for row in rows]

    async def get(self, user_id: UUID, code: str) -> WatchlistItem | None:
        row = await self._session.scalar(
            select(WatchlistRow).where(WatchlistRow.user_id == user_id, WatchlistRow.code == code)
        )
        return _to_domain(row) if row else None

    async def upsert(self, user_id: UUID, payload: WatchlistUpsert) -> WatchlistItem:
        now = datetime.now(UTC)
        target_price = _to_decimal(payload.target_price)
        target_pe_percentile = _to_decimal(payload.target_pe_percentile)
        target_dividend_yield = _to_decimal(payload.target_dividend_yield)

        stmt = (
            pg_insert(WatchlistRow)
            .values(
                user_id=user_id,
                code=payload.code,
                name=payload.name,
                industry=payload.industry,
                note=payload.note,
                target_price=target_price,
                target_pe_percentile=target_pe_percentile,
                target_dividend_yield=target_dividend_yield,
                alert_enabled=payload.alert_enabled,
            )
            .on_conflict_do_update(
                index_elements=["user_id", "code"],
                set_={
                    "name": payload.name,
                    "industry": payload.industry,
                    "note": payload.note,
                    "target_price": target_price,
                    "target_pe_percentile": target_pe_percentile,
                    "target_dividend_yield": target_dividend_yield,
                    "alert_enabled": payload.alert_enabled,
                    "updated_at": now,
                },
            )
            .returning(WatchlistRow)
            .execution_options(populate_existing=True)
        )
        row = (await self._session.scalars(stmt)).one()
        item = _to_domain(row)
        await self._session.commit()
        return item

    async def remove(self, user_id: UUID, code: str) -> bool:
        result = await self._session.execute(
            delete(WatchlistRow).where(WatchlistRow.user_id == user_id, WatchlistRow.code == code)
        )
        await self._session.commit()
        return isinstance(result, CursorResult) and result.rowcount > 0
