from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, status

from app.api.deps import DatabaseUnavailableError, StockServiceDep, StockSyncCoordinatorDep
from app.domain.models import (
    ScreenerSortDir,
    ScreenerSortField,
    StockCompareItem,
    StockDetail,
    StockMetaRecord,
    StockScreenerResponse,
    StockSnapshotPayload,
)
from app.services.stock import SnapshotNotReadyError, StockNotFoundError
from app.services.stock_sync import StockFactUnavailableError

router = APIRouter(prefix="/stocks", tags=["stocks"])

_COMPARE_CODE_RE = re.compile(r"^[0-9]{6}$", re.ASCII)


def _parse_compare_codes(raw_codes: str) -> list[str]:
    if "\x00" in raw_codes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="股票代码列表不能包含空字符",
        )
    parts = [part.strip() for part in raw_codes.split(",")]
    if not parts or any(not part for part in parts):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="股票代码列表格式无效，请使用逗号分隔的 6 位数字代码",
        )
    if len(parts) > 5:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="横向对比最多支持 5 个股票代码",
        )
    if any(not _COMPARE_CODE_RE.fullmatch(part) for part in parts):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="股票代码须为 6 位 ASCII 数字",
        )
    if len(set(parts)) != len(parts):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="横向对比不能包含重复股票代码",
        )
    return parts


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


@router.get("/compare", response_model=list[StockCompareItem])
async def compare_stocks(
    codes: Annotated[str, Query(min_length=1, max_length=128)],
    service: StockServiceDep,
) -> list[StockCompareItem]:
    parsed_codes = _parse_compare_codes(codes)
    try:
        return await service.compare(parsed_codes)
    except StockNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.get("/screener", response_model=StockScreenerResponse)
async def screen_stocks(
    service: StockServiceDep,
    zero_red_only: bool = False,
    max_pe_percentile: Annotated[float | None, Query(ge=0.0, le=100.0, allow_inf_nan=False)] = None,
    min_roe: Annotated[float | None, Query(ge=-1000.0, le=1000.0, allow_inf_nan=False)] = None,
    min_dividend_yield: Annotated[
        float | None, Query(ge=0.0, le=100.0, allow_inf_nan=False)
    ] = None,
    industry: Annotated[str | None, Query(max_length=64)] = None,
    q: Annotated[str | None, Query(max_length=64)] = None,
    sort_by: ScreenerSortField = "total_score",
    sort_dir: ScreenerSortDir = "desc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> StockScreenerResponse:
    if industry is not None and "\x00" in industry:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="行业筛选参数不能包含空字符",
        )
    if q is not None and "\x00" in q:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="搜索关键词不能包含空字符",
        )
    try:
        return await service.screener(
            zero_red_only=zero_red_only,
            max_pe_percentile=max_pe_percentile,
            min_roe=min_roe,
            min_dividend_yield=min_dividend_yield,
            industry=industry,
            query=q,
            sort_by=sort_by,
            sort_dir=sort_dir,
            limit=limit,
        )
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


@router.get("/{code}/snapshot", response_model=StockSnapshotPayload)
async def get_stock_snapshot(
    code: Annotated[str, Path(pattern=r"^[0-9]{6}$")],
    service: StockServiceDep,
) -> StockSnapshotPayload:
    try:
        return await service.snapshot(code)
    except (StockNotFoundError, SnapshotNotReadyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc


@router.post("/{code}/sync", response_model=StockSnapshotPayload)
async def sync_stock_snapshot(
    code: Annotated[str, Path(pattern=r"^[0-9]{6}$")],
    coordinator: StockSyncCoordinatorDep,
    force: bool = False,
) -> StockSnapshotPayload:
    try:
        return await coordinator.ensure_snapshot(code, force=force)
    except StockNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except StockFactUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"个股数据同步暂不可用，请稍后重试: {exc}",
        ) from exc
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"数据库不可用: {exc}",
        ) from exc
