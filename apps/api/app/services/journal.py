"""Journal service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from uuid import UUID

from app.domain.errors import JournalEntryNotFoundError
from app.domain.models import JournalCreate, JournalEntryItem, UserEventCreate
from app.domain.ports import EventRepository, JournalRepository, StockMetaRepository


class JournalService:
    def __init__(
        self,
        repository: JournalRepository,
        stock_meta: StockMetaRepository | None = None,
        events: EventRepository | None = None,
    ) -> None:
        self._repository = repository
        self._stock_meta = stock_meta
        self._events = events

    async def list(
        self,
        user_id: UUID,
        *,
        code: str | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        return await self._repository.list(user_id, code=code, limit=limit)

    async def create(self, user_id: UUID, payload: JournalCreate) -> JournalEntryItem:
        effective_payload = payload
        if payload.name is None and self._stock_meta is not None:
            detail = await self._stock_meta.get_detail(payload.code)
            if detail is not None:
                effective_payload = payload.model_copy(update={"name": detail.name})

        entry = await self._repository.create(user_id, effective_payload)
        if self._events is not None:
            await self._events.record(
                user_id,
                UserEventCreate(
                    type="journal_created",
                    code=entry.code,
                    meta={"action": entry.action.value},
                ),
            )
        return entry

    async def remove(self, user_id: UUID, entry_id: int) -> None:
        if not await self._repository.remove(user_id, entry_id):
            raise JournalEntryNotFoundError(entry_id)


__all__ = ["JournalEntryNotFoundError", "JournalService"]
