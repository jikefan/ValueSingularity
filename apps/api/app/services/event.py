"""Event service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from uuid import UUID

from app.domain.models import UserEventCreate, UserEventItem
from app.domain.ports import EventRepository


class EventService:
    def __init__(self, repository: EventRepository) -> None:
        self._repository = repository

    async def list(self, user_id: UUID, *, limit: int = 50) -> list[UserEventItem]:
        return await self._repository.list(user_id, limit=limit)

    async def record(self, user_id: UUID, payload: UserEventCreate) -> UserEventItem:
        return await self._repository.record(user_id, payload)


__all__ = ["EventService"]
