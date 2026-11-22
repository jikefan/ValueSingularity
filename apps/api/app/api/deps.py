"""Dependency wiring. One place decides which adapter backs each service."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.memory.market import MemoryMarketRepository
from app.adapters.postgres.watchlist import PostgresWatchlistRepository
from app.db.session import DatabaseUnavailableError, check_db_health, dispose_db, get_db
from app.services.market import MarketService
from app.services.watchlist import WatchlistService


@lru_cache
def get_market_service() -> MarketService:
    return MarketService(MemoryMarketRepository())


def get_watchlist_service(session: Annotated[AsyncSession, Depends(get_db)]) -> WatchlistService:
    return WatchlistService(PostgresWatchlistRepository(session))


MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]
WatchlistServiceDep = Annotated[WatchlistService, Depends(get_watchlist_service)]
DbSessionDep = Annotated[AsyncSession, Depends(get_db)]


async def verify_db(session: DbSessionDep) -> None:
    await check_db_health(session)


async def close_db_pool() -> None:
    await dispose_db()


__all__ = [
    "DatabaseUnavailableError",
    "DbSessionDep",
    "MarketServiceDep",
    "WatchlistServiceDep",
    "close_db_pool",
    "get_db",
    "get_market_service",
    "get_watchlist_service",
    "verify_db",
]
