"""PostgreSQL watchlist repository — the only place that knows SQL for this table."""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import WatchlistItem as WatchlistRow
from app.domain.models import WatchlistItem, WatchlistUpsert


def _to_domain(row: WatchlistRow) -> WatchlistItem:
    return WatchlistItem(
        code=row.code,
        name=row.name,
        industry=row.industry,
        note=row.note,
        added_at=row.added_at,
    )


class PostgresWatchlistRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self) -> list[WatchlistItem]:
        rows = (
            await self._session.scalars(select(WatchlistRow).order_by(WatchlistRow.added_at.desc()))
        ).all()
        return [_to_domain(row) for row in rows]

    async def get(self, code: str) -> WatchlistItem | None:
        row = await self._session.get(WatchlistRow, code)
        return _to_domain(row) if row else None

    async def upsert(self, payload: WatchlistUpsert) -> WatchlistItem:
        row = await self._session.get(WatchlistRow, payload.code)
        if row is None:
            row = WatchlistRow(**payload.model_dump())
            self._session.add(row)
        else:
            for field, value in payload.model_dump(exclude={"code"}).items():
                setattr(row, field, value)
        await self._session.commit()
        await self._session.refresh(row)
        return _to_domain(row)

    async def remove(self, code: str) -> bool:
        result = await self._session.execute(delete(WatchlistRow).where(WatchlistRow.code == code))
        await self._session.commit()
        return isinstance(result, CursorResult) and result.rowcount > 0
