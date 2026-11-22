"""Idempotent post-close market synchronization CLI (`python -m app.cli.sync`)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Sequence
from datetime import date

from app.adapters.akshare.market_feed import AkshareMarketFeed
from app.adapters.duckdb.market_store import DuckDBMarketFactStore
from app.adapters.postgres.market import PostgresMarketRepository, PostgresStockMetaRepository
from app.db.session import AsyncSessionLocal, dispose_db
from app.domain.errors import MarketFeedUnavailableError
from app.domain.models import SyncSummary
from app.services.market_sync import MarketSyncService
from app.settings import settings

logger = logging.getLogger("vs.cli.sync")


async def _run_sync(as_of: date | None) -> SyncSummary:
    try:
        async with AsyncSessionLocal() as session:
            service = MarketSyncService(
                feed=AkshareMarketFeed(
                    timeout_seconds=settings.market_sync_timeout_seconds,
                    max_attempts=settings.market_sync_max_attempts,
                ),
                fact_store=DuckDBMarketFactStore(settings.data_dir),
                stock_meta_repo=PostgresStockMetaRepository(session),
                market_repo=PostgresMarketRepository(session),
            )
            return await service.sync(as_of=as_of)
    finally:
        await dispose_db()


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description="Synchronize A-share market facts and snapshots.")
    parser.add_argument(
        "--date",
        dest="as_of",
        default=None,
        help="Optional snapshot trade date in YYYY-MM-DD format.",
    )
    args = parser.parse_args(argv)

    target_date: date | None = None
    if args.as_of is not None:
        try:
            target_date = date.fromisoformat(args.as_of)
        except ValueError as exc:
            logger.error("无效日期参数 --date=%s: %s", args.as_of, exc)
            return 2

    try:
        summary = asyncio.run(_run_sync(target_date))
    except MarketFeedUnavailableError as exc:
        logger.error("行情同步失败（保留现有快照不变）: %s", exc)
        return 1
    except Exception:
        logger.exception("行情同步异常退出（保留现有快照不变）")
        return 1

    logger.info(
        "行情同步完成: as_of=%s source=%s stocks=%d calendar=%d indices=%d macro=%d temp=%.1f(%s)",
        summary.as_of.isoformat(),
        summary.data_source,
        summary.stock_count,
        summary.trade_calendar_count,
        summary.index_daily_count,
        summary.macro_rate_count,
        summary.temperature_score,
        summary.temperature_level.value,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
