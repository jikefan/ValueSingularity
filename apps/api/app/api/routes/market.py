from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import MarketServiceDep
from app.domain.models import MarketOverview

router = APIRouter(tags=["market"])


@router.get("/market/overview", response_model=MarketOverview)
async def market_overview(service: MarketServiceDep) -> MarketOverview:
    return await service.overview()
