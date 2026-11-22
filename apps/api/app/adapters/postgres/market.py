"""PostgreSQL repositories for market snapshots and shared stock metadata."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import String, all_, bindparam, case, func, literal, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MarketSnapshot, StockMeta, StockSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.errors import MarketSnapshotUnavailableError
from app.domain.models import MarketOverview, StockDetail, StockMetaRecord

_STOCK_META_BATCH_SIZE = 1000


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _to_stock_meta_record(row: StockMeta) -> StockMetaRecord:
    return StockMetaRecord.model_validate(
        {
            "code": row.code,
            "name": row.name,
            "exchange": row.exchange,
            "industry_sw1": row.industry_sw1,
            "industry_sw2": row.industry_sw2,
            "list_date": row.list_date,
            "is_st": row.is_st,
            "is_active": row.is_active,
        }
    )


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
                where=(MarketSnapshot.as_of <= snapshot.as_of),
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

    async def upsert_many(
        self,
        items: Sequence[StockMetaRecord],
        *,
        deactivate_missing: bool = True,
    ) -> int:
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
                        "industry_sw1": func.coalesce(
                            stmt.excluded.industry_sw1, StockMeta.industry_sw1
                        ),
                        "industry_sw2": func.coalesce(
                            stmt.excluded.industry_sw2, StockMeta.industry_sw2
                        ),
                        "list_date": func.coalesce(stmt.excluded.list_date, StockMeta.list_date),
                        "is_st": stmt.excluded.is_st,
                        "is_active": stmt.excluded.is_active,
                        "updated_at": now,
                    },
                )
                await self._session.execute(stmt)

            if deactivate_missing:
                active_codes = [item.code for item in ordered]
                await self._session.execute(
                    update(StockMeta)
                    .where(
                        StockMeta.is_active.is_(True),
                        StockMeta.code
                        != all_(bindparam("active_codes", value=active_codes, type_=ARRAY(String))),
                    )
                    .values(is_active=False, updated_at=now)
                )
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise

        return len(ordered)

    async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
        cleaned = query.strip()
        if not cleaned:
            return []

        bounded_limit = max(1, min(limit, 20))
        escaped = _escape_like(cleaned)
        prefix_pattern = f"{escaped}%"
        substring_pattern = f"%{escaped}%"

        match_rank = case(
            (StockMeta.code == cleaned, 0),
            (
                or_(
                    StockMeta.code.ilike(prefix_pattern, escape="\\"),
                    StockMeta.name.ilike(prefix_pattern, escape="\\"),
                ),
                1,
            ),
            else_=2,
        )
        stmt = (
            select(StockMeta)
            .where(
                or_(
                    StockMeta.code.ilike(substring_pattern, escape="\\"),
                    StockMeta.name.ilike(substring_pattern, escape="\\"),
                )
            )
            .order_by(match_rank.asc(), StockMeta.is_active.desc(), StockMeta.code.asc())
            .limit(bounded_limit)
        )
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        return [_to_stock_meta_record(row) for row in rows]

    async def get_detail(self, code: str) -> StockDetail | None:
        try:
            row = await self._session.get(StockMeta, code)
            if row is None:
                return None
            snapshot_exists = await self._session.scalar(
                select(literal(1))
                .select_from(StockSnapshot)
                .where(StockSnapshot.code == code)
                .limit(1)
            )
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        meta = _to_stock_meta_record(row)
        return StockDetail(
            code=meta.code,
            name=meta.name,
            exchange=meta.exchange,
            industry_sw1=meta.industry_sw1,
            industry_sw2=meta.industry_sw2,
            list_date=meta.list_date,
            is_st=meta.is_st,
            is_active=meta.is_active,
            snapshot_available=snapshot_exists is not None,
        )
