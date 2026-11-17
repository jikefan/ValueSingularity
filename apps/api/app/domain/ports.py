"""Ports — the minimal seams the domain needs from the outside world.

Adapters (akshare, SQLite, fixtures) implement these; services depend only on
the protocol, so tests and new data sources never touch business logic.
"""

from __future__ import annotations

from typing import Protocol

from app.domain.models import MarketOverview


class MarketRepository(Protocol):
    def overview(self) -> MarketOverview:
        """Return the current market snapshot."""
        ...
