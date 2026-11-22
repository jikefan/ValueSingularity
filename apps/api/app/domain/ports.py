"""Ports — the minimal seams the domain needs from the outside world.

Adapters (PostgreSQL, DuckDB, akshare, fixtures) implement these; services depend
only on the protocol, so tests and new data sources never touch business logic.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol
from uuid import UUID

from app.domain.models import (
    AuthenticatedUser,
    MarketOverview,
    PlanTier,
    RefreshTokenRecord,
    UserAuthRecord,
    WatchlistItem,
    WatchlistUpsert,
)


class MarketRepository(Protocol):
    async def overview(self) -> MarketOverview:
        """Return the current market snapshot."""
        ...


class WatchlistRepository(Protocol):
    async def list(self, user_id: UUID) -> list[WatchlistItem]:
        """Return all watchlist items for a user ordered by recency."""
        ...

    async def get(self, user_id: UUID, code: str) -> WatchlistItem | None:
        """Return a user's watchlist item by 6-digit stock code."""
        ...

    async def upsert(self, user_id: UUID, payload: WatchlistUpsert) -> WatchlistItem:
        """Insert or update a user's watchlist item."""
        ...

    async def remove(self, user_id: UUID, code: str) -> bool:
        """Delete a user's watchlist item by code; return whether a row was removed."""
        ...


class UserRepository(Protocol):
    async def create(
        self,
        *,
        email: str,
        password_hash: str,
        display_name: str,
        plan_tier: PlanTier,
    ) -> UserAuthRecord:
        """Persist a new user account."""
        ...

    async def get_by_email(self, email: str) -> UserAuthRecord | None:
        """Return a user auth record by normalized email."""
        ...

    async def get_by_id(self, user_id: UUID) -> UserAuthRecord | None:
        """Return a user auth record by primary key."""
        ...


class RefreshTokenRepository(Protocol):
    async def create(
        self,
        *,
        user_id: UUID,
        token_hash: str,
        expires_at: datetime,
        user_agent: str | None,
    ) -> RefreshTokenRecord:
        """Persist a hashed refresh token record."""
        ...

    async def get_by_hash(self, token_hash: str) -> RefreshTokenRecord | None:
        """Look up a refresh token record by SHA-256 hash."""
        ...

    async def revoke(self, token_id: UUID, revoked_at: datetime) -> None:
        """Mark a single refresh token as revoked."""
        ...

    async def revoke_all_for_user(self, user_id: UUID, revoked_at: datetime) -> None:
        """Revoke all active refresh tokens belonging to a user."""
        ...


class PasswordHasher(Protocol):
    async def hash(self, password: str) -> str:
        """Hash a plaintext password."""
        ...

    async def verify(self, password: str, password_hash: str) -> bool:
        """Verify a plaintext password against a stored hash."""
        ...


class TokenCodec(Protocol):
    async def issue_access_token(self, user: AuthenticatedUser) -> tuple[str, int]:
        """Issue a signed JWT access token and its TTL in seconds."""
        ...

    async def decode_access_token(self, token: str) -> AuthenticatedUser | None:
        """Verify and decode an access token, or return None when invalid."""
        ...

    async def generate_refresh_token(self) -> tuple[str, str]:
        """Generate a raw refresh token and its SHA-256 hex digest."""
        ...

    async def hash_refresh_token(self, raw_token: str) -> str:
        """Compute the SHA-256 hex digest of a raw refresh token."""
        ...
