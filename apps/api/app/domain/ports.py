"""Ports — the minimal seams the domain needs from the outside world.

Adapters (PostgreSQL, DuckDB, akshare, fixtures) implement these; services depend
only on the protocol, so tests and new data sources never touch business logic.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from typing import Protocol
from uuid import UUID

from app.domain.models import (
    AuthenticatedUser,
    IndexDailyRow,
    JournalCreate,
    JournalEntryItem,
    MacroRateRow,
    MarketFeedBundle,
    MarketOverview,
    PlanTier,
    RefreshRotationResult,
    RefreshTokenRecord,
    StockDetail,
    StockMetaRecord,
    TradeCalendarEntry,
    UserAuthRecord,
    UserEventCreate,
    UserEventItem,
    WatchlistItem,
    WatchlistUpsert,
)


class MarketRepository(Protocol):
    async def overview(self) -> MarketOverview:
        """Return the current market snapshot."""
        ...

    async def save_overview(self, snapshot: MarketOverview) -> None:
        """Persist the latest market overview snapshot."""
        ...


class StockMetaRepository(Protocol):
    async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
        """Upsert platform-shared stock metadata and return affected count."""
        ...

    async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
        """Search stocks by code or name, prioritized by exact code and prefix matches."""
        ...

    async def get_detail(self, code: str) -> StockDetail | None:
        """Return stock metadata and snapshot availability for a 6-digit code."""
        ...


class MarketFactStore(Protocol):
    async def write_meta_facts(
        self,
        *,
        stock_list: Sequence[StockMetaRecord],
        trade_calendar: Sequence[TradeCalendarEntry],
        index_daily: Sequence[IndexDailyRow],
        macro_rates: Sequence[MacroRateRow],
    ) -> None:
        """Atomically persist metadata and macro fact tables to Parquet."""
        ...

    async def load_macro_history(self, as_of: date, lookback_years: int = 10) -> list[MacroRateRow]:
        """Load macro rate and market PE rows up to as_of within lookback_years."""
        ...


class MarketFeedPort(Protocol):
    async def fetch_market_bundle(self, as_of: date | None = None) -> MarketFeedBundle:
        """Fetch raw market overview inputs and meta/macro fact datasets."""
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


class JournalRepository(Protocol):
    async def list(
        self,
        user_id: UUID,
        *,
        code: str | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        """Return a user's journal entries ordered by recency, optionally filtered by code."""
        ...

    async def create(self, user_id: UUID, payload: JournalCreate) -> JournalEntryItem:
        """Persist a new journal entry scoped to the given user."""
        ...

    async def remove(self, user_id: UUID, entry_id: int) -> bool:
        """Delete a user's journal entry by ID; return whether a row was removed."""
        ...


class EventRepository(Protocol):
    async def list(self, user_id: UUID, *, limit: int = 50) -> list[UserEventItem]:
        """Return a user's audit/behavior events ordered by recency."""
        ...

    async def record(self, user_id: UUID, payload: UserEventCreate) -> UserEventItem:
        """Persist an audit/behavior event scoped to the given user."""
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

    async def rotate_token(
        self,
        *,
        token_hash: str,
        new_token_hash: str,
        now: datetime,
        new_expires_at: datetime,
        user_agent: str | None,
    ) -> RefreshRotationResult:
        """Atomically validate, revoke, and replace a refresh token."""
        ...

    async def revoke_by_hash(self, token_hash: str, revoked_at: datetime) -> bool:
        """Revoke an active refresh token by SHA-256 hash."""
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
