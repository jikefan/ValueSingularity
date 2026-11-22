"""Journal service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from app.domain.errors import JournalEntryNotFoundError
from app.domain.models import JournalAction, JournalCreate, JournalEntryItem, UserEventCreate
from app.domain.ports import JournalRepository, StockMetaRepository


class JournalService:
    def __init__(
        self,
        repository: JournalRepository,
        stock_meta: StockMetaRepository | None = None,
        *,
        record_audit_event: bool = True,
    ) -> None:
        self._repository = repository
        self._stock_meta = stock_meta
        self._record_audit_event = record_audit_event

    async def list(
        self,
        user_id: UUID,
        *,
        code: str | None = None,
        actions: Sequence[JournalAction] | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        return await self._repository.list(user_id, code=code, actions=actions, limit=limit)

    async def create(self, user_id: UUID, payload: JournalCreate) -> JournalEntryItem:
        effective_payload = payload
        if payload.name is None and self._stock_meta is not None:
            stock_name = await self._stock_meta.get_name(payload.code)
            if stock_name is not None:
                effective_payload = payload.model_copy(update={"name": stock_name})

        audit_event = (
            UserEventCreate(
                type="journal_created",
                code=effective_payload.code,
                meta={"action": effective_payload.action.value},
            )
            if self._record_audit_event
            else None
        )
        return await self._repository.create(user_id, effective_payload, audit_event=audit_event)

    async def remove(self, user_id: UUID, entry_id: int) -> None:
        if not await self._repository.remove(user_id, entry_id):
            raise JournalEntryNotFoundError(entry_id)


__all__ = ["JournalEntryNotFoundError", "JournalService"]
