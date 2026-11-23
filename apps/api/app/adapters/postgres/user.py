"""PostgreSQL repositories for user accounts, refresh tokens, and email OTP codes."""

from __future__ import annotations

import hmac
import math
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import EmailVerificationCode as EmailVerificationCodeRow
from app.db.models import RefreshToken as RefreshTokenRow
from app.db.models import User as UserRow
from app.domain.errors import (
    EmailAlreadyRegisteredError,
    EmailCodeCooldownError,
    EmailCodeRateLimitError,
    UserNotFoundError,
)
from app.domain.models import (
    EmailCodePurpose,
    PasswordChangeResult,
    PasswordChangeStatus,
    PasswordResetStatus,
    PlanTier,
    RefreshRotationResult,
    RefreshRotationStatus,
    RefreshTokenRecord,
    UserAuthRecord,
)


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _to_user_record(row: UserRow) -> UserAuthRecord:
    return UserAuthRecord(
        id=row.id,
        email=row.email,
        phone=row.phone,
        display_name=row.display_name,
        email_verified=row.email_verified_at is not None,
        plan_tier=PlanTier(row.plan_tier),
        plan_expires_at=row.plan_expires_at,
        created_at=row.created_at,
        password_hash=row.password_hash,
        is_active=row.is_active,
        email_verified_at=row.email_verified_at,
        token_version=row.token_version,
    )


def _to_token_record(row: RefreshTokenRow) -> RefreshTokenRecord:
    return RefreshTokenRecord(
        id=row.id,
        user_id=row.user_id,
        family_id=row.family_id,
        token_hash=row.token_hash,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        revoked_reason=row.revoked_reason,
    )


