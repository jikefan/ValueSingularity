"""PostgreSQL event repository — tenant-scoped SQL persistence for user audit events."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import UserEvent
from app.db.session import DatabaseUnavailableError
from app.domain.models import UserEventCreate, UserEventItem


def _to_domain(row: UserEvent) -> UserEventItem:
    return UserEventItem.model_validate(
        {
            "id": row.id,
            "type": row.type,
            "code": row.code,
            "meta": row.meta,
            "ts": row.ts,
        }
    )


class PostgresEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self, user_id: UUID, *, limit: int = 50) -> list[UserEventItem]:
        bounded_limit = max(1, min(limit, 200))
        stmt = (
            select(UserEvent)
            .where(UserEvent.user_id == user_id)
            .order_by(UserEvent.ts.desc(), UserEvent.id.desc())
            .limit(bounded_limit)
        )
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return [_to_domain(row) for row in rows]

    async def record(self, user_id: UUID, payload: UserEventCreate) -> UserEventItem:
        meta_json: dict[str, Any] | None = dict(payload.meta) if payload.meta is not None else None
        row = UserEvent(
            user_id=user_id,
            type=payload.type,
            code=payload.code,
            meta=meta_json,
        )
        self._session.add(row)
        try:
            await self._session.commit()
            await self._session.refresh(row)
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return _to_domain(row)
