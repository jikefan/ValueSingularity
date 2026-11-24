"""Stock service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

from collections.abc import Sequence

from app.domain.engines.screener import screen_snapshots
from app.domain.errors import SnapshotNotReadyError, StockNotFoundError
from app.domain.models import (
    ScreenerSortDir,
    ScreenerSortField,
    StockCompareItem,
    StockDetail,
    StockMetaRecord,
    StockScreenerResponse,
    StockSnapshotPayload,
)
from app.domain.ports import StockMetaRepository, StockSnapshotRepository


class StockService:
    def __init__(
        self,
        repository: StockMetaRepository,
        snapshot_repo: StockSnapshotRepository | None = None,
    ) -> None:
        self._repository = repository
        self._snapshot_repo = snapshot_repo

    async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
        return await self._repository.search(query, limit=limit)

    async def detail(self, code: str) -> StockDetail:
        item = await self._repository.get_detail(code)
        if item is None:
            raise StockNotFoundError(code)
        return item

    async def snapshot(self, code: str) -> StockSnapshotPayload:
        if self._snapshot_repo is not None:
            payload = await self._snapshot_repo.get_snapshot(code)
            if payload is not None:
                return payload

        detail = await self._repository.get_detail(code)
        if detail is None:
            raise StockNotFoundError(code)
        raise SnapshotNotReadyError(code)

    async def compare(self, codes: Sequence[str]) -> list[StockCompareItem]:
        ordered_codes = list(dict.fromkeys(codes))
        metas = await self._repository.list_by_codes(ordered_codes)
        meta_by_code = {item.code: item for item in metas}
        for code in ordered_codes:
            if code not in meta_by_code:
                raise StockNotFoundError(code)

        snapshots = (
            await self._snapshot_repo.get_snapshots_for_compare(ordered_codes)
            if self._snapshot_repo is not None
            else {}
        )
        items: list[StockCompareItem] = []
        for code in ordered_codes:
            snap = snapshots.get(code)
            items.append(
                StockCompareItem(
                    code=code,
                    meta=meta_by_code[code],
                    snapshot_available=snap is not None,
                    snapshot_as_of=snap.as_of if snap is not None else None,
                    metrics=snap.peer_metrics if snap is not None else None,
                )
            )
        return items

    async def screener(
        self,
        *,
        zero_red_only: bool = False,
        max_pe_percentile: float | None = None,
        min_roe: float | None = None,
        min_dividend_yield: float | None = None,
        industry: str | None = None,
        query: str | None = None,
        sort_by: ScreenerSortField = "total_score",
        sort_dir: ScreenerSortDir = "desc",
        limit: int = 50,
    ) -> StockScreenerResponse:
        snapshots = (
            await self._snapshot_repo.list_all_snapshots()
            if self._snapshot_repo is not None
            else []
        )
        return screen_snapshots(
            snapshots,
            zero_red_only=zero_red_only,
            max_pe_percentile=max_pe_percentile,
            min_roe=min_roe,
            min_dividend_yield=min_dividend_yield,
            industry=industry,
            query=query,
            sort_by=sort_by,
            sort_dir=sort_dir,
            limit=limit,
        )


__all__ = ["SnapshotNotReadyError", "StockNotFoundError", "StockService"]
