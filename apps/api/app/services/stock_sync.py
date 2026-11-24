"""Per-stock synchronization service and single-flight on-demand coordinator."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from datetime import date

from app.domain.engines import build_stock_snapshot
from app.domain.errors import StockFactUnavailableError, StockNotFoundError
from app.domain.models import (
    StockFactBundle,
    StockMetaRecord,
    StockSnapshotPayload,
    StockSyncSummary,
)
from app.domain.ports import (
    StockFactFeedPort,
    StockFactStore,
    StockMetaRepository,
    StockSnapshotRepository,
    StockSnapshotSyncRunnerPort,
)

logger = logging.getLogger("vs.stock_sync")


def _enrich_meta_from_bundle(
    meta: StockMetaRecord, bundle: StockFactBundle
) -> tuple[StockMetaRecord, bool]:
    meta_updates: dict[str, object] = {}
    if bundle.profile_industry_sw1 is not None and bundle.profile_industry_sw1 != meta.industry_sw1:
        meta_updates["industry_sw1"] = bundle.profile_industry_sw1
    if bundle.profile_industry_sw2 is not None and bundle.profile_industry_sw2 != meta.industry_sw2:
        meta_updates["industry_sw2"] = bundle.profile_industry_sw2
    if bundle.profile_list_date is not None and bundle.profile_list_date != meta.list_date:
        meta_updates["list_date"] = bundle.profile_list_date
    if not meta_updates:
        return meta, False
    return meta.model_copy(update=meta_updates), True


def _to_sync_summary(snapshot: StockSnapshotPayload, bundle: StockFactBundle) -> StockSyncSummary:
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
        enriched_meta, meta_changed = _enrich_meta_from_bundle(meta, bundle)

        # Build and validate full snapshot before mutating Parquet or PostgreSQL.
        snapshot = build_stock_snapshot(enriched_meta, bundle)

        await self._fact_store.write_stock_facts(bundle)
        if meta_changed:
            await self._stock_meta_repo.upsert_many([enriched_meta], deactivate_missing=False)
        await self._snapshot_repo.save_snapshot(snapshot)

        return _to_sync_summary(snapshot, bundle)

    async def sync_many(
        self,
        codes: Sequence[str],
        *,
        as_of: date | None = None,
        continue_on_error: bool = False,
        delay_seconds: float = 0.0,
        batch_size: int = 1,
    ) -> list[StockSyncSummary]:
        unique_codes = list(dict.fromkeys(codes))
        delay = max(0.0, delay_seconds)
        effective_batch = max(1, batch_size)
        summaries: list[StockSyncSummary] = []

        if effective_batch == 1:
            for idx, code in enumerate(unique_codes):
                if idx > 0 and delay > 0:
                    await asyncio.sleep(delay)
                try:
                    summaries.append(await self.sync_stock(code, as_of=as_of))
                except (StockNotFoundError, StockFactUnavailableError) as exc:
                    if not continue_on_error:
                        raise
                    logger.warning("跳过个股同步 (%s): %s", code, exc)
            return summaries

        processed = 0
        for offset in range(0, len(unique_codes), effective_batch):
            chunk = unique_codes[offset : offset + effective_batch]
            metas_by_code = {
                item.code: item for item in await self._stock_meta_repo.list_by_codes(chunk)
            }
            bundles_to_write: list[StockFactBundle] = []
            metas_to_update: list[StockMetaRecord] = []
            snapshots_to_save: list[StockSnapshotPayload] = []
            chunk_summaries: list[StockSyncSummary] = []

            for code in chunk:
                if processed > 0 and delay > 0:
                    await asyncio.sleep(delay)
                processed += 1
                try:
                    meta = metas_by_code.get(code)
                    if meta is None:
                        raise StockNotFoundError(code)
                    bundle = await self._feed.fetch_stock_bundle(code, as_of=as_of)
                    enriched_meta, meta_changed = _enrich_meta_from_bundle(meta, bundle)
                    snapshot = build_stock_snapshot(enriched_meta, bundle)
                except (StockNotFoundError, StockFactUnavailableError) as exc:
                    if not continue_on_error:
                        raise
                    logger.warning("跳过个股同步 (%s): %s", code, exc)
                    continue

                bundles_to_write.append(bundle)
                if meta_changed:
                    metas_to_update.append(enriched_meta)
                snapshots_to_save.append(snapshot)
                chunk_summaries.append(_to_sync_summary(snapshot, bundle))

            if not bundles_to_write:
                continue

            await self._fact_store.write_stocks_facts_batch(bundles_to_write)
            if metas_to_update:
                await self._stock_meta_repo.upsert_many(metas_to_update, deactivate_missing=False)
            for snapshot in snapshots_to_save:
                await self._snapshot_repo.save_snapshot(snapshot)
            summaries.extend(chunk_summaries)

        return summaries


class StockSnapshotCoordinator:
    """Deduplicate concurrent snapshot syncs per (code, force) and bound feed concurrency."""

    def __init__(
        self,
        runner: StockSnapshotSyncRunnerPort,
        *,
        max_concurrency: int = 2,
    ) -> None:
        self._runner = runner
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self._inflight: dict[tuple[str, bool], asyncio.Task[StockSnapshotPayload]] = {}

    async def _execute(self, code: str, *, force: bool) -> StockSnapshotPayload:
        async with self._semaphore:
            return await self._runner.load_or_sync_snapshot(code, force=force)

    async def ensure_snapshot(self, code: str, *, force: bool = False) -> StockSnapshotPayload:
        key = (code, force)
        task = self._inflight.get(key)
        if task is None or task.done():
            task = asyncio.create_task(
                self._execute(code, force=force),
                name=f"stock-snapshot-sync-{code}-force={force}",
            )
            self._inflight[key] = task

            def _cleanup(done_task: asyncio.Task[StockSnapshotPayload]) -> None:
                if self._inflight.get(key) is done_task:
                    self._inflight.pop(key, None)
                # Retrieve unawaited exceptions so disconnected callers never trigger loop warnings.
                if not done_task.cancelled():
                    done_task.exception()

            task.add_done_callback(_cleanup)

        return await asyncio.shield(task)


__all__ = [
    "StockFactUnavailableError",
    "StockNotFoundError",
    "StockSnapshotCoordinator",
    "StockSyncService",
]
