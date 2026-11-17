"""Dependency wiring. One place decides which adapter backs each service."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends

from app.adapters.memory.market import MemoryMarketRepository
from app.services.market import MarketService


@lru_cache
def get_market_service() -> MarketService:
    return MarketService(MemoryMarketRepository())


MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]
