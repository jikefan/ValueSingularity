from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import WatchlistServiceDep
from app.domain.models import WatchlistItem, WatchlistUpsert
from app.services.watchlist import WatchlistNotFoundError

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


@router.get("", response_model=list[WatchlistItem])
async def list_watchlist(service: WatchlistServiceDep) -> list[WatchlistItem]:
    return await service.list()


@router.put("", response_model=WatchlistItem)
async def upsert_watchlist(payload: WatchlistUpsert, service: WatchlistServiceDep) -> WatchlistItem:
    return await service.upsert(payload)


@router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_watchlist(code: str, service: WatchlistServiceDep) -> None:
    try:
        await service.remove(code)
    except WatchlistNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{code} 不在自选里",
        ) from exc
