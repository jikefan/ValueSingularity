from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import CurrentUserDep, WatchlistServiceDep
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
) -> WatchlistItem:
    return await service.upsert(user.id, payload)


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_watchlist(
    code: str,
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
