"""Market service — orchestration only, no I/O of its own."""

from __future__ import annotations

from app.domain.engines.discovery import build_market_discovery_board
from app.domain.errors import MarketSnapshotUnavailableError
from app.domain.models import MarketDiscoveryResponse, MarketOverview
from app.domain.ports import MarketRepository, StockSnapshotRepository


class MarketService:
    def __init__(
        self,
        repository: MarketRepository,
        snapshot_repo: StockSnapshotRepository | None = None,
    ) -> None:
        self._repository = repository
        self._snapshot_repo = snapshot_repo

    async def overview(self) -> MarketOverview:
        return await self._repository.overview()

    async def discovery(self) -> MarketDiscoveryResponse:
        overview = await self._repository.overview()
        snapshots = (
            await self._snapshot_repo.list_all_snapshots()
            if self._snapshot_repo is not None
            else []
        )
        return build_market_discovery_board(overview, snapshots)


__all__ = ["MarketService", "MarketSnapshotUnavailableError"]
