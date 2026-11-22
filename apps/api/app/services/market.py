"""Market service — orchestration only, no I/O of its own."""

from __future__ import annotations

from app.domain.errors import MarketSnapshotUnavailableError
from app.domain.models import MarketOverview
from app.domain.ports import MarketRepository


class MarketService:
    def __init__(self, repository: MarketRepository) -> None:
        self._repository = repository

    async def overview(self) -> MarketOverview:
        return await self._repository.overview()


__all__ = ["MarketService", "MarketSnapshotUnavailableError"]
