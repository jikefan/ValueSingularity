"""Authentication and session lifecycle service — pure orchestration over domain ports."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import secrets
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.domain.errors import (
    EmailAlreadyRegisteredError,
    EmailCodeCooldownError,
    EmailCodeRateLimitError,
    EmailDeliveryError,
    EmailNotConfiguredError,
    InvalidVerificationCodeError,
    SamePasswordError,
    UserNotFoundError,
)
from app.domain.models import (
    AuthConfigResponse,
    AuthenticatedEmailCodeRequest,
    AuthenticatedUser,
    AuthSession,
    DeleteAccountRequest,
    EmailCodePurpose,
    EmailCodeSendRequest,
    EmailCodeSendResponse,
    LoginRequest,
    PasswordChangeRequest,
    PasswordChangeStatus,
    PasswordResetConfirmRequest,
    PasswordResetStatus,
    PlanTier,
    RefreshRotationStatus,
    RegisterRequest,
    TokenResponse,
    UserAuthRecord,
    UserProfile,
    UserProfileUpdateRequest,
    VerifyEmailRequest,
)
from app.domain.ports import (
    EmailSenderPort,
    EmailVerificationRepository,
    PasswordHasher,
    RefreshTokenRepository,
    TokenCodec,
    UserRepository,
)

logger = logging.getLogger("vs.auth")


class InvalidCredentialsError(Exception):
    pass


class InactiveUserError(Exception):
    pass


class InvalidRefreshTokenError(Exception):
    pass


class InvalidAccessTokenError(Exception):
    pass


def _to_profile(user: UserAuthRecord) -> UserProfile:
    return UserProfile(
        id=user.id,
        email=user.email,
        phone=user.phone,
        display_name=user.display_name,
        email_verified=user.email_verified or user.email_verified_at is not None,
        plan_tier=user.plan_tier,
        plan_expires_at=user.plan_expires_at,
        created_at=user.created_at,
    )


def _mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    if not domain:
        return "***"
    prefix = local[:1] if local else "*"
    return f"{prefix}***@{domain}"


class AuthService:
    def __init__(
        self,
        users: UserRepository,
        refresh_tokens: RefreshTokenRepository,
        hasher: PasswordHasher,
        tokens: TokenCodec,
        refresh_ttl_days: int,
        *,
        email_codes: EmailVerificationRepository | None = None,
        email_sender: EmailSenderPort | None = None,
        otp_secret: str = "dev-otp-secret",
        require_email_verification: bool = False,
        smtp_configured: bool = False,
        code_ttl_minutes: int = 10,
        code_cooldown_seconds: int = 60,
        code_hourly_limit: int = 10,
        max_code_attempts: int = 5,
        reset_timing_floor_seconds: float = 0.2,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._users = users
        self._refresh_tokens = refresh_tokens
        self._hasher = hasher
        self._tokens = tokens
        self._refresh_ttl_days = refresh_ttl_days
        self._email_codes = email_codes
        self._email_sender = email_sender
        self._otp_secret = otp_secret
        self._require_email_verification = require_email_verification
        self._smtp_configured = smtp_configured
        self._code_ttl_minutes = code_ttl_minutes
        self._code_cooldown_seconds = code_cooldown_seconds
        self._code_hourly_limit = code_hourly_limit
        self._max_code_attempts = max_code_attempts
        self._reset_timing_floor_seconds = reset_timing_floor_seconds
        self._clock = clock

    def _now(self) -> datetime:
        return self._clock() if self._clock is not None else datetime.now(UTC)

    def _hash_otp_code(self, *, email: str, purpose: EmailCodePurpose, code: str) -> str:
        message = f"{email}:{purpose}:{code}".encode()
        return hmac.new(self._otp_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    async def _ensure_email_ready(self) -> tuple[EmailVerificationRepository, EmailSenderPort]:
        if self._email_codes is None or self._email_sender is None:
            raise EmailNotConfiguredError()
        await self._email_sender.ensure_configured()
        return self._email_codes, self._email_sender

    async def _verify_code_or_raise(
        self,
        *,
        email: str,
        purpose: EmailCodePurpose,
        code: str,
        now: datetime,
    ) -> None:
        if self._email_codes is None:
            raise EmailNotConfiguredError()
        code_hash = self._hash_otp_code(email=email, purpose=purpose, code=code)
        matched = await self._email_codes.verify_and_consume(
            email=email,
            purpose=purpose,
            code_hash=code_hash,
            now=now,
            max_attempts=self._max_code_attempts,
        )
        if not matched:
            raise InvalidVerificationCodeError()

    async def _issue_and_send_code(
        self,
        *,
        email: str,
        purpose: EmailCodePurpose,
        response_message: str,
        dispatch_email: bool = True,
        suppress_delivery_error: bool = False,
    ) -> EmailCodeSendResponse:
        email_codes, email_sender = await self._ensure_email_ready()
        now = self._now()
        code = f"{secrets.randbelow(1_000_000):06d}"
        code_hash = self._hash_otp_code(email=email, purpose=purpose, code=code)
        code_id = await email_codes.try_issue_code(
            email=email,
            purpose=purpose,
            code_hash=code_hash,
            expires_at=now + timedelta(minutes=self._code_ttl_minutes),
            created_at=now,
            cooldown_seconds=self._code_cooldown_seconds,
            hourly_limit=self._code_hourly_limit,
            consumed_at=None if dispatch_email else now,
        )

        if dispatch_email:
            try:
                await email_sender.send_verification_code(
                    to_email=email,
                    code=code,
                    purpose=purpose,
                    expires_minutes=self._code_ttl_minutes,
                )
            except BaseException as exc:
                try:
                    await asyncio.shield(email_codes.delete_code_by_id(code_id))
                except Exception:
                    logger.warning(
                        "清理未发送验证码记录失败 (to=%s, purpose=%s)",
                        _mask_email(email),
                        purpose,
                    )
                if suppress_delivery_error and isinstance(exc, EmailDeliveryError):
                    logger.warning(
                        "重置密码验证码发送失败，已脱敏静默降级 (to=%s): %s",
                        _mask_email(email),
                        exc.__class__.__name__,
                    )
                else:
                    raise

        return EmailCodeSendResponse(
            sent=True,
            expires_in_seconds=self._code_ttl_minutes * 60,
            cooldown_seconds=self._code_cooldown_seconds,
            message=response_message,
        )

    async def get_config(self) -> AuthConfigResponse:
        return AuthConfigResponse(
            email_verification_required=self._require_email_verification,
            smtp_configured=self._smtp_configured,
            code_ttl_minutes=self._code_ttl_minutes,
            code_cooldown_seconds=self._code_cooldown_seconds,
        )

    async def send_public_email_code(self, payload: EmailCodeSendRequest) -> EmailCodeSendResponse:
        email = payload.email.strip().lower()
        await self._ensure_email_ready()

        if payload.purpose == "register":
            existing = await self._users.get_by_email(email)
            await self._users.release_read_transaction()
            if existing is not None:
                raise EmailAlreadyRegisteredError(email)
            return await self._issue_and_send_code(
                email=email,
                purpose="register",
                response_message="验证码已发送至您的邮箱，请注意查收",
            )

        started = time.monotonic()
        reset_message = "若该邮箱已注册且可用，验证码已发送至您的邮箱，请注意查收"
        user = await self._users.get_by_email(email)
        await self._users.release_read_transaction()
        can_send = user is not None and user.is_active

        response = await self._issue_and_send_code(
            email=email,
            purpose="reset_password",
            response_message=reset_message,
            dispatch_email=can_send,
            suppress_delivery_error=True,
        )
        if self._reset_timing_floor_seconds > 0:
            target = self._reset_timing_floor_seconds + (secrets.randbelow(40) / 1000.0)
            remaining = target - (time.monotonic() - started)
            if remaining > 0:
                await asyncio.sleep(remaining)
        return response

    async def send_authenticated_email_code(
        self,
        user_id: UUID,
        payload: AuthenticatedEmailCodeRequest,
    ) -> EmailCodeSendResponse:
        user = await self._users.get_by_id(user_id)
        await self._users.release_read_transaction()
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        if not user.email:
            raise InvalidVerificationCodeError("当前账号未绑定邮箱")
        if payload.purpose == "verify_email" and user.email_verified_at is not None:
            raise InvalidVerificationCodeError("当前邮箱已完成验证，无需重复验证")

        return await self._issue_and_send_code(
            email=user.email.strip().lower(),
            purpose=payload.purpose,
            response_message="验证码已发送至您的邮箱，请注意查收",
        )

    async def register(
        self,
        payload: RegisterRequest,
        user_agent: str | None = None,
    ) -> AuthSession:
        email = payload.email.strip().lower()
        existing = await self._users.get_by_email(email)
        await self._users.release_read_transaction()
        if existing is not None:
            raise EmailAlreadyRegisteredError(email)

        verified_at: datetime | None = None
        if self._require_email_verification or payload.verification_code is not None:
            if payload.verification_code is None:
                raise InvalidVerificationCodeError("请先输入邮箱验证码")
            now = self._now()
            await self._verify_code_or_raise(
                email=email,
                purpose="register",
                code=payload.verification_code,
                now=now,
            )
            verified_at = now

        password_hash = await self._hasher.hash(payload.password)
        user = await self._users.create(
            email=email,
            password_hash=password_hash,
            display_name=payload.display_name,
            plan_tier=PlanTier.FREE,
            email_verified_at=verified_at,
        )
        return await self._issue_session(user, user_agent)

    async def login(
        self,
        payload: LoginRequest,
        user_agent: str | None = None,
    ) -> AuthSession:
        email = payload.email.strip().lower()
        user = await self._users.get_by_email(email)
        await self._users.release_read_transaction()
        if user is None or not await self._hasher.verify(payload.password, user.password_hash):
            raise InvalidCredentialsError()
        if not user.is_active:
            raise InactiveUserError()
        try:
            return await self._issue_session(user, user_agent)
        except UserNotFoundError as exc:
            raise InvalidCredentialsError() from exc

    async def refresh(
        self,
        raw_refresh_token: str,
        user_agent: str | None = None,
    ) -> AuthSession:
        if not raw_refresh_token:
            raise InvalidRefreshTokenError()

        token_hash = await self._tokens.hash_refresh_token(raw_refresh_token)
        raw_refresh, new_hash = await self._tokens.generate_refresh_token()
        now = self._now()
        new_expires_at = now + timedelta(days=self._refresh_ttl_days)

        result = await self._refresh_tokens.rotate_token(
            token_hash=token_hash,
            new_token_hash=new_hash,
            now=now,
            new_expires_at=new_expires_at,
            user_agent=user_agent,
        )
        if result.status == RefreshRotationStatus.INACTIVE:
            raise InactiveUserError()
        if result.status != RefreshRotationStatus.ROTATED or result.user is None:
            raise InvalidRefreshTokenError()

        return await self._build_auth_session(result.user, raw_refresh)

    async def logout(self, raw_refresh_token: str | None) -> None:
        if not raw_refresh_token:
            return
        token_hash = await self._tokens.hash_refresh_token(raw_refresh_token)
        await self._refresh_tokens.revoke_by_hash(token_hash, self._now())

    async def get_profile(self, user_id: UUID) -> UserProfile:
        user = await self._users.get_by_id(user_id)
        await self._users.release_read_transaction()
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        return _to_profile(user)

    async def update_profile(
        self,
        user_id: UUID,
        payload: UserProfileUpdateRequest,
    ) -> UserProfile:
        user = await self._users.get_by_id(user_id)
        if user is None:
            await self._users.release_read_transaction()
            raise UserNotFoundError()
        if not user.is_active:
            await self._users.release_read_transaction()
            raise InactiveUserError()
        updated = await self._users.update_display_name(user_id, payload.display_name)
        if updated is None:
            raise UserNotFoundError()
        return _to_profile(updated)

    async def verify_current_user_email(
        self,
        user_id: UUID,
        payload: VerifyEmailRequest,
    ) -> UserProfile:
        user = await self._users.get_by_id(user_id)
        await self._users.release_read_transaction()
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        if not user.email:
            raise InvalidVerificationCodeError("当前账号未绑定邮箱")
        if user.email_verified_at is not None:
            raise InvalidVerificationCodeError("当前邮箱已完成验证，无需重复验证")

        now = self._now()
        await self._verify_code_or_raise(
            email=user.email.strip().lower(),
            purpose="verify_email",
            code=payload.verification_code,
            now=now,
        )
        updated = await self._users.mark_email_verified(user_id, now)
        if updated is None:
            raise UserNotFoundError()
        return _to_profile(updated)

    async def reset_password(self, payload: PasswordResetConfirmRequest) -> None:
        if self._email_codes is None:
            raise EmailNotConfiguredError()
        email = payload.email.strip().lower()
        now = self._now()
        code_hash = self._hash_otp_code(
            email=email,
            purpose="reset_password",
            code=payload.verification_code,
        )
        await self._users.release_read_transaction()
        password_hash = await self._hasher.hash(payload.new_password)
        status = await self._users.complete_password_reset(
            email=email,
            code_hash=code_hash,
            password_hash=password_hash,
            now=now,
            max_attempts=self._max_code_attempts,
        )
        if status == PasswordResetStatus.INACTIVE:
            raise InactiveUserError()
        if status != PasswordResetStatus.UPDATED:
            raise InvalidVerificationCodeError()

    async def change_password(
        self,
        user_id: UUID,
        payload: PasswordChangeRequest,
        user_agent: str | None = None,
    ) -> AuthSession:
        user = await self._users.get_by_id(user_id)
        await self._users.release_read_transaction()
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        if not await self._hasher.verify(payload.current_password, user.password_hash):
            raise InvalidCredentialsError()
        if payload.new_password == payload.current_password:
            raise SamePasswordError()

        password_hash = await self._hasher.hash(payload.new_password)
        raw_refresh, new_token_hash = await self._tokens.generate_refresh_token()
        now = self._now()
        new_expires_at = now + timedelta(days=self._refresh_ttl_days)
        result = await self._users.complete_password_change(
            user.id,
            password_hash=password_hash,
            new_token_hash=new_token_hash,
            new_expires_at=new_expires_at,
            now=now,
            user_agent=user_agent,
        )
        if result.status == PasswordChangeStatus.INACTIVE:
            raise InactiveUserError()
        if result.status != PasswordChangeStatus.UPDATED or result.user is None:
            raise UserNotFoundError()
        return await self._build_auth_session(result.user, raw_refresh)

    async def delete_account(
        self,
        user_id: UUID,
        payload: DeleteAccountRequest,
    ) -> None:
        user = await self._users.get_by_id(user_id)
        await self._users.release_read_transaction()
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        if not await self._hasher.verify(payload.password, user.password_hash):
            raise InvalidCredentialsError()

        email = user.email.strip().lower() if user.email else None
        if email is None:
            if payload.verification_code is not None:
                raise InvalidVerificationCodeError("当前账号未绑定邮箱")
        elif self._require_email_verification or payload.verification_code is not None:
            if payload.verification_code is None:
                raise InvalidVerificationCodeError("请先输入邮箱验证码")
            await self._verify_code_or_raise(
                email=email,
                purpose="delete_account",
                code=payload.verification_code,
                now=self._now(),
            )

        deleted = await self._users.delete_user_account(user.id)
        if not deleted:
            raise UserNotFoundError()

    async def authenticate_access_token(self, token: str) -> AuthenticatedUser:
        token_user = await self._tokens.decode_access_token(token)
        if token_user is None:
            raise InvalidAccessTokenError()
        db_user = await self._users.get_by_id(token_user.id)
        await self._users.release_read_transaction()
        if db_user is None or db_user.token_version != token_user.token_version:
            raise InvalidAccessTokenError()
        if not db_user.is_active:
            raise InactiveUserError()
        return AuthenticatedUser(
            id=db_user.id,
            plan_tier=db_user.plan_tier,
            token_version=db_user.token_version,
        )

    async def _issue_session(self, user: UserAuthRecord, user_agent: str | None) -> AuthSession:
        raw_refresh, token_hash = await self._tokens.generate_refresh_token()
        expires_at = self._now() + timedelta(days=self._refresh_ttl_days)
        await self._refresh_tokens.create(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=expires_at,
            user_agent=user_agent,
        )
        return await self._build_auth_session(user, raw_refresh)

    async def _build_auth_session(self, user: UserAuthRecord, raw_refresh: str) -> AuthSession:
        auth_user = AuthenticatedUser(
            id=user.id,
            plan_tier=user.plan_tier,
            token_version=user.token_version,
        )
        access_token, expires_in = await self._tokens.issue_access_token(auth_user)
        return AuthSession(
            token=TokenResponse(
                access_token=access_token,
                expires_in=expires_in,
                user=_to_profile(user),
            ),
            raw_refresh_token=raw_refresh,
        )


__all__ = [
    "AuthService",
    "EmailAlreadyRegisteredError",
    "EmailCodeCooldownError",
    "EmailCodeRateLimitError",
    "EmailDeliveryError",
    "EmailNotConfiguredError",
    "InactiveUserError",
    "InvalidAccessTokenError",
    "InvalidCredentialsError",
    "InvalidRefreshTokenError",
    "InvalidVerificationCodeError",
    "SamePasswordError",
    "UserNotFoundError",
]
