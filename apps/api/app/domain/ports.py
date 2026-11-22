"""Ports — the minimal seams the domain needs from the outside world.

Adapters (PostgreSQL, DuckDB, akshare, fixtures) implement these; services depend
only on the protocol, so tests and new data sources never touch business logic.
"""

from __future__ import annotations

from typing import Protocol

from app.domain.models import MarketOverview, WatchlistItem, WatchlistUpsert


class MarketRepository(Protocol):
    async def overview(self) -> MarketOverview:
        """Return the current market snapshot."""
        ...


class WatchlistRepository(Protocol):
    async def list(self) -> list[WatchlistItem]:
        """Return all watchlist items ordered by recency."""
        ...

    async def get(self, code: str) -> WatchlistItem | None:
        """Return a watchlist item by 6-digit stock code."""
        ...

    async def upsert(self, payload: WatchlistUpsert) -> WatchlistItem:
        """Insert or update a watchlist item."""
        ...

    async def remove(self, code: str) -> bool:
        """Delete a watchlist item by code; return whether a row was removed."""
        ...
