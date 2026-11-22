from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DatabaseUnavailableError, MarketServiceDep
from app.domain.models import MarketOverview
from app.services.market import MarketSnapshotUnavailableError

router = APIRouter(tags=["market"])


@router.get("/market/overview", response_model=MarketOverview)
async def market_overview(service: MarketServiceDep) -> MarketOverview:
    try:
        return await service.overview()
    except MarketSnapshotUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
