"""Watchlist service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from uuid import UUID

from app.domain.models import WatchlistItem, WatchlistUpsert
from app.domain.ports import WatchlistRepository


class WatchlistNotFoundError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(f"{code} 不在自选里")
        self.code = code


class WatchlistService:
    def __init__(self, repository: WatchlistRepository) -> None:
        self._repository = repository

    async def list(self, user_id: UUID) -> list[WatchlistItem]:
        return await self._repository.list(user_id)

    async def upsert(self, user_id: UUID, payload: WatchlistUpsert) -> WatchlistItem:
        return await self._repository.upsert(user_id, payload)

    async def add_if_absent(self, user_id: UUID, payload: WatchlistUpsert) -> WatchlistItem:
        return await self._repository.add_if_absent(user_id, payload)

    async def remove(self, user_id: UUID, code: str) -> None:
        if not await self._repository.remove(user_id, code):
            raise WatchlistNotFoundError(code)
