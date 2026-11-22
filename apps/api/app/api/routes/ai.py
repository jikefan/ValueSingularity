from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import AiPartnerServiceDep, CurrentUserDep, DatabaseUnavailableError
from app.domain.errors import AiConfigError, AiQuotaExceededError, StockNotFoundError
from app.domain.models import (
    AiPreferences,
    AiPreferencesUpdate,
    DevilsAdvocateRequest,
    DevilsAdvocateResponse,
    MdaDiffRequest,
    MdaDiffResponse,
)

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/devils-advocate", response_model=DevilsAdvocateResponse)
async def run_devils_advocate(
    payload: DevilsAdvocateRequest,
    user: CurrentUserDep,
    service: AiPartnerServiceDep,
) -> DevilsAdvocateResponse:
    try:
        return await service.run_devils_advocate(user, payload)
    except StockNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except AiQuotaExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.post("/mda-diff", response_model=MdaDiffResponse)
async def run_mda_diff(
    payload: MdaDiffRequest,
    user: CurrentUserDep,
    service: AiPartnerServiceDep,
) -> MdaDiffResponse:
    try:
        return await service.run_mda_diff(user, payload)
    except StockNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except AiQuotaExceededError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.get("/preferences", response_model=AiPreferences)
async def get_ai_preferences(
    user: CurrentUserDep,
    service: AiPartnerServiceDep,
) -> AiPreferences:
    try:
        return await service.get_preferences(user)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.put("/preferences", response_model=AiPreferences)
async def update_ai_preferences(
    payload: AiPreferencesUpdate,
    user: CurrentUserDep,
    service: AiPartnerServiceDep,
) -> AiPreferences:
    try:
        return await service.update_preferences(user, payload)
    except AiConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
