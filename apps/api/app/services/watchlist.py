"""Watchlist service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from app.domain.models import WatchlistItem, WatchlistUpsert
from app.domain.ports import WatchlistRepository


class WatchlistNotFoundError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(f"{code} 不在自选里")
        self.code = code


class WatchlistService:
    def __init__(self, repository: WatchlistRepository) -> None:
        self._repository = repository

    async def list(self) -> list[WatchlistItem]:
        return await self._repository.list()

    async def upsert(self, payload: WatchlistUpsert) -> WatchlistItem:
        return await self._repository.upsert(payload)

    async def remove(self, code: str) -> None:
        if not await self._repository.remove(code):
            raise WatchlistNotFoundError(code)
