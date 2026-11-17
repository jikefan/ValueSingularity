from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import MarketServiceDep
from app.domain.models import MarketOverview

router = APIRouter(tags=["market"])


@router.get("/market/overview", response_model=MarketOverview)
def market_overview(service: MarketServiceDep) -> MarketOverview:
    return service.overview()
