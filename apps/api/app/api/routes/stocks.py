from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, status

from app.api.deps import DatabaseUnavailableError, StockServiceDep
from app.domain.models import StockDetail, StockMetaRecord
from app.services.stock import StockNotFoundError

router = APIRouter(prefix="/stocks", tags=["stocks"])


@router.get("/search", response_model=list[StockMetaRecord])
async def search_stocks(
    q: Annotated[str, Query(min_length=1, max_length=64)],
    service: StockServiceDep,
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
) -> list[StockMetaRecord]:
    if "\x00" in q:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="搜索关键词不能包含空字符",
        )
    try:
        return await service.search(q, limit=limit)
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.get("/{code}", response_model=StockDetail)
async def get_stock(
    code: Annotated[str, Path(pattern=r"^[0-9]{6}$")],
    service: StockServiceDep,
) -> StockDetail:
    try:
        return await service.detail(code)
    except StockNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"未找到股票 {code}",
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