async def _verify_and_consume_in_session(
    session: AsyncSession,
    *,
    email: str,
    purpose: EmailCodePurpose,
    code_hash: str,
    now: datetime,
    max_attempts: int,
) -> tuple[bool, bool]:
    """Check, increment attempts, and consume the latest OTP row without committing."""
    row = await session.scalar(
        select(EmailVerificationCodeRow)
        .where(
            EmailVerificationCodeRow.email == email,
            EmailVerificationCodeRow.purpose == purpose,
        )
        .order_by(
            EmailVerificationCodeRow.created_at.desc(),
            EmailVerificationCodeRow.id.desc(),
        )
        .limit(1)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        row is None
        or row.consumed_at is not None
        or _as_utc(row.expires_at) <= _as_utc(now)
        or row.attempt_count >= max_attempts
    ):
        return False, False
    if not hmac.compare_digest(row.code_hash, code_hash):
        row.attempt_count += 1
        return False, True
    row.consumed_at = now
    return True, True


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
        email_verified_at: datetime | None = None,
    ) -> UserAuthRecord:
        row = UserRow(
            email=email,
            password_hash=password_hash,
            display_name=display_name,
            plan_tier=plan_tier.value,
            email_verified_at=email_verified_at,
        )
        self._session.add(row)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            await self._session.rollback()
            if getattr(exc.orig, "sqlstate", None) == "23505":
                raise EmailAlreadyRegisteredError(email) from exc
            raise
        await self._session.refresh(row)
        return _to_user_record(row)

    async def get_by_email(self, email: str) -> UserAuthRecord | None:
        row = await self._session.scalar(
            select(UserRow).where(UserRow.email == email).execution_options(populate_existing=True)
        )
        return _to_user_record(row) if row else None

    async def get_by_id(self, user_id: UUID) -> UserAuthRecord | None:
        row = await self._session.scalar(
            select(UserRow).where(UserRow.id == user_id).execution_options(populate_existing=True)
        )
        return _to_user_record(row) if row else None

    async def mark_email_verified(
        self, user_id: UUID, verified_at: datetime
    ) -> UserAuthRecord | None:
        row = await self._session.scalar(
            update(UserRow)
            .where(UserRow.id == user_id)
            .values(email_verified_at=func.coalesce(UserRow.email_verified_at, verified_at))
            .returning(UserRow)
            .execution_options(populate_existing=True)
        )
        if row is None:
            await self._session.rollback()
            return None
        await self._session.commit()
        await self._session.refresh(row)
        return _to_user_record(row)

    async def update_display_name(self, user_id: UUID, display_name: str) -> UserAuthRecord | None:
        row = await self._session.scalar(
            update(UserRow)
            .where(UserRow.id == user_id)
            .values(display_name=display_name)
            .returning(UserRow)
            .execution_options(populate_existing=True)
        )
        if row is None:
            await self._session.rollback()
            return None
        await self._session.commit()
        await self._session.refresh(row)
        return _to_user_record(row)

    async def complete_password_reset(
        self,
        *,
        email: str,
        code_hash: str,
        password_hash: str,
        now: datetime,
        max_attempts: int = 5,
    ) -> PasswordResetStatus:
        user = await self._session.scalar(
            select(UserRow)
            .where(UserRow.email == email)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if user is None:
            await self._session.rollback()
            return PasswordResetStatus.INVALID_CODE

        matched, dirty = await _verify_and_consume_in_session(
            self._session,
            email=email,
            purpose="reset_password",
            code_hash=code_hash,
            now=now,
            max_attempts=max_attempts,
        )
        if not matched:
            if dirty:
                try:
                    await self._session.commit()
                except Exception:
                    await self._session.rollback()
                    raise
            else:
                await self._session.rollback()
            return PasswordResetStatus.INVALID_CODE

        if not user.is_active:
            try:
                await self._session.commit()
            except Exception:
                await self._session.rollback()
                raise
            return PasswordResetStatus.INACTIVE

        user.password_hash = password_hash
        user.token_version += 1
        if user.email_verified_at is None:
            user.email_verified_at = now
        await self._session.execute(
            update(RefreshTokenRow)
            .where(
                RefreshTokenRow.user_id == user.id,
                RefreshTokenRow.revoked_at.is_(None),
            )
            .values(revoked_at=now, revoked_reason="password_reset")
        )
        try:
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise
        return PasswordResetStatus.UPDATED

    async def complete_password_change(
        self,
        user_id: UUID,
        *,
        password_hash: str,
        new_token_hash: str,
        new_expires_at: datetime,
        now: datetime,
        user_agent: str | None,
    ) -> PasswordChangeResult:
        user = await self._session.scalar(
            select(UserRow)
            .where(UserRow.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if user is None:
            await self._session.rollback()
            return PasswordChangeResult(status=PasswordChangeStatus.NOT_FOUND)
        if not user.is_active:
            await self._session.rollback()
            return PasswordChangeResult(status=PasswordChangeStatus.INACTIVE)

        user.password_hash = password_hash
        user.token_version += 1
        await self._session.execute(
            update(RefreshTokenRow)
            .where(
                RefreshTokenRow.user_id == user_id,
                RefreshTokenRow.revoked_at.is_(None),
            )
            .values(revoked_at=now, revoked_reason="password_change")
        )
        self._session.add(
            RefreshTokenRow(
                user_id=user_id,
                family_id=uuid4(),
                token_hash=new_token_hash,
                expires_at=new_expires_at,
                user_agent=user_agent[:255] if user_agent else None,
            )
        )
        try:
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise
        await self._session.refresh(user)
        return PasswordChangeResult(
            status=PasswordChangeStatus.UPDATED,
            user=_to_user_record(user),
        )

    async def delete_user_account(self, user_id: UUID) -> bool:
        # Lock UserRow before deleting EmailVerificationCodeRow to match the global
        # UserRow -> child-table lock order used by password resets and rotations.
        user = await self._session.scalar(
            select(UserRow)
            .where(UserRow.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if user is None:
            await self._session.rollback()
            return False

        email = user.email.strip().lower() if user.email else None
        if email is not None:
            await self._session.execute(
                delete(EmailVerificationCodeRow).where(EmailVerificationCodeRow.email == email)
            )
        result = await self._session.execute(delete(UserRow).where(UserRow.id == user_id))
        try:
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise
        return isinstance(result, CursorResult) and result.rowcount > 0

    async def release_read_transaction(self) -> None:
        if self._session.in_transaction():
            await self._session.rollback()


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
        family_id: UUID | None = None,
    ) -> RefreshTokenRecord:
        row = RefreshTokenRow(
            user_id=user_id,
            family_id=family_id or uuid4(),
            token_hash=token_hash,
            expires_at=expires_at,
            user_agent=user_agent[:255] if user_agent else None,
        )
        self._session.add(row)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            await self._session.rollback()
            sqlstate = getattr(exc.orig, "sqlstate", None)
            if sqlstate == "23503" or (
                exc.orig is not None and "foreign key" in str(exc.orig).lower()
            ):
                raise UserNotFoundError() from exc
            raise
        await self._session.refresh(row)
        return _to_token_record(row)

    async def rotate_token(
        self,
        *,
        token_hash: str,
        new_token_hash: str,
        now: datetime,
        new_expires_at: datetime,
        user_agent: str | None,
    ) -> RefreshRotationResult:
        # Resolve user_id unlocked first so we can acquire UserRow -> RefreshTokenRow
        # in the same global lock order as password resets, changes, and deletions.
        user_id = await self._session.scalar(
            select(RefreshTokenRow.user_id).where(RefreshTokenRow.token_hash == token_hash)
        )
        if user_id is None:
            await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.NOT_FOUND)

        user = await self._session.scalar(
            select(UserRow)
            .where(UserRow.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if user is None:
            await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.NOT_FOUND)

        row = await self._session.scalar(
            select(RefreshTokenRow)
            .where(RefreshTokenRow.token_hash == token_hash)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if row is None:
            await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.NOT_FOUND)

        if not user.is_active:
            if row.revoked_at is None:
                row.revoked_at = now
                row.revoked_reason = "inactive_user"
                try:
                    await self._session.commit()
                except Exception:
                    await self._session.rollback()
                    raise
            else:
                await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.INACTIVE)

        if _as_utc(row.expires_at) <= _as_utc(now):
            await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.EXPIRED)

        if row.revoked_at is not None:
            # Only genuine rotation replay revokes unrevoked siblings in the same family;
            # stale refreshes of tokens revoked by logout or password updates fail in isolation.
            if row.revoked_reason == "rotated":
                await self._session.execute(
                    update(RefreshTokenRow)
                    .where(
                        RefreshTokenRow.user_id == row.user_id,
                        RefreshTokenRow.family_id == row.family_id,
                        RefreshTokenRow.revoked_at.is_(None),
                    )
                    .values(revoked_at=now, revoked_reason="replay_detected")
                )
                try:
                    await self._session.commit()
                except Exception:
                    await self._session.rollback()
                    raise
            else:
                await self._session.rollback()
            return RefreshRotationResult(status=RefreshRotationStatus.REPLAYED)

        user_record = _to_user_record(user)
        row.revoked_at = now
        row.revoked_reason = "rotated"
        self._session.add(
            RefreshTokenRow(
                user_id=row.user_id,
                family_id=row.family_id,
                token_hash=new_token_hash,
                expires_at=new_expires_at,
                user_agent=user_agent[:255] if user_agent else None,
            )
        )
        try:
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise
        return RefreshRotationResult(status=RefreshRotationStatus.ROTATED, user=user_record)

    async def revoke_by_hash(
        self, token_hash: str, revoked_at: datetime, reason: str = "logout"
    ) -> bool:
        result = await self._session.execute(
            update(RefreshTokenRow)
            .where(
                RefreshTokenRow.token_hash == token_hash,
                RefreshTokenRow.revoked_at.is_(None),
            )
            .values(revoked_at=revoked_at, revoked_reason=reason)
        )
        await self._session.commit()
        return isinstance(result, CursorResult) and result.rowcount > 0


class PostgresEmailVerificationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def try_issue_code(
        self,
        *,
        email: str,
        purpose: EmailCodePurpose,
        code_hash: str,
        expires_at: datetime,
        created_at: datetime,
        cooldown_seconds: int,
        hourly_limit: int,
        consumed_at: datetime | None = None,
    ) -> UUID:
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
            {"lock_key": f"email_otp:{email}"},
        )
        latest_created_at = await self._session.scalar(
            select(EmailVerificationCodeRow.created_at)
            .where(
                EmailVerificationCodeRow.email == email,
                EmailVerificationCodeRow.purpose == purpose,
            )
            .order_by(
                EmailVerificationCodeRow.created_at.desc(),
                EmailVerificationCodeRow.id.desc(),
            )
            .limit(1)
        )
        if latest_created_at is not None:
            elapsed = (_as_utc(created_at) - _as_utc(latest_created_at)).total_seconds()
            if elapsed < cooldown_seconds:
                retry_after = min(
                    cooldown_seconds,
                    max(1, math.ceil(cooldown_seconds - elapsed)),
                )
                await self._session.rollback()
                raise EmailCodeCooldownError(retry_after)

        recent_count = await self._session.scalar(
            select(func.count(EmailVerificationCodeRow.id)).where(
                EmailVerificationCodeRow.email == email,
                EmailVerificationCodeRow.created_at >= created_at - timedelta(hours=1),
            )
        )
        if int(recent_count or 0) >= hourly_limit:
            await self._session.rollback()
            raise EmailCodeRateLimitError()

        code_id = uuid4()
        self._session.add(
            EmailVerificationCodeRow(
                id=code_id,
                email=email,
                purpose=purpose,
                code_hash=code_hash,
                expires_at=expires_at,
                consumed_at=consumed_at,
                created_at=created_at,
            )
        )
        try:
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise
        return code_id

    async def delete_code_by_id(self, code_id: UUID) -> None:
        await self._session.execute(
            delete(EmailVerificationCodeRow).where(EmailVerificationCodeRow.id == code_id)
        )
        await self._session.commit()

    async def verify_and_consume(
        self,
        *,
        email: str,
        purpose: EmailCodePurpose,
        code_hash: str,
        now: datetime,
        max_attempts: int = 5,
    ) -> bool:
        matched, dirty = await _verify_and_consume_in_session(
            self._session,
            email=email,
            purpose=purpose,
            code_hash=code_hash,
            now=now,
            max_attempts=max_attempts,
        )
        if dirty:
            try:
                await self._session.commit()
            except Exception:
                await self._session.rollback()
                raise
        else:
            await self._session.rollback()
        return matched

    async def release_read_transaction(self) -> None:
        if self._session.in_transaction():
            await self._session.rollback()
