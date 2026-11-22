"""Offline market synchronization service orchestrating feed, Parquet store, math, and PG."""

from __future__ import annotations

from datetime import date

from app.domain.market_math import build_market_overview
from app.domain.models import SyncSummary
from app.domain.ports import (
    MarketFactStore,
    MarketFeedPort,
    MarketRepository,
    StockMetaRepository,
)


class MarketSyncService:
    def __init__(
        self,
        *,
        feed: MarketFeedPort,
        fact_store: MarketFactStore,
        stock_meta_repo: StockMetaRepository,
        market_repo: MarketRepository,
    ) -> None:
        self._feed = feed
        self._fact_store = fact_store
        self._stock_meta_repo = stock_meta_repo
        self._market_repo = market_repo

    async def sync(self, as_of: date | None = None) -> SyncSummary:
        # Fetch upstream bundle first so feed failures leave existing Parquet & PG snapshots intact.
        bundle = await self._feed.fetch_market_bundle(as_of=as_of)
        await self._fact_store.write_meta_facts(
            stock_list=bundle.stock_list,
            trade_calendar=bundle.trade_calendar,
            index_daily=bundle.index_daily,
            macro_rates=bundle.macro_rates,
        )
        macro_history = await self._fact_store.load_macro_history(bundle.as_of, lookback_years=10)
        overview = build_market_overview(bundle, macro_history)
        stock_count = await self._stock_meta_repo.upsert_many(bundle.stock_list)
        await self._market_repo.save_overview(overview)

        return SyncSummary(
            as_of=overview.as_of,
            data_source=overview.data_source,
            stock_count=stock_count,
            trade_calendar_count=len(bundle.trade_calendar),
            index_daily_count=len(bundle.index_daily),
            macro_rate_count=len(macro_history),
            temperature_score=overview.temperature.score,
            temperature_level=overview.temperature.level,
        )
