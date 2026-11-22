"""Offline per-stock synchronization service orchestrating feed, Parquet store, engines, and PG."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date

from app.domain.engines import build_stock_snapshot
from app.domain.errors import StockFactUnavailableError, StockNotFoundError
from app.domain.models import StockSyncSummary
from app.domain.ports import (
    StockFactFeedPort,
    StockFactStore,
    StockMetaRepository,
    StockSnapshotRepository,
)

logger = logging.getLogger("vs.stock_sync")


class StockSyncService:
    def __init__(
        self,
        *,
        feed: StockFactFeedPort,
        fact_store: StockFactStore,
        stock_meta_repo: StockMetaRepository,
        snapshot_repo: StockSnapshotRepository,
    ) -> None:
        self._feed = feed
        self._fact_store = fact_store
        self._stock_meta_repo = stock_meta_repo
        self._snapshot_repo = snapshot_repo

    async def sync_stock(self, code: str, *, as_of: date | None = None) -> StockSyncSummary:
        metas = await self._stock_meta_repo.list_by_codes([code])
        if not metas:
            raise StockNotFoundError(code)
        meta = metas[0]

        bundle = await self._feed.fetch_stock_bundle(code, as_of=as_of)
        # Build and validate full snapshot before mutating Parquet or PostgreSQL.
        snapshot = build_stock_snapshot(meta, bundle)

        await self._fact_store.write_stock_facts(bundle)
        await self._snapshot_repo.save_snapshot(snapshot)

        return StockSyncSummary(
            code=snapshot.code,
            as_of=snapshot.as_of,
            data_source=snapshot.data_source,
            daily_bars_count=len(bundle.daily_bars),
            annual_reports_count=len(bundle.annual_reports),
            ct_red_count=snapshot.financial_ct.red_count,
            ct_yellow_count=snapshot.financial_ct.yellow_count,
            implied_fcf_cagr_pct=snapshot.reverse_dcf.implied_fcf_cagr_pct,
        )

    async def sync_many(
        self,
        codes: Sequence[str],
        *,
        as_of: date | None = None,
        continue_on_error: bool = False,
    ) -> list[StockSyncSummary]:
        unique_codes = list(dict.fromkeys(codes))
        summaries: list[StockSyncSummary] = []
        for code in unique_codes:
            try:
                summaries.append(await self.sync_stock(code, as_of=as_of))
            except (StockNotFoundError, StockFactUnavailableError) as exc:
                if not continue_on_error:
                    raise
                logger.warning("跳过个股同步 (%s): %s", code, exc)
        return summaries


__all__ = ["StockFactUnavailableError", "StockNotFoundError", "StockSyncService"]
