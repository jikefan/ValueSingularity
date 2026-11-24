from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, status

from app.api.deps import (
    CurrentUserDep,
    DatabaseUnavailableError,
    WatchlistServiceDep,
    WatchlistWarmupDep,
)
from app.domain.models import WatchlistItem, WatchlistUpsert
from app.services.watchlist import WatchlistNotFoundError

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


@router.get("", response_model=list[WatchlistItem])
async def list_watchlist(user: CurrentUserDep, service: WatchlistServiceDep) -> list[WatchlistItem]:
    return await service.list(user.id)


@router.put("", response_model=WatchlistItem)
async def upsert_watchlist(
    payload: WatchlistUpsert,
    user: CurrentUserDep,
    service: WatchlistServiceDep,
    warmup: WatchlistWarmupDep,
) -> WatchlistItem:
    item = await service.upsert(user.id, payload)
    await warmup(payload.code)
    return item


@router.post("", response_model=WatchlistItem)
async def add_watchlist(
    payload: WatchlistUpsert,
    user: CurrentUserDep,
    service: WatchlistServiceDep,
    warmup: WatchlistWarmupDep,
) -> WatchlistItem:
    try:
        item = await service.add_if_absent(user.id, payload)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
    await warmup(payload.code)
    return item


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_watchlist(
    code: Annotated[str, Path(pattern=r"^[0-9]{6}$")],
    user: CurrentUserDep,
    service: WatchlistServiceDep,
) -> None:
    try:
        await service.remove(user.id, code)
    except WatchlistNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{code} 不在自选里",
        ) from exc
