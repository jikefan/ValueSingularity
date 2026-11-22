"""Authentication and session lifecycle service — pure orchestration over domain ports."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.domain.errors import EmailAlreadyRegisteredError
from app.domain.models import (
    AuthenticatedUser,
    AuthSession,
    LoginRequest,
    PlanTier,
    RefreshRotationStatus,
    RegisterRequest,
    TokenResponse,
    UserAuthRecord,
    UserProfile,
)
from app.domain.ports import (
    PasswordHasher,
    RefreshTokenRepository,
    TokenCodec,
    UserRepository,
)


class InvalidCredentialsError(Exception):
    pass


class InactiveUserError(Exception):
    pass


class InvalidRefreshTokenError(Exception):
    pass


class InvalidAccessTokenError(Exception):
    pass


class UserNotFoundError(Exception):
    pass


def _to_profile(user: UserAuthRecord) -> UserProfile:
    return UserProfile(
        id=user.id,
        email=user.email,
        phone=user.phone,
        display_name=user.display_name,
        plan_tier=user.plan_tier,
        plan_expires_at=user.plan_expires_at,
        created_at=user.created_at,
    )


class AuthService:
    def __init__(
        self,
        users: UserRepository,
        refresh_tokens: RefreshTokenRepository,
        hasher: PasswordHasher,
        tokens: TokenCodec,
        refresh_ttl_days: int,
    ) -> None:
        self._users = users
        self._refresh_tokens = refresh_tokens
        self._hasher = hasher
        self._tokens = tokens
        self._refresh_ttl_days = refresh_ttl_days

    async def register(
        self,
        payload: RegisterRequest,
        user_agent: str | None = None,
    ) -> AuthSession:
        email = payload.email.strip().lower()
        if await self._users.get_by_email(email) is not None:
            raise EmailAlreadyRegisteredError(email)

        password_hash = await self._hasher.hash(payload.password)
        user = await self._users.create(
            email=email,
            password_hash=password_hash,
            display_name=payload.display_name,
            plan_tier=PlanTier.FREE,
        )
        return await self._issue_session(user, user_agent)

    async def login(
        self,
        payload: LoginRequest,
        user_agent: str | None = None,
    ) -> AuthSession:
        email = payload.email.strip().lower()
        user = await self._users.get_by_email(email)
        if user is None or not await self._hasher.verify(payload.password, user.password_hash):
            raise InvalidCredentialsError()
        if not user.is_active:
            raise InactiveUserError()
        return await self._issue_session(user, user_agent)

    async def refresh(
        self,
        raw_refresh_token: str,
        user_agent: str | None = None,
    ) -> AuthSession:
        if not raw_refresh_token:
            raise InvalidRefreshTokenError()

        token_hash = await self._tokens.hash_refresh_token(raw_refresh_token)
        raw_refresh, new_hash = await self._tokens.generate_refresh_token()
        now = datetime.now(UTC)
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
        await self._refresh_tokens.revoke_by_hash(token_hash, datetime.now(UTC))

    async def get_profile(self, user_id: UUID) -> UserProfile:
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise UserNotFoundError()
        if not user.is_active:
            raise InactiveUserError()
        return _to_profile(user)

    async def authenticate_access_token(self, token: str) -> AuthenticatedUser:
        user = await self._tokens.decode_access_token(token)
        if user is None:
            raise InvalidAccessTokenError()
        return user

    async def _issue_session(self, user: UserAuthRecord, user_agent: str | None) -> AuthSession:
        raw_refresh, token_hash = await self._tokens.generate_refresh_token()
        expires_at = datetime.now(UTC) + timedelta(days=self._refresh_ttl_days)
        await self._refresh_tokens.create(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=expires_at,
            user_agent=user_agent,
        )
        return await self._build_auth_session(user, raw_refresh)

    async def _build_auth_session(self, user: UserAuthRecord, raw_refresh: str) -> AuthSession:
        auth_user = AuthenticatedUser(id=user.id, plan_tier=user.plan_tier)
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
    "InactiveUserError",
    "InvalidAccessTokenError",
    "InvalidCredentialsError",
    "InvalidRefreshTokenError",
    "UserNotFoundError",
]
