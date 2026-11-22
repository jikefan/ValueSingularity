"""Ports — the minimal seams the domain needs from the outside world.

Adapters (PostgreSQL, DuckDB, akshare, fixtures) implement these; services depend
only on the protocol, so tests and new data sources never touch business logic.
"""

from __future__ import annotations

import builtins
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any, Protocol
from uuid import UUID

from app.domain.models import (
    AlertDeliveryItem,
    AuthenticatedUser,
    DevilsAdvocateChallenge,
    IndexDailyRow,
    JournalAction,
    JournalCreate,
    JournalEntryItem,
    JournalTimeCapsule,
    MacroRateRow,
    MarketFeedBundle,
    MarketOverview,
    MdaDiffHighlight,
    MdaMetricShift,
    PlanTier,
    RefreshRotationResult,
    RefreshTokenRecord,
    StockDetail,
    StockFactBundle,
    StockMetaRecord,
    StockSnapshotPayload,
    StoredAiConfig,
    StoredNotificationConfig,
    TradeCalendarEntry,
    TriggeredAlertCandidate,
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

    async def get_name(self, code: str) -> str | None:
        """Return the stock name for a 6-digit code, or None when unknown."""
        ...

    async def list_by_codes(self, codes: Sequence[str]) -> list[StockMetaRecord]:
        """Return metadata records matching the given 6-digit stock codes."""
        ...

    async def list_watched_codes(self, *, limit: int | None = None) -> list[str]:
        """Return distinct stock codes across user watchlists."""
        ...

    async def list_active_codes(self, *, limit: int | None = None) -> list[str]:
        """Return active stock codes sorted deterministically."""
        ...


class StockFactStore(Protocol):
    async def write_stock_facts(self, bundle: StockFactBundle) -> None:
        """Atomically persist per-stock bars, annual statements, and corporate action facts."""
        ...

    async def load_stock_facts(
        self, code: str, *, as_of: date | None = None
    ) -> StockFactBundle | None:
        """Load persisted facts for a stock up to as_of, or None when absent."""
        ...


class StockFactFeedPort(Protocol):
    async def fetch_stock_bundle(self, code: str, *, as_of: date | None = None) -> StockFactBundle:
        """Fetch raw daily bars, valuation history, annual reports, and actions for one stock."""
        ...


class StockSnapshotRepository(Protocol):
    async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
        """Return precomputed snapshot payload for a 6-digit stock code, or None."""
        ...

    async def get_snapshots_for_compare(
        self, codes: Sequence[str]
    ) -> dict[str, StockSnapshotPayload]:
        """Return precomputed snapshot payloads keyed by code for comparison."""
        ...

    async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
        """Idempotently persist a precomputed stock snapshot."""
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

    async def add_if_absent(self, user_id: UUID, payload: WatchlistUpsert) -> WatchlistItem:
        """Insert a watchlist item if absent, or return the existing row untouched."""
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
        actions: Sequence[JournalAction] | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        """Return a user's journal entries ordered by recency."""
        ...

    async def list_holding_lifecycle_entries(
        self, user_id: UUID
    ) -> builtins.list[JournalEntryItem]:
        """Return all buy/add/sell journal entries for a user in chronological order."""
        ...

    async def create(
        self,
        user_id: UUID,
        payload: JournalCreate,
        *,
        snapshot: JournalTimeCapsule | None = None,
        audit_event: UserEventCreate | None = None,
    ) -> JournalEntryItem:
        """Persist a new journal entry, optional time capsule, and optional audit event."""
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


class SettingsRepository(Protocol):
    async def get_notification_config(self, user_id: UUID) -> StoredNotificationConfig:
        """Return stored notification config for a user, or defaults when unset."""
        ...

    async def save_notification_config(
        self, user_id: UUID, config: StoredNotificationConfig
    ) -> StoredNotificationConfig:
        """Persist notification preferences for a user."""
        ...


class AlertRepository(Protocol):
    async def list_alerts(self, user_id: UUID, *, limit: int = 50) -> list[AlertDeliveryItem]:
        """Return recent alert deliveries scoped to a user."""
        ...

    async def insert_alert_if_new(
        self,
        candidate: TriggeredAlertCandidate,
        *,
        channel: str,
        status: str,
        audit_event: UserEventCreate | None = None,
    ) -> tuple[AlertDeliveryItem | None, bool]:
        """Atomically insert an alert if unique for the day, plus optional audit event."""
        ...

    async def update_delivery_status(
        self,
        delivery_id: int,
        *,
        channel: str,
        status: str,
    ) -> AlertDeliveryItem | None:
        """Update delivery channel and status after external dispatch."""
        ...

    async def list_users_with_alert_targets(self) -> list[UUID]:
        """Return active user IDs with alert-enabled watchlist items or open positions."""
        ...


class WebhookNotifierPort(Protocol):
    async def send_alerts(
        self,
        config: StoredNotificationConfig,
        stock_alerts: Sequence[TriggeredAlertCandidate],
    ) -> bool:
        """Deliver alert summaries to an external webhook endpoint; return success boolean."""
        ...


class AiPreferencesRepository(Protocol):
    async def get_config(self, user_id: UUID) -> StoredAiConfig:
        """Return stored AI preferences (including BYOK config) or defaults."""
        ...

    async def save_config(self, user_id: UUID, config: StoredAiConfig) -> StoredAiConfig:
        """Persist AI preferences for a user."""
        ...

    async def get_usage_today(self, user_id: UUID, day_shanghai: str) -> int:
        """Return platform AI call count consumed by the user on the given CST date."""
        ...

    async def try_consume_quota(
        self,
        user_id: UUID,
        day_shanghai: str,
        daily_limit: int,
    ) -> tuple[bool, int]:
        """Atomically reserve one daily platform AI call if under daily_limit."""
        ...

    async def refund_quota(self, user_id: UUID, day_shanghai: str) -> int:
        """Refund one reserved daily platform AI call (floored at 0) after upstream error."""
        ...

    async def release_read_transaction(self) -> None:
        """Release any open read transaction before long-running external I/O."""
        ...


class LlmCompanionPort(Protocol):
    async def generate_challenges(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        context: Mapping[str, Any],
    ) -> list[DevilsAdvocateChallenge]:
        """Generate 3 Devil's Advocate challenges via an OpenAI-compatible chat endpoint."""
        ...

    async def summarize_mda_diff(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        code: str,
        stock_name: str,
        previous_period_label: str,
        current_period_label: str,
        metric_shifts: Sequence[MdaMetricShift],
        text_highlights: Sequence[MdaDiffHighlight],
    ) -> str:
        """Synthesize a concise summary of MD&A text and accounting metric shifts."""
        ...
