"""PostgreSQL repository for per-user AI preferences, BYOK config, and daily quota."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Setting
from app.db.session import DatabaseUnavailableError
from app.domain.models import StoredAiConfig

_AI_PREFS_KEY = "ai_prefs"
_AI_USAGE_KEY = "ai_usage"


class PostgresAiRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_config(self, user_id: UUID) -> StoredAiConfig:
        stmt = select(Setting).where(
            Setting.user_id == user_id,
            Setting.key == _AI_PREFS_KEY,
        )
        try:
            row = await self._session.scalar(stmt)
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None or not isinstance(row.value, dict):
            return StoredAiConfig()
        return StoredAiConfig.model_validate(row.value)

    async def save_config(self, user_id: UUID, config: StoredAiConfig) -> StoredAiConfig:
        value_json = config.model_dump(mode="json")
        stmt = (
            pg_insert(Setting)
            .values(
                user_id=user_id,
                key=_AI_PREFS_KEY,
                value=value_json,
            )
            .on_conflict_do_update(
                index_elements=["user_id", "key"],
                set_={"value": value_json},
            )
        )
        try:
            await self._session.execute(stmt)
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return config

    async def get_usage_today(self, user_id: UUID, day_shanghai: str) -> int:
        stmt = select(Setting).where(
            Setting.user_id == user_id,
            Setting.key == _AI_USAGE_KEY,
        )
        try:
            row = await self._session.scalar(stmt)
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None or not isinstance(row.value, dict):
            return 0
        if row.value.get("date") != day_shanghai:
            return 0
        raw_count = row.value.get("count", 0)
        if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count >= 0:
            return raw_count
        return 0

    async def try_consume_quota(
        self,
        user_id: UUID,
        day_shanghai: str,
        daily_limit: int,
    ) -> tuple[bool, int]:
        seed_stmt = (
            pg_insert(Setting)
            .values(
                user_id=user_id,
                key=_AI_USAGE_KEY,
                value={"date": day_shanghai, "count": 0},
            )
            .on_conflict_do_nothing(index_elements=["user_id", "key"])
        )
        lock_stmt = (
            select(Setting)
            .where(Setting.user_id == user_id, Setting.key == _AI_USAGE_KEY)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        try:
            await self._session.execute(seed_stmt)
            row = await self._session.scalar(lock_stmt)
            if row is None:
                await self._session.rollback()
                raise DatabaseUnavailableError("MissingAiUsageRow")

            raw_val = row.value if isinstance(row.value, dict) else {}
            raw_count = raw_val.get("count", 0)
            current_count = (
                raw_count
                if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count >= 0
                else 0
            )
            if raw_val.get("date") != day_shanghai:
                current_count = 0

            if current_count >= daily_limit:
                await self._session.rollback()
                return False, current_count

            next_count = current_count + 1
            await self._session.execute(
                update(Setting)
                .where(Setting.user_id == user_id, Setting.key == _AI_USAGE_KEY)
                .values(value={"date": day_shanghai, "count": next_count})
            )
            await self._session.commit()
            return True, next_count
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

    async def refund_quota(self, user_id: UUID, day_shanghai: str) -> int:
        lock_stmt = (
            select(Setting)
            .where(Setting.user_id == user_id, Setting.key == _AI_USAGE_KEY)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        try:
            row = await self._session.scalar(lock_stmt)
            if row is None or not isinstance(row.value, dict):
                await self._session.rollback()
                return 0
            if row.value.get("date") != day_shanghai:
                await self._session.rollback()
                return 0

            raw_count = row.value.get("count", 0)
            current_count = (
                raw_count
                if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count >= 0
                else 0
            )
            next_count = max(0, current_count - 1)
            await self._session.execute(
                update(Setting)
                .where(Setting.user_id == user_id, Setting.key == _AI_USAGE_KEY)
                .values(value={"date": day_shanghai, "count": next_count})
            )
            await self._session.commit()
            return next_count
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

    async def release_read_transaction(self) -> None:
        if self._session.in_transaction():
            await self._session.rollback()
