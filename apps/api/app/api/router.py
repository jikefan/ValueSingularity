from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import health, market

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(market.router)
