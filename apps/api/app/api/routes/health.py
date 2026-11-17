from __future__ import annotations

from fastapi import APIRouter

from app.domain.models import Health

router = APIRouter(tags=["system"])


@router.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", version="0.1.0")
