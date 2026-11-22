"""JWT access token and opaque refresh token codec."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
from jwt import InvalidTokenError

from app.domain.models import AuthenticatedUser, PlanTier


class JwtTokenCodec:
    def __init__(self, *, secret: str, algorithm: str, access_ttl_minutes: int) -> None:
        self._secret = secret
        self._algorithm = algorithm
        self._access_ttl_minutes = access_ttl_minutes

    async def issue_access_token(self, user: AuthenticatedUser) -> tuple[str, int]:
        now = datetime.now(UTC)
        expires_in = self._access_ttl_minutes * 60
        payload = {
            "sub": str(user.id),
            "tier": user.plan_tier.value,
            "type": "access",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=expires_in)).timestamp()),
        }
        encoded = jwt.encode(payload, self._secret, algorithm=self._algorithm)
        return encoded, expires_in

    async def decode_access_token(self, token: str) -> AuthenticatedUser | None:
        try:
            payload = jwt.decode(token, self._secret, algorithms=[self._algorithm])
        except InvalidTokenError:
            return None

        if not isinstance(payload, dict) or payload.get("type") != "access":
            return None

        raw_sub = payload.get("sub")
        raw_tier = payload.get("tier")
        if not isinstance(raw_sub, str) or not isinstance(raw_tier, str):
            return None

        try:
            return AuthenticatedUser(id=UUID(raw_sub), plan_tier=PlanTier(raw_tier))
        except ValueError:
            return None

    async def generate_refresh_token(self) -> tuple[str, str]:
        raw = secrets.token_urlsafe(48)
        return raw, self._hash(raw)

    async def hash_refresh_token(self, raw_token: str) -> str:
        return self._hash(raw_token)

    @staticmethod
    def _hash(raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
