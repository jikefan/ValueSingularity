"""Market service — orchestration only, no I/O of its own."""

from __future__ import annotations

from app.domain.models import MarketOverview
from app.domain.ports import MarketRepository


class MarketService:
    def __init__(self, repository: MarketRepository) -> None:
        self._repository = repository

    def overview(self) -> MarketOverview:
        return self._repository.overview()
