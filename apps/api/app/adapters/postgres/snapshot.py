"""PostgreSQL repository for precomputed per-stock snapshots."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import StockSnapshot
from app.db.session import DatabaseUnavailableError
from app.domain.models import StockSnapshotPayload


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

    async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
        stmt = select(StockSnapshot).order_by(StockSnapshot.code.asc())
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        items: list[StockSnapshotPayload] = []
        for row in rows:
            try:
                items.append(StockSnapshotPayload.model_validate(row.payload))
            except ValidationError:
                continue
        return items

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
