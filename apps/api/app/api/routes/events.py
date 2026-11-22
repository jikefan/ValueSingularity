from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import CurrentUserDep, DatabaseUnavailableError, EventServiceDep
from app.domain.models import UserEventCreate, UserEventItem

router = APIRouter(prefix="/events", tags=["events"])


@router.get("", response_model=list[UserEventItem])
async def list_events(
    user: CurrentUserDep,
    service: EventServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[UserEventItem]:
    try:
        return await service.list(user.id, limit=limit)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.post("", status_code=status.HTTP_201_CREATED, response_model=UserEventItem)
async def record_event(
    payload: UserEventCreate,
    user: CurrentUserDep,
    service: EventServiceDep,
) -> UserEventItem:
    try:
        return await service.record(user.id, payload)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
