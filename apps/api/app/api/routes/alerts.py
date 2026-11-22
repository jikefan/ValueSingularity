from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import AlertServiceDep, CurrentUserDep, DatabaseUnavailableError
from app.domain.models import (
    AlertDeliveryItem,
    AlertScanSummary,
    NotificationPreferences,
    NotificationPreferencesUpdate,
)
from app.services.alerts import NotificationConfigError

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertDeliveryItem])
async def list_alerts(
    user: CurrentUserDep,
    service: AlertServiceDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[AlertDeliveryItem]:
    try:
        return await service.list_alerts(user.id, limit=limit)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.post("/scan", response_model=AlertScanSummary)
async def scan_alerts(
    user: CurrentUserDep,
    service: AlertServiceDep,
) -> AlertScanSummary:
    try:
        return await service.scan_user(user.id)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.get("/preferences", response_model=NotificationPreferences)
async def get_alert_preferences(
    user: CurrentUserDep,
    service: AlertServiceDep,
) -> NotificationPreferences:
    try:
        return await service.get_preferences(user.id)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.put("/preferences", response_model=NotificationPreferences)
async def update_alert_preferences(
    payload: NotificationPreferencesUpdate,
    user: CurrentUserDep,
    service: AlertServiceDep,
) -> NotificationPreferences:
    try:
        return await service.update_preferences(user.id, payload)
    except NotificationConfigError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
