"""Stock service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from app.domain.errors import StockNotFoundError
from app.domain.models import StockDetail, StockMetaRecord
from app.domain.ports import StockMetaRepository


class StockService:
    def __init__(self, repository: StockMetaRepository) -> None:
        self._repository = repository

    async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
        return await self._repository.search(query, limit=limit)

    async def detail(self, code: str) -> StockDetail:
        item = await self._repository.get_detail(code)
        if item is None:
            raise StockNotFoundError(code)
        return item


__all__ = ["StockNotFoundError", "StockService"]
