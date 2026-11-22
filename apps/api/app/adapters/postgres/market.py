"""PostgreSQL repositories for market snapshots and shared stock metadata."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MarketSnapshot, StockMeta
from app.db.session import DatabaseUnavailableError
from app.domain.errors import MarketSnapshotUnavailableError
from app.domain.models import MarketOverview, StockMetaRecord

_STOCK_META_BATCH_SIZE = 1000


class PostgresMarketRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def overview(self) -> MarketOverview:
        try:
            row = await self._session.scalar(select(MarketSnapshot).where(MarketSnapshot.id == 1))
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None:
            raise MarketSnapshotUnavailableError()
        return MarketOverview.model_validate(row.payload)

    async def save_overview(self, snapshot: MarketOverview) -> None:
        now = datetime.now(UTC)
        payload = snapshot.model_dump(mode="json")
        stmt = (
            pg_insert(MarketSnapshot)
            .values(
                id=1,
                as_of=snapshot.as_of,
                payload=payload,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "as_of": snapshot.as_of,
                    "payload": payload,
                    "updated_at": now,
                },
            )
        )
        try:
            await self._session.execute(stmt)
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise


class PostgresStockMetaRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
        if not items:
            return 0

        deduped = {item.code: item for item in items}
        ordered = [deduped[code] for code in sorted(deduped)]
        now = datetime.now(UTC)

        try:
            for offset in range(0, len(ordered), _STOCK_META_BATCH_SIZE):
                chunk = ordered[offset : offset + _STOCK_META_BATCH_SIZE]
                values = [
                    {
                        "code": item.code,
                        "name": item.name,
                        "exchange": item.exchange,
                        "industry_sw1": item.industry_sw1,
                        "industry_sw2": item.industry_sw2,
                        "list_date": item.list_date,
                        "is_st": item.is_st,
                        "is_active": item.is_active,
                        "updated_at": now,
                    }
                    for item in chunk
                ]
                stmt = pg_insert(StockMeta).values(values)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["code"],
                    set_={
                        "name": stmt.excluded.name,
                        "exchange": stmt.excluded.exchange,
                        "industry_sw1": stmt.excluded.industry_sw1,
                        "industry_sw2": stmt.excluded.industry_sw2,
                        "list_date": stmt.excluded.list_date,
                        "is_st": stmt.excluded.is_st,
                        "is_active": stmt.excluded.is_active,
                        "updated_at": now,
                    },
                )
                await self._session.execute(stmt)
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise

        return len(ordered)
