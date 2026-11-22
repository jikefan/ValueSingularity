"""PostgreSQL repositories for user accounts and refresh tokens."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RefreshToken as RefreshTokenRow
from app.db.models import User as UserRow
from app.domain.errors import EmailAlreadyRegisteredError
from app.domain.models import PlanTier, RefreshTokenRecord, UserAuthRecord


def _to_user_record(row: UserRow) -> UserAuthRecord:
    return UserAuthRecord(
        id=row.id,
        email=row.email,
        phone=row.phone,
        display_name=row.display_name,
        plan_tier=PlanTier(row.plan_tier),
        plan_expires_at=row.plan_expires_at,
        created_at=row.created_at,
        password_hash=row.password_hash,
        is_active=row.is_active,
    )


def _to_token_record(row: RefreshTokenRow) -> RefreshTokenRecord:
    return RefreshTokenRecord(
        id=row.id,
        user_id=row.user_id,
        token_hash=row.token_hash,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
    )


class PostgresUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(
        self,
        *,
        email: str,
        password_hash: str,
        display_name: str,
        plan_tier: PlanTier,
    ) -> UserAuthRecord:
        row = UserRow(
            email=email,
            password_hash=password_hash,
            display_name=display_name,
            plan_tier=plan_tier.value,
        )
        self._session.add(row)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            await self._session.rollback()
            raise EmailAlreadyRegisteredError(email) from exc
        await self._session.refresh(row)
        return _to_user_record(row)

    async def get_by_email(self, email: str) -> UserAuthRecord | None:
        row = await self._session.scalar(select(UserRow).where(UserRow.email == email))
        return _to_user_record(row) if row else None

    async def get_by_id(self, user_id: UUID) -> UserAuthRecord | None:
        row = await self._session.get(UserRow, user_id)
        return _to_user_record(row) if row else None


class PostgresRefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def create(
        self,
        *,
        user_id: UUID,
        token_hash: str,
        expires_at: datetime,
        user_agent: str | None,
    ) -> RefreshTokenRecord:
        row = RefreshTokenRow(
            user_id=user_id,
            token_hash=token_hash,
            expires_at=expires_at,
            user_agent=user_agent[:255] if user_agent else None,
        )
        self._session.add(row)
        await self._session.commit()
        await self._session.refresh(row)
        return _to_token_record(row)

    async def get_by_hash(self, token_hash: str) -> RefreshTokenRecord | None:
        row = await self._session.scalar(
            select(RefreshTokenRow).where(RefreshTokenRow.token_hash == token_hash)
        )
        return _to_token_record(row) if row else None

    async def revoke(self, token_id: UUID, revoked_at: datetime) -> None:
        await self._session.execute(
            update(RefreshTokenRow)
            .where(RefreshTokenRow.id == token_id, RefreshTokenRow.revoked_at.is_(None))
            .values(revoked_at=revoked_at)
        )
        await self._session.commit()

    async def revoke_all_for_user(self, user_id: UUID, revoked_at: datetime) -> None:
        await self._session.execute(
            update(RefreshTokenRow)
            .where(RefreshTokenRow.user_id == user_id, RefreshTokenRow.revoked_at.is_(None))
            .values(revoked_at=revoked_at)
        )
        await self._session.commit()
