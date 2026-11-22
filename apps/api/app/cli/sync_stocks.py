"""Idempotent per-stock synchronization CLI (`python -m app.cli.sync_stocks`)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
from collections.abc import Sequence
from datetime import date

from app.adapters.akshare.stock_feed import AkshareStockFactFeed
from app.adapters.duckdb.stock_store import DuckDBStockFactStore
from app.adapters.postgres.market import PostgresStockMetaRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.cli.scan_alerts import run_alert_scan
from app.db.session import AsyncSessionLocal, dispose_db
from app.domain.errors import StockFactUnavailableError, StockNotFoundError
from app.domain.models import AlertScanSummary, StockSyncSummary
from app.services.stock_sync import StockSyncService
from app.settings import settings

logger = logging.getLogger("vs.cli.sync_stocks")

_CODE_RE = re.compile(r"^[0-9]{6}$", re.ASCII)


def _parse_codes(raw_items: Sequence[str] | None) -> list[str]:
    if not raw_items:
        return []
    parsed: list[str] = []
    for item in raw_items:
        for part in item.split(","):
            cleaned = part.strip()
            if not cleaned:
                continue
            if not _CODE_RE.fullmatch(cleaned):
                raise ValueError(f"无效 6 位股票代码: {cleaned!r}")
            if cleaned not in parsed:
                parsed.append(cleaned)
    return parsed


async def _run_sync(
    *,
    codes: Sequence[str],
    use_watchlist: bool,
    limit: int | None,
    as_of: date | None,
    scan_alerts: bool = False,
) -> tuple[list[str], list[StockSyncSummary], AlertScanSummary | None]:
    try:
        async with AsyncSessionLocal() as session:
            meta_repo = PostgresStockMetaRepository(session)
            if codes:
                target_codes = list(codes[:limit] if limit is not None else codes)
            elif use_watchlist:
                target_codes = await meta_repo.list_watched_codes(limit=limit)
            else:
                target_codes = await meta_repo.list_active_codes(limit=limit or 50)

            if not target_codes:
                return [], [], None

            service = StockSyncService(
                feed=AkshareStockFactFeed(
                    timeout_seconds=settings.market_sync_timeout_seconds,
                    max_attempts=settings.market_sync_max_attempts,
                ),
                fact_store=DuckDBStockFactStore(settings.data_dir),
                stock_meta_repo=meta_repo,
                snapshot_repo=PostgresStockSnapshotRepository(session),
            )
            summaries = await service.sync_many(
                target_codes,
                as_of=as_of,
                continue_on_error=len(target_codes) > 1,
            )
            alert_summary: AlertScanSummary | None = None
            if scan_alerts and summaries:
                alert_summary = await run_alert_scan(session)
            return target_codes, summaries, alert_summary
    finally:
        await dispose_db()


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Synchronize per-stock facts and precomputed snapshots."
    )
    parser.add_argument(
        "--codes",
        nargs="+",
        default=None,
        help="Comma- or space-separated 6-digit stock codes.",
    )
    parser.add_argument(
        "--watchlist",
        action="store_true",
        help="Sync distinct stock codes present in user watchlists.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum number of stocks to sync.",
    )
    parser.add_argument(
        "--date",
        dest="as_of",
        default=None,
        help="Optional snapshot trade date in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--scan-alerts",
        action="store_true",
        help="Run sentinel alert radar across users after stock snapshots update.",
    )
    args = parser.parse_args(argv)

    if args.limit is not None and args.limit < 1:
        logger.error("无效参数 --limit=%d: 必须 >= 1", args.limit)
        return 2

    try:
        parsed_codes = _parse_codes(args.codes)
    except ValueError as exc:
        logger.error("参数 --codes 无效: %s", exc)
        return 2

    target_date: date | None = None
    if args.as_of is not None:
        try:
            target_date = date.fromisoformat(args.as_of)
        except ValueError as exc:
            logger.error("无效日期参数 --date=%s: %s", args.as_of, exc)
            return 2

    try:
        target_codes, summaries, alert_summary = asyncio.run(
            _run_sync(
                codes=parsed_codes,
                use_watchlist=args.watchlist,
                limit=args.limit,
                as_of=target_date,
                scan_alerts=args.scan_alerts,
            )
        )
    except (StockNotFoundError, StockFactUnavailableError) as exc:
        logger.error("个股同步失败（保留现有快照不变）: %s", exc)
        return 1
    except Exception:
        logger.exception("个股同步异常退出（保留现有快照不变）")
        return 1

    if not target_codes:
        logger.info("没有需要同步的股票代码。")
        return 0

    if not summaries:
        logger.error("所有目标股票（共 %d 只）同步均失败。", len(target_codes))
        return 1

    for summary in summaries:
        implied_text = (
            f"{summary.implied_fcf_cagr_pct:.2f}%"
            if summary.implied_fcf_cagr_pct is not None
            else "N/A"
        )
        logger.info(
            "个股同步完成: code=%s as_of=%s source=%s bars=%d reports=%d ct=(R%d/Y%d) dcf=%s",
            summary.code,
            summary.as_of.isoformat(),
            summary.data_source,
            summary.daily_bars_count,
            summary.annual_reports_count,
            summary.ct_red_count,
            summary.ct_yellow_count,
            implied_text,
        )
    if alert_summary is not None:
        logger.info(
            "盘后哨兵扫描完成: users=%d rules=%d matched=%d new=%d sent=%d failed=%d",
            alert_summary.users_scanned,
            alert_summary.evaluated_rules,
            alert_summary.matched_count,
            alert_summary.newly_triggered_count,
            alert_summary.webhook_sent_count,
            alert_summary.webhook_failed_count,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
