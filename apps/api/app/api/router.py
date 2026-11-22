from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import alerts, auth, events, health, journal, market, stocks, watchlist

api_router = APIRouter()
api_router.include_router(alerts.router)
api_router.include_router(auth.router)
api_router.include_router(events.router)
api_router.include_router(health.router)
api_router.include_router(journal.router)
api_router.include_router(market.router)
api_router.include_router(stocks.router)
api_router.include_router(watchlist.router)
