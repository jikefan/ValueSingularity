"""PostgreSQL journal repository — tenant-scoped SQL persistence for decision logs."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import JournalEntry
from app.db.session import DatabaseUnavailableError
from app.domain.models import FalsifyRule, JournalAction, JournalCreate, JournalEntryItem


def _to_float(val: Decimal | None) -> float | None:
    return float(val) if val is not None else None


def _to_decimal(val: float | None) -> Decimal | None:
    return Decimal(str(val)) if val is not None else None


def _to_domain(row: JournalEntry) -> JournalEntryItem:
    rules = (
        [FalsifyRule.model_validate(rule) for rule in row.falsify_rules]
        if row.falsify_rules is not None
        else None
    )
    return JournalEntryItem(
        id=row.id,
        code=row.code,
        name=row.name,
        action=JournalAction(row.action),
        reason=row.reason,
        falsify_condition=row.falsify_condition,
        falsify_rules=rules,
        max_drawdown=_to_float(row.max_drawdown),
        emotion=row.emotion,
        price=_to_float(row.price),
        benchmark_code=row.benchmark_code,
        benchmark_price=_to_float(row.benchmark_price),
        created_at=row.created_at,
    )


class PostgresJournalRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(
        self,
        user_id: UUID,
        *,
        code: str | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        bounded_limit = max(1, min(limit, 200))
        stmt = select(JournalEntry).where(JournalEntry.user_id == user_id)
        if code is not None:
            stmt = stmt.where(JournalEntry.code == code)
        stmt = stmt.order_by(JournalEntry.created_at.desc(), JournalEntry.id.desc()).limit(
            bounded_limit
        )
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return [_to_domain(row) for row in rows]

    async def create(self, user_id: UUID, payload: JournalCreate) -> JournalEntryItem:
        rules_json: list[dict[str, Any]] | None = (
            [rule.model_dump(mode="json") for rule in payload.falsify_rules]
            if payload.falsify_rules is not None
            else None
        )
        row = JournalEntry(
            user_id=user_id,
            code=payload.code,
            name=payload.name,
            action=payload.action.value,
            reason=payload.reason,
            falsify_condition=payload.falsify_condition,
            falsify_rules=rules_json,
            max_drawdown=_to_decimal(payload.max_drawdown),
            emotion=payload.emotion,
            price=_to_decimal(payload.price),
            benchmark_code=payload.benchmark_code,
            benchmark_price=_to_decimal(payload.benchmark_price),
        )
        self._session.add(row)
        try:
            await self._session.commit()
            await self._session.refresh(row)
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return _to_domain(row)

    async def remove(self, user_id: UUID, entry_id: int) -> bool:
        try:
            result = await self._session.execute(
                delete(JournalEntry).where(
                    JournalEntry.user_id == user_id,
                    JournalEntry.id == entry_id,
                )
            )
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return isinstance(result, CursorResult) and result.rowcount > 0
