from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, status

from app.api.deps import CurrentUserDep, DatabaseUnavailableError, JournalServiceDep
from app.domain.models import JournalAction, JournalCreate, JournalEntryItem
from app.services.journal import JournalEntryNotFoundError

router = APIRouter(prefix="/journal", tags=["journal"])


@router.get("", response_model=list[JournalEntryItem])
async def list_journal(
    user: CurrentUserDep,
    service: JournalServiceDep,
    code: Annotated[str | None, Query(pattern=r"^[0-9]{6}$")] = None,
    action: Annotated[list[JournalAction] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[JournalEntryItem]:
    try:
        return await service.list(user.id, code=code, actions=action, limit=limit)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.post("", status_code=status.HTTP_201_CREATED, response_model=JournalEntryItem)
async def create_journal(
    payload: JournalCreate,
    user: CurrentUserDep,
    service: JournalServiceDep,
) -> JournalEntryItem:
    try:
        return await service.create(user.id, payload)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_journal(
    entry_id: Annotated[int, Path(ge=1, le=9_223_372_036_854_775_807)],
    user: CurrentUserDep,
    service: JournalServiceDep,
) -> None:
    try:
        await service.remove(user.id, entry_id)
    except JournalEntryNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"决策日记 #{entry_id} 不存在",
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
