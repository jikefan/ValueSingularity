from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DatabaseUnavailableError, DbSessionDep, verify_db
from app.domain.models import Health

router = APIRouter(tags=["system"])


@router.get("/health", response_model=Health)
async def health() -> Health:
    """Liveness: the process answers at all."""
    return Health(status="ok", version="0.1.0")


@router.get("/health/db", response_model=Health)
async def health_db(session: DbSessionDep) -> Health:
    """Readiness: the database answers."""
    try:
        await verify_db(session)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
    return Health(status="ok", version="0.1.0")
